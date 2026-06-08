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

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

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
  const line = formatLine(level, kind, fields);
  // Always to stderr — stdout is reserved for application output (pi's
  // streamed model responses go via a different path, but other tools that
  // wrap us may pipe stdout).
  process.stderr.write(line + "\n");
  // Optionally mirror to a durable file (set BEDROCK_MANTLE_LOG_FILE). This is
  // the only capture that survives `pi --mode rpc`, where a parent consumes
  // stderr and it never reaches disk.
  writeToFileSink(line);
}

// ─── Optional file sink ──────────────────────────────────────────────────────

let fileSinkResolved = false;
let fileSinkPath: string | undefined;
let fileSinkDisabled = false;

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * Best-effort parent-directory creation for the sink path so the first append
 * doesn't ENOENT. Failure is non-fatal — the append try/catch disables the
 * sink gracefully if the path is truly unwritable.
 */
function ensureSinkDir(path: string): void {
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* ignore */ }
}

/**
 * Test/operator hook: override the log file path at runtime. Pass a path to
 * enable the file sink, or `undefined` to disable it. Resets the disabled
 * state and short-circuits env resolution.
 */
export function setLogFile(path: string | undefined): void {
  fileSinkPath = path ? expandHome(path) : undefined;
  fileSinkResolved = true;
  fileSinkDisabled = false;
  if (fileSinkPath) ensureSinkDir(fileSinkPath);
}

function resolveFileSink(): string | undefined {
  if (fileSinkResolved) return fileSinkPath;
  const raw = process.env.BEDROCK_MANTLE_LOG_FILE;
  fileSinkPath = raw && raw.trim() ? expandHome(raw.trim()) : undefined;
  fileSinkResolved = true;
  if (fileSinkPath) ensureSinkDir(fileSinkPath);
  return fileSinkPath;
}

function writeToFileSink(line: string): void {
  if (fileSinkDisabled) return;
  const path = resolveFileSink();
  if (!path) return;
  try {
    // Synchronous append: low-frequency proxy logs, and durability beats
    // throughput here (we want the line on disk before a crash/exit).
    appendFileSync(path, line + "\n");
  } catch (err) {
    // Disable after the first failure so we don't spam stderr or stall on
    // every subsequent line. Surface the reason once.
    fileSinkDisabled = true;
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[bedrock-mantle] level=warn kind=log_file_error path=${JSON.stringify(path)} error=${JSON.stringify(reason)}\n`,
    );
  }
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
