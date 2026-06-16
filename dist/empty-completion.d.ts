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
export declare function maybeDetectEmptyCompletion(upstream: Response, ctx: EmptyCompletionContext): EmptyCompletionWrap;
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
export declare function inspectResponseCompleted(payload: unknown): EmptyCompletionVerdict;
