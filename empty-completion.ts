/**
 * Detect the gpt-5.5 / openai-responses "empty completion" failure mode.
 *
 * Symptom: the model runs tools, exhausts its output budget on hidden
 * reasoning, and emits zero visible message content with stop_reason="stop".
 * To pi (and any agent loop) this looks like a clean "I'm done" — except the
 * model said nothing. Sam first hit this 2026-06-06 in a dashboard session
 * with `openai.gpt-5.5`; the JSONL had `content: []`, `output_tokens: 0`,
 * `stopReason: stop` for an assistant turn that should have summarized
 * tool-call results.
 *
 * What we do here:
 *   - Tee the upstream SSE stream so the client gets the bytes unchanged.
 *   - Parse the `response.completed` event from the scanning copy.
 *   - When the final response has no message-text content AND zero output
 *     tokens, emit a `kind=empty_completion` warn line correlated to the
 *     request id. Pi (or operators reading the log) can see the failure
 *     immediately rather than wondering why the slot exited mid-turn.
 *
 * What we deliberately don't do:
 *   - Modify the response — silently rewriting the upstream's body would mask
 *     a real model behavior and break legitimate empty-message uses (rare,
 *     but possible). Detection is the contract; remediation is up to the
 *     consumer.
 *   - Buffer non-stream JSON responses — pi's openai-responses driver streams,
 *     so the SSE path covers production. A non-stream pass-through stays a
 *     pass-through; we just don't add detection there yet.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

/** Context carried into the detector so log lines correlate to the proxy request. */
export interface EmptyCompletionContext {
  requestId: string;
  region: string;
  path: string;
  /**
   * Optional: the original request body bytes. When `BEDROCK_MANTLE_EMPTY_DUMP_DIR`
   * is set, this is captured alongside the empty response so we can replay
   * the exact request that triggered the failure.
   */
  requestBody?: Buffer | string;
}

/**
 * Result of wrapping an upstream Response with empty-completion detection.
 */
export interface EmptyCompletionWrap {
  /** The (possibly teed) Response to forward to the client. */
  response: Response;
  /**
   * Tear down the background scanner. Call this when the client stream is
   * cancelled / errored so the tee'd upstream sees a propagated cancel and
   * doesn't leak. No-op for paths/content-types where no scan was started.
   */
  dispose(): void;
}

/**
 * If `upstream` is an SSE response on the openai-responses path, return a
 * `{ response, dispose }` pair whose response body is teed and scanned for
 * empty-completion events. The client-visible stream is byte-identical to
 * the original.
 *
 * For any other content-type or path, returns `{ response: upstream, dispose: noop }`.
 */
export function maybeDetectEmptyCompletion(
  upstream: Response,
  ctx: EmptyCompletionContext,
): EmptyCompletionWrap {
  const noop = () => {};
  if (!isOpenAIResponsesPath(ctx.path)) return { response: upstream, dispose: noop };
  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/event-stream")) return { response: upstream, dispose: noop };
  if (!upstream.body) return { response: upstream, dispose: noop };

  // tee() returns two independent ReadableStreams over the same source.
  const [clientStream, scanStream] = upstream.body.tee();
  const scanReader = scanStream.getReader();
  void scanSseForEmptyCompletion(scanReader, ctx);

  return {
    response: new Response(clientStream, {
      status: upstream.status,
      headers: upstream.headers,
      statusText: upstream.statusText,
    }),
    dispose: () => { void scanReader.cancel().catch(() => {}); },
  };
}

function isOpenAIResponsesPath(path: string): boolean {
  // Pi's openai-responses driver hits POST /openai/v1/responses (with optional
  // trailing query). Anything else (chat/completions, anthropic/messages,
  // health checks) is out of scope.
  return /^\/openai\/v1\/responses(\?|$|\/)/.test(path);
}

// ─── SSE parsing ─────────────────────────────────────────────────────────────

interface SseEvent {
  event: string | null;
  data: string;
}

/**
 * Minimal SSE parser sufficient for openai-responses events. Splits on the
 * blank-line event terminator, then parses `event:` and `data:` fields.
 * Multi-line `data:` chunks are concatenated with newlines per the SSE spec.
 *
 * Yielded events are not validated as JSON — that's the caller's job, since
 * not every event in this stream is JSON-encoded (some upstreams send
 * `data: [DONE]` style sentinels).
 */
function* parseSseEvents(buffer: string): Generator<SseEvent, string> {
  let cursor = 0;
  while (true) {
    // Find the end of the next event — a blank line separator.
    const sep = buffer.indexOf("\n\n", cursor);
    if (sep === -1) break;

    const block = buffer.slice(cursor, sep);
    cursor = sep + 2;

    let eventType: string | null = null;
    const dataLines: string[] = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith(":")) continue; // comment line
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0 && !eventType) continue;
    yield { event: eventType, data: dataLines.join("\n") };
  }
  return buffer.slice(cursor);
}

async function scanSseForEmptyCompletion(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ctx: EmptyCompletionContext,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Drain whatever complete events we can; the leftover (an in-flight
      // partial event) is reassigned for the next iteration.
      const gen = parseSseEvents(buffer);
      let next = gen.next();
      while (!next.done) {
        handleSseEvent(next.value, ctx);
        next = gen.next();
      }
      buffer = next.value;
    }
  } catch (err) {
    // Scanning failures must not propagate — the client's view of the response
    // is already disconnected from this stream. Cancellation is also surfaced
    // here as a benign failure when dispose() runs mid-read.
    log.debug("empty_completion_scan_error", {
      id: ctx.requestId,
      error: err instanceof Error ? err : String(err),
    });
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function handleSseEvent(event: SseEvent, ctx: EmptyCompletionContext): void {
  // We only care about the terminal event; ignore everything else.
  if (event.event !== "response.completed") return;
  if (!event.data || event.data === "[DONE]") return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    // Malformed event — log at debug so we can spot upstream contract drift,
    // but don't escalate.
    log.debug("empty_completion_parse_error", { id: ctx.requestId });
    return;
  }

  const verdict = inspectResponseCompleted(parsed);
  if (verdict.empty) {
    log.warn("empty_completion", {
      id: ctx.requestId,
      region: ctx.region,
      model: verdict.model,
      output_tokens: verdict.outputTokens,
      reasoning_tokens: verdict.reasoningTokens,
      output_item_types: verdict.outputItemTypes.join(","),
      stop_reason: verdict.status,
      hint: "model returned no message content after tool use; lower reasoning effort or raise max_output_tokens",
    });
    maybeDumpPayload(ctx, parsed);
  }
}

/**
 * When `BEDROCK_MANTLE_EMPTY_DUMP_DIR` is set, write the full parsed
 * response.completed payload to `<dir>/empty-<requestId>.json`. Used as a
 * forensic tap when we're chasing the root cause of empty completions.
 *
 * Failure to write is logged at debug — we never want diagnostic plumbing to
 * affect the user-visible response.
 */
function maybeDumpPayload(ctx: EmptyCompletionContext, payload: unknown): void {
  const dir = process.env.BEDROCK_MANTLE_EMPTY_DUMP_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `empty-${ctx.requestId}.json`);
    let requestPayload: unknown;
    if (ctx.requestBody !== undefined) {
      const bodyStr = typeof ctx.requestBody === "string"
        ? ctx.requestBody
        : ctx.requestBody.toString("utf-8");
      try {
        requestPayload = JSON.parse(bodyStr);
      } catch {
        requestPayload = bodyStr;
      }
    }
    writeFileSync(path, JSON.stringify({
      capturedAt: new Date().toISOString(),
      region: ctx.region,
      path: ctx.path,
      requestId: ctx.requestId,
      request: requestPayload,
      response: payload,
    }, null, 2));
    log.info("empty_completion_dump", { id: ctx.requestId, path });
  } catch (err) {
    log.debug("empty_completion_dump_failed", {
      id: ctx.requestId,
      error: err instanceof Error ? err : String(err),
    });
  }
}

// ─── Verdict logic (exported for tests) ──────────────────────────────────────

export interface EmptyCompletionVerdict {
  empty: boolean;
  model?: string;
  outputTokens?: number;
  reasoningTokens?: number;
  outputItemTypes: string[];
  status?: string;
}

/**
 * Inspect a parsed `response.completed` event payload and decide whether it
 * fits the empty-completion failure pattern.
 *
 * Pattern ("empty to the agent"):
 *   - status is `completed` (or absent), AND
 *   - the `output` array contains no `message` item with non-empty text, AND
 *   - it contains no tool/function call item (any `*_call` type).
 *
 * Token count is NOT part of the test: a turn that burns reasoning tokens but
 * emits zero actionable items is still empty from the agent's perspective.
 */
export function inspectResponseCompleted(payload: unknown): EmptyCompletionVerdict {
  const verdict: EmptyCompletionVerdict = { empty: false, outputItemTypes: [] };
  if (!payload || typeof payload !== "object") return verdict;
  const root = payload as Record<string, unknown>;
  const response = (root.response ?? root) as Record<string, unknown>;
  if (!response || typeof response !== "object") return verdict;

  verdict.model = typeof response.model === "string" ? response.model : undefined;
  verdict.status = typeof response.status === "string" ? response.status : undefined;

  const usage = response.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === "object") {
    const out = usage.output_tokens;
    if (typeof out === "number") verdict.outputTokens = out;
    const detail = usage.output_tokens_details as Record<string, unknown> | undefined;
    if (detail && typeof detail.reasoning_tokens === "number") {
      verdict.reasoningTokens = detail.reasoning_tokens;
    }
  }

  const output = response.output;
  let hasVisibleText = false;
  let hasToolCall = false;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const type = typeof it.type === "string" ? it.type : "unknown";
      verdict.outputItemTypes.push(type);
      if (type === "message" && hasNonEmptyTextContent(it.content)) {
        hasVisibleText = true;
      }
      // Any tool/function call item is actionable output. In the Responses
      // API these all end in `_call` (function_call, custom_tool_call,
      // computer_call, file_search_call, web_search_call, mcp_call, …), so
      // a suffix test is forward-compatible with new call types.
      // `mcp_approval_request` is also actionable (the agent must approve)
      // but doesn't end in `_call`, so it's matched explicitly.
      if (type.endsWith("_call") || type === "mcp_approval_request") {
        hasToolCall = true;
      }
    }
  }

  // "Empty to the agent" = the turn produced nothing actionable: no visible
  // message text AND no tool/function call. We deliberately do NOT gate on
  // output_tokens — gpt-5.5 has an idle variant that burns reasoning tokens
  // (output_tokens > 0) but emits zero actionable items, which a token-gated
  // check misses entirely (it leaves the agent loop with nothing to do, so
  // pi silently ends the turn). The status guard still excludes partial /
  // cancelled runs that legitimately ended mid-stream.
  //
  // Out of scope by design: a reasoning-exhaustion turn that lands as
  // status="incomplete" (e.g. max_output_tokens hit) is NOT flagged here —
  // that's a budget signal, not the stochastic gpt-5.5 idle bug.
  const completed = verdict.status === undefined || verdict.status === "completed";
  verdict.empty = !hasVisibleText && !hasToolCall && completed;
  return verdict;
}

function hasNonEmptyTextContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if ((b.type === "output_text" || b.type === "text") && typeof b.text === "string" && b.text.length > 0) {
      return true;
    }
    // A refusal is legitimate, visible model output — not an empty completion.
    // Without this a refusal-only message (no text, no tool call) would be
    // flagged empty and trigger a guaranteed-wasteful retry (refusals are
    // sticky, so the retry refuses again).
    if (b.type === "refusal" && typeof b.refusal === "string" && b.refusal.length > 0) {
      return true;
    }
  }
  return false;
}
