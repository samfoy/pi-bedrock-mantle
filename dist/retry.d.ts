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
import { type SignAndForwardInput } from "./proxy.js";
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
/** Test/operator hook: override the active retry mode. Accepts the legacy
 * boolean form (true → buffer retry on, false → off) or an explicit mode
 * string. Pass undefined to clear and fall back to env / default. */
export type RetryMode = "stream" | "buffer" | "off";
export declare function setRetryMode(mode: boolean | RetryMode | undefined): void;
/**
 * Resolve the active retry mode for openai-responses traffic.
 *
 * Precedence:
 *   1. setRetryMode() test/operator hook (wins outright)
 *   2. BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY env override
 *   3. default: "stream"  (retry, streaming-preserving)
 */
export declare function retryMode(): RetryMode;
/**
 * Sign + forward a single request, with optional buffer-and-retry on
 * empty-completion failures from gpt-5.x via openai-responses.
 *
 * When retry is not applicable (mode off, non-openai-responses path, or
 * non-SSE response), this is a simple pass-through to `signAndForward` and
 * returns `attempts: 1`.
 */
export declare function fetchWithEmptyRetry(input: SignAndForwardInput, ctx: RetryContext): Promise<RetryResult>;
/**
 * Streaming-preserving retry for openai-responses SSE.
 *
 * Holds back only the head events (response.created / in_progress / leading
 * reasoning). The instant the turn commits to actionable output, the held head
 * is flushed and the rest of the upstream streams through byte-for-byte —
 * preserving live token streaming. If the stream ends having produced nothing
 * actionable (empty completion) or a transient response.failed, and nothing
 * has been sent to the client yet, the identical request is re-issued once.
 *
 * Contrast with ``fetchWithEmptyRetry`` (buffer mode): that buffers the whole
 * SSE before forwarding, so pi sees a single burst. Buffer mode can retry a
 * transient failure that arrives AFTER a complete function_call; stream mode
 * cannot (those bytes are already sent). Empty completions produce no
 * actionable event, so they are always recoverable in stream mode.
 */
export declare function fetchWithStreamingRetry(input: SignAndForwardInput, ctx: RetryContext): Promise<RetryResult>;
