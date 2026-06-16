/**
 * Tiny leveled logger used by the proxy and extension entrypoint.
 *
 * Goals:
 *   - One place to filter noise via `BEDROCK_MANTLE_LOG=silent|error|warn|info|debug`
 *     (default: `info`).
 *   - Emit human-readable lines with a `[bedrock-mantle]` prefix so anyone
 *     tailing pi's stdout/stderr can grep for our output.
 *   - Optionally mirror every emitted line to a file via
 *     `BEDROCK_MANTLE_LOG_FILE=/path/to/log` — durable capture that survives
 *     even when pi runs over RPC (where stderr is consumed by a parent and
 *     never hits disk). Honors the same level filter as stderr.
 *   - Encode key/value fields uniformly so structured ingestion is trivial:
 *       `[bedrock-mantle] level=debug kind=request id=… status=200 latency_ms=412`
 *   - Zero deps. Always writes to stderr so the logger never collides with
 *     application stdout (matters when pi consumers pipe stdout).
 */
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
/** Test/operator hook: override the active log level at runtime. */
export declare function setLogLevel(level: LogLevel): void;
/** Returns the level currently in effect (after env resolution + any setLogLevel call). */
export declare function getLogLevel(): LogLevel;
/**
 * Test/operator hook: override the log file path at runtime. Pass a path to
 * enable the file sink, or `undefined` to disable it. Resets the disabled
 * state and short-circuits env resolution.
 */
export declare function setLogFile(path: string | undefined): void;
export declare const log: {
    error(kind: string, fields?: Record<string, unknown>): void;
    warn(kind: string, fields?: Record<string, unknown>): void;
    info(kind: string, fields?: Record<string, unknown>): void;
    debug(kind: string, fields?: Record<string, unknown>): void;
};
/** Allocate a short request id. Sufficient uniqueness for log correlation; not a security primitive. */
export declare function newRequestId(): string;
