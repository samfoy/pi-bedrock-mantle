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
 *   2. We parse the buffered SSE for `response.completed` and apply the
 *      same `inspectResponseCompleted` verdict as the passive detector.
 *   3. If empty AND retry mode is on, re-sign and re-issue the same request
 *      once. Single retry — no infinite loop. Empirically takes the
 *      user-visible empty rate from ~10% to ~1%.
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
  if (!ct.includes("text/event-stream") || !first.body) {
    // Non-SSE responses (errors, plain JSON) flow through unchanged.
    return { response: first, attempts: 1 };
  }

  const buffered = await bufferResponse(first);
  const verdict1 = inspectBufferedSse(buffered.text);

  if (!verdict1.empty) {
    // Most common path: pass through the buffered bytes as a fresh Response.
    return { response: rebuildResponse(first, buffered.bytes), attempts: 1 };
  }

  // First attempt was empty. Log and retry once.
  log.warn("empty_completion_retry", {
    id: ctx.requestId,
    region: ctx.region,
    model: verdict1.model,
    attempt: 1,
    action: "retrying",
  });

  const second = await signAndForward(input);
  if (!second.body) {
    // Pathological: retry returned no body. Forward whatever we got.
    return { response: second, attempts: 2 };
  }
  const ct2 = (second.headers.get("content-type") ?? "").toLowerCase();
  if (!ct2.includes("text/event-stream")) {
    // Retry surface changed (error response). Forward as-is.
    return { response: second, attempts: 2 };
  }

  const buffered2 = await bufferResponse(second);
  const verdict2 = inspectBufferedSse(buffered2.text);

  if (verdict2.empty) {
    // Both attempts empty — accept defeat and forward the second response.
    // No infinite-retry loop; logging at warn so operators see double-empty
    // events and can tune model / effort.
    log.warn("empty_completion_retry", {
      id: ctx.requestId,
      region: ctx.region,
      model: verdict2.model,
      attempt: 2,
      outcome: "still_empty",
    });
  } else {
    log.info("empty_completion_retry", {
      id: ctx.requestId,
      region: ctx.region,
      model: verdict2.model,
      attempt: 2,
      outcome: "recovered",
    });
  }

  return { response: rebuildResponse(second, buffered2.bytes), attempts: 2 };
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
 * Scan a buffered SSE stream for a `response.completed` event and apply the
 * same empty-completion verdict logic as the passive detector.
 *
 * Inline rather than calling into empty-completion.ts because the retry path
 * has a fully-buffered string (not an in-flight ReadableStream), so we can
 * use a simpler synchronous parse.
 */
function inspectBufferedSse(text: string): EmptyCompletionVerdict & { found: boolean } {
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
    if (eventType !== "response.completed" || dataLines.length === 0) continue;

    const dataStr = dataLines.join("\n");
    if (dataStr === "[DONE]") continue;
    try {
      const parsed = JSON.parse(dataStr);
      return { ...inspectResponseCompleted(parsed), found: true };
    } catch {
      // Malformed event — ignore and keep scanning.
    }
  }
  return { empty: false, outputItemTypes: [], found: false };
}
