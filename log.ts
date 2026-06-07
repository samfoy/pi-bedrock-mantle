/**
 * Tiny leveled logger used by the proxy and extension entrypoint.
 *
 * Goals:
 *   - One place to filter noise via `BEDROCK_MANTLE_LOG=silent|error|warn|info|debug`
 *     (default: `info`).
 *   - Emit human-readable lines with a `[bedrock-mantle]` prefix so anyone
 *     tailing pi's stdout/stderr can grep for our output.
 *   - Encode key/value fields uniformly so structured ingestion is trivial:
 *       `[bedrock-mantle] level=debug kind=request id=… status=200 latency_ms=412`
 *   - Zero deps. Always writes to stderr so the logger never collides with
 *     application stdout (matters when pi consumers pipe stdout).
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<Exclude<LogLevel, "silent">, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function resolveLevel(): LogLevel {
  const raw = process.env.BEDROCK_MANTLE_LOG;
  if (!raw) return "info";
  const lower = raw.toLowerCase();
  if (lower === "silent" || lower === "off" || lower === "none") return "silent";
  if (lower === "error" || lower === "warn" || lower === "info" || lower === "debug") return lower;
  // Unknown values fall back to the default rather than throwing — logging
  // misconfiguration shouldn't crash the extension.
  return "info";
}

let currentLevel: LogLevel = resolveLevel();

/** Test/operator hook: override the active log level at runtime. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Returns the level currently in effect (after env resolution + any setLogLevel call). */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: Exclude<LogLevel, "silent">): boolean {
  if (currentLevel === "silent") return false;
  return LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel as Exclude<LogLevel, "silent">];
}

/** Format a primitive into a single key=value pair with minimal quoting. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    // Quote if it contains whitespace, equals, or quote chars; otherwise emit raw.
    if (/[\s="]/.test(value)) return JSON.stringify(value);
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Errors and objects: prefer the .message for errors, JSON for everything else.
  if (value instanceof Error) {
    const code = (value as NodeJS.ErrnoException).code;
    return JSON.stringify(code ? `${code}: ${value.message}` : value.message);
  }
  return JSON.stringify(value);
}

function formatLine(level: Exclude<LogLevel, "silent">, kind: string, fields: Record<string, unknown> | undefined): string {
  const parts: string[] = [`level=${level}`, `kind=${kind}`];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      parts.push(`${k}=${formatValue(v)}`);
    }
  }
  return `[bedrock-mantle] ${parts.join(" ")}`;
}

function emit(level: Exclude<LogLevel, "silent">, kind: string, fields?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  // Always to stderr — stdout is reserved for application output (pi's
  // streamed model responses go via a different path, but other tools that
  // wrap us may pipe stdout).
  process.stderr.write(formatLine(level, kind, fields) + "\n");
}

export const log = {
  error(kind: string, fields?: Record<string, unknown>): void { emit("error", kind, fields); },
  warn(kind: string, fields?: Record<string, unknown>): void { emit("warn", kind, fields); },
  info(kind: string, fields?: Record<string, unknown>): void { emit("info", kind, fields); },
  debug(kind: string, fields?: Record<string, unknown>): void { emit("debug", kind, fields); },
};

/** Allocate a short request id. Sufficient uniqueness for log correlation; not a security primitive. */
export function newRequestId(): string {
  // 9 random bytes → 12-char base64url. Plenty of entropy for in-memory correlation
  // without requiring node:crypto's heavier APIs at import time.
  const bytes = new Uint8Array(9);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Buffer.from(bytes).toString("base64url");
}
