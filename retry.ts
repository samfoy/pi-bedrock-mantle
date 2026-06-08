/**
 * Optional empty-completion retry for `/openai/v1/responses`.
 *
 * Background: gpt-5.5 has a measured ~10–20% stochastic empty-completion rate
 * on tool-using requests via the OpenAI Responses API. The same exact request
 * (same bytes, same SigV4 signature) produces a `function_call` 80–90% of the
 * time and zero output items 10–20% of the time. See
 * `forensics-2026-06-07/findings.md`.
 *
 * This module wraps `signAndForward` with a buffer-and-retry layer:
 *
 *   1. First attempt streams as usual into a memory buffer.
 *   2. We parse the buffered SSE terminal event and decide whether to retry:
 *        - empty completion  (`response.completed` with no actionable output), or
 *        - transient failure (`response.failed` with a server-side error code
 *          like `server_error` — a 5xx surfaced as an SSE event mid-stream;
 *          observed on gpt-5.5 even after a complete function_call. See
 *          `forensics-2026-06-07/findings.md`).
 *   3. If retryable AND retry mode is on, re-sign and re-issue the same
 *      request once. Single retry — no infinite loop.
 *   4. The buffered (or retried-buffered) bytes are reconstructed into a
 *      Response that the caller streams to the client.
 *
 * Tradeoff: when retry mode is on, openai-responses traffic is buffered
 * end-to-end — pi sees the response arrive in one burst rather than
 * streamed. For tool-call-only first turns this is ~free (the response is
 * a single function_call and small). For long visible-text responses it
 * adds latency equal to the full response time. Acceptable for agent
 * flows.
 *
 * Scope: buffer-and-retry engages by default for ALL `/openai/v1/responses`
 * traffic (the gpt-5.x family is where the empty-completion bug is measured;
 * see `forensics-2026-06-07/findings.md`, but applying it everywhere on the
 * responses path is harmless — non-empty responses pass through after a
 * single attempt).
 *
 * Override with the env flag:
 *   - BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY=0  → force retry OFF (use for
 *     streaming-sensitive flows that accept the empty rate).
 *   - BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY=1  → explicitly force retry ON.
 *   - unset (default)                          → retry ON.
 */

import { inspectResponseCompleted, type EmptyCompletionVerdict } from "./empty-completion.js";
import { log } from "./log.js";
import { signAndForward, type SignAndForwardInput } from "./proxy.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RetryContext {
  requestId: string;
  region: string;
  path: string;
}

export interface RetryResult {
  /** The Response to forward to the client. May be live (no retry) or buffered. */
  response: Response;
  /** 1 if no retry was attempted (or retry mode off), 2 if a retry fired. */
  attempts: number;
}

/** Test/operator hook: override the active retry mode. Returns prior value. */
let retryOverride: boolean | undefined;
export function setRetryMode(enabled: boolean | undefined): void {
  retryOverride = enabled;
}

/**
 * Parse the env override into a tri-state:
 *   true  → force on
 *   false → force off
 *   undefined → no explicit override (fall back to default: on)
 */
function envRetryOverride(): boolean | undefined {
  const raw = process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY;
  if (raw === undefined || raw === "") return undefined;
  const lower = raw.toLowerCase();
  if (lower === "1" || lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return false;
  return undefined;
}

/**
 * Decide whether buffer-and-retry should engage for openai-responses traffic.
 *
 * Precedence:
 *   1. setRetryMode() test/operator hook (wins outright)
 *   2. BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY env override (on/off)
 *   3. default: on
 */
function retryEnabled(): boolean {
  if (retryOverride !== undefined) return retryOverride;
  const env = envRetryOverride();
  if (env !== undefined) return env;
  return true;
}

function isOpenAIResponsesPath(path: string): boolean {
  return /^\/openai\/v1\/responses(\?|$|\/)/.test(path);
}

/**
 * Sign + forward a single request, with optional buffer-and-retry on
 * empty-completion failures from gpt-5.x via openai-responses.
 *
 * When retry is not applicable (mode off, non-openai-responses path, or
 * non-SSE response), this is a simple pass-through to `signAndForward` and
 * returns `attempts: 1`.
 */
export async function fetchWithEmptyRetry(
  input: SignAndForwardInput,
  ctx: RetryContext,
): Promise<RetryResult> {
  if (!retryEnabled() || !isOpenAIResponsesPath(ctx.path)) {
    return { response: await signAndForward(input), attempts: 1 };
  }

  // First attempt
  const first = await signAndForward(input);
  const ct = (first.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("text/event-stream")) {
    // Streaming openai-responses requests should come back as SSE. A 200
    // non-SSE response is anomalous and a candidate empty-completion variant
    // (pi's driver expects a stream and sees nothing) — capture it for
    // forensics when a dump dir is configured. Errors (4xx/5xx) are expected
    // to be non-SSE and pass through untouched.
    if (first.status === 200 && first.body && process.env.BEDROCK_MANTLE_EMPTY_DUMP_DIR) {
      const buf = await bufferResponse(first);
      log.warn("empty_completion_non_sse", {
        id: ctx.requestId,
        region: ctx.region,
        status: 200,
        content_type: ct || "(none)",
        bytes: buf.bytes.byteLength,
        hint: "200 openai-responses reply was not text/event-stream",
      });
      maybeDumpBuffer(ctx, "non_sse", buf.bytes, input.body);
      return { response: rebuildResponse(first, buf.bytes), attempts: 1 };
    }
    // Non-SSE responses (errors, plain JSON) flow through unchanged.
    return { response: first, attempts: 1 };
  }
  if (!first.body) {
    return { response: first, attempts: 1 };
  }

  const buffered = await bufferResponse(first);
  const verdict1 = inspectBufferedSse(buffered.text);
  const reason1 = retryReason(verdict1);

  if (!reason1) {
    // Not retryable. Two sub-cases worth capturing for forensics:
    if (verdict1.failed) {
      // A terminal response.failed with a non-transient (client-side) error
      // code — retrying won't help, so pass it through, but record it.
      log.warn("upstream_failed", {
        id: ctx.requestId,
        region: ctx.region,
        model: verdict1.model,
        error_code: verdict1.errorCode,
        retryable: false,
      });
      maybeDumpBuffer(ctx, "failed", buffered.bytes, input.body);
    } else if (!verdict1.found) {
      // Stream closed with no parseable response.completed AND no
      // response.failed — genuinely anomalous. Capture but don't retry
      // blindly (could be a client cancel or partial).
      log.warn("empty_completion_no_terminal", {
        id: ctx.requestId,
        region: ctx.region,
        bytes: buffered.bytes.byteLength,
        hint: "no parseable response.completed or response.failed in buffered SSE",
      });
      maybeDumpBuffer(ctx, "no_terminal", buffered.bytes, input.body);
    }
    // Happy path (response.completed with output) and the captured cases all
    // pass the buffered bytes through unchanged.
    return { response: rebuildResponse(first, buffered.bytes), attempts: 1 };
  }

  // First attempt is retryable (empty completion, or a transient
  // response.failed). Log and retry once with the identical request.
  logRetryAttempt1(ctx, reason1, verdict1);

  const second = await signAndForward(input);
  if (!second.body) {
    // Pathological: retry returned no body. Forward whatever we got.
    return { response: second, attempts: 2 };
  }
  const ct2 = (second.headers.get("content-type") ?? "").toLowerCase();
  if (!ct2.includes("text/event-stream")) {
    // Retry surface changed (e.g. an HTTP error response). Forward as-is.
    return { response: second, attempts: 2 };
  }

  const buffered2 = await bufferResponse(second);
  const verdict2 = inspectBufferedSse(buffered2.text);

  // Log the outcome. No second retry — single bounded attempt, no loop.
  logRetryOutcome(ctx, reason1, verdict2);

  return { response: rebuildResponse(second, buffered2.bytes), attempts: 2 };
}

/**
 * Why a buffered first attempt should be retried, or null if it shouldn't.
 *   - "empty"  : the empty-completion verdict fired (no actionable output).
 *   - "failed" : a terminal response.failed with a transient error code.
 */
function retryReason(v: BufferedScan): "empty" | "failed" | null {
  if (v.empty) return "empty";
  if (v.failed && isRetryableFailure(v.errorCode)) return "failed";
  return null;
}

function logRetryAttempt1(ctx: RetryContext, reason: "empty" | "failed", v: BufferedScan): void {
  if (reason === "empty") {
    log.warn("empty_completion_retry", {
      id: ctx.requestId, region: ctx.region, model: v.model, attempt: 1, action: "retrying",
    });
  } else {
    log.warn("upstream_failed_retry", {
      id: ctx.requestId, region: ctx.region, model: v.model,
      error_code: v.errorCode, attempt: 1, action: "retrying",
    });
  }
}

function logRetryOutcome(
  ctx: RetryContext,
  reason1: "empty" | "failed",
  v2: BufferedScan,
): void {
  const kind = reason1 === "empty" ? "empty_completion_retry" : "upstream_failed_retry";
  // Genuine recovery = the retry produced a usable response.completed with
  // actionable output. Anything else (still empty, any failure — transient or
  // not — or no terminal event) is not a recovery.
  const recovered = v2.found && !v2.empty;
  if (recovered) {
    log.info(kind, { id: ctx.requestId, region: ctx.region, model: v2.model, attempt: 2, outcome: "recovered" });
  } else {
    const outcome = v2.empty ? "still_empty" : v2.failed ? "still_failed" : "still_no_terminal";
    log.warn(kind, {
      id: ctx.requestId, region: ctx.region, model: v2.model,
      error_code: v2.errorCode, attempt: 2, outcome,
    });
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

interface BufferedBody {
  bytes: Uint8Array;
  text: string;
}

async function bufferResponse(res: Response): Promise<BufferedBody> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, text: new TextDecoder().decode(bytes) };
}

function rebuildResponse(original: Response, bytes: Uint8Array): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  });
}

/**
 * When `BEDROCK_MANTLE_EMPTY_DUMP_DIR` is set, write the raw buffered response
 * bytes plus the originating request body to
 * `<dir>/<label>-<requestId>.json`. Used to capture empty-completion variants
 * (no-terminal SSE, non-SSE 200) that the passive detector / verdict logic
 * doesn't flag, so we can analyse the exact shape and extend handling.
 *
 * Failure to write is logged at debug — diagnostic plumbing must never affect
 * the user-visible response.
 */
function maybeDumpBuffer(
  ctx: RetryContext,
  label: string,
  bytes: Uint8Array,
  requestBody: Buffer | string | undefined,
): void {
  const dir = process.env.BEDROCK_MANTLE_EMPTY_DUMP_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${label}-${ctx.requestId}.json`);
    let request: unknown;
    if (requestBody !== undefined) {
      const bodyStr = typeof requestBody === "string" ? requestBody : requestBody.toString("utf-8");
      try { request = JSON.parse(bodyStr); } catch { request = bodyStr; }
    }
    writeFileSync(path, JSON.stringify({
      capturedAt: new Date().toISOString(),
      label,
      region: ctx.region,
      path: ctx.path,
      requestId: ctx.requestId,
      request,
      responseBytes: bytes.byteLength,
      responseText: new TextDecoder().decode(bytes),
    }, null, 2));
    log.info("empty_completion_dump", { id: ctx.requestId, path, label });
  } catch (err) {
    log.debug("empty_completion_dump_failed", {
      id: ctx.requestId,
      error: err instanceof Error ? err : String(err),
    });
  }
}

/**
 * Result of scanning a fully-buffered openai-responses SSE stream:
 *   - the empty-completion verdict (from a `response.completed` event),
 *   - `found`  : a `response.completed` event was parsed,
 *   - `failed` : a terminal `response.failed` event was parsed,
 *   - `errorCode` : the `error.code` from a `response.failed` event.
 */
type BufferedScan = EmptyCompletionVerdict & {
  found: boolean;
  failed: boolean;
  errorCode?: string;
};

/**
 * Transient `response.failed` error codes worth a single retry. gpt-5.x on
 * Bedrock intermittently ends a stream with `response.failed` carrying a
 * `server_error` (a 5xx surfaced as an SSE event rather than an HTTP status)
 * even after emitting a complete function_call — see
 * `forensics-2026-06-07/findings.md`. These are upstream instability, not a
 * client problem, so retrying the identical request usually succeeds.
 */
const RETRYABLE_FAILED_CODES = new Set([
  "server_error",
  "internal_error",
  "service_unavailable",
  "server_overloaded",
  "overloaded_error",
  "gateway_timeout",
  "bad_gateway",
  "timeout",
]);

/**
 * A `response.failed` is retryable when its error code is a known transient
 * server-side condition, or when no code is present (ambiguous — one retry is
 * low-harm). Client-side failures (invalid_request_error, content_filter, …)
 * are NOT in the set, so they pass through without a wasted retry.
 */
function isRetryableFailure(code: string | undefined): boolean {
  if (!code) return true;
  return RETRYABLE_FAILED_CODES.has(code.toLowerCase());
}

/**
 * Scan a buffered SSE stream for the terminal event. Returns the
 * empty-completion verdict when it's a `response.completed`, or a failure
 * marker when it's a `response.failed`.
 *
 * Inline rather than calling into empty-completion.ts because the retry path
 * has a fully-buffered string (not an in-flight ReadableStream), so we can
 * use a simpler synchronous parse.
 */
function inspectBufferedSse(text: string): BufferedScan {
  // SSE events are separated by blank lines (\n\n). Append one to ensure the
  // final event parses if upstream didn't write a trailing newline.
  const buffer = text.endsWith("\n\n") ? text : text + "\n\n";
  let cursor = 0;
  while (cursor < buffer.length) {
    const sep = buffer.indexOf("\n\n", cursor);
    if (sep === -1) break;
    const block = buffer.slice(cursor, sep);
    cursor = sep + 2;

    let eventType: string | null = null;
    const dataLines: string[] = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith(":")) continue; // SSE comment
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) continue;
    const dataStr = dataLines.join("\n");
    if (dataStr === "[DONE]") continue;

    if (eventType === "response.completed") {
      try {
        const parsed = JSON.parse(dataStr);
        return { ...inspectResponseCompleted(parsed), found: true, failed: false };
      } catch {
        // Malformed event — ignore and keep scanning.
      }
    } else if (eventType === "response.failed") {
      try {
        const parsed = JSON.parse(dataStr) as Record<string, unknown>;
        const resp = (parsed.response ?? parsed) as Record<string, unknown>;
        const err = resp.error as Record<string, unknown> | undefined;
        const code = err && typeof err.code === "string" ? err.code : undefined;
        const model = typeof resp.model === "string" ? resp.model : undefined;
        return { empty: false, outputItemTypes: [], found: false, failed: true, errorCode: code, model };
      } catch {
        // Malformed failed event — still a terminal failure, just no code.
        return { empty: false, outputItemTypes: [], found: false, failed: true };
      }
    }
  }
  return { empty: false, outputItemTypes: [], found: false, failed: false };
}
