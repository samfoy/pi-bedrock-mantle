/**
 * SigV4 signing core for bedrock-mantle.
 *
 * Two surfaces:
 *
 *   1. In-process: `signAndForward({ method, path, headers, body, region })`
 *      → Pure async function. Signs the request with SigV4, forwards to
 *        bedrock-mantle in the given region, returns a `Response`. No HTTP
 *        loopback, no port. This is the public library API for callers that
 *        want bedrock-mantle without the HTTP indirection.
 *
 *   2. HTTP loopback: `createSigningProxy(region, { port })`
 *      → A node http.Server that wraps signAndForward in an HTTP listener.
 *        Pi's existing OpenAI/Anthropic drivers consume this via baseUrl.
 *        Default `port: 0` binds an ephemeral port — each pi process owns
 *        its own, so credentials/state never leak across processes.
 *
 * Two regions are supported in production:
 *   - us-east-2 (CMH)  GPT-5.x + shared OpenAI-style models
 *   - us-east-1 (IAD)  Anthropic Claude
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";
import { log, newRequestId } from "./log.js";
import { maybeDetectEmptyCompletion } from "./empty-completion.js";
import { fetchWithEmptyRetry } from "./retry.js";

// ─── Port parsing (kept for backward compat with pinned env overrides) ──────

export function parsePortEnv(name: string, defaultPort: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultPort;

  // Empty string would coerce to 0, which is a valid ephemeral sentinel — but
  // an empty env value is almost certainly a config bug, so reject it loudly
  // rather than silently switching the user to ephemeral.
  if (raw === "") {
    throw new Error(
      `[bedrock-mantle] Invalid ${name}=${JSON.stringify(raw)}; expected an integer port from 0 to 65535 (0 = ephemeral). Unset the variable to use the default.`
    );
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(
      `[bedrock-mantle] Invalid ${name}=${JSON.stringify(raw)}; expected an integer port from 0 to 65535 (0 = ephemeral).`
    );
  }
  return value;
}

/**
 * Default desired port for the us-east-2 proxy.
 *
 * `0` means "bind an ephemeral port per pi process" (recommended). Set
 * `BEDROCK_MANTLE_PROXY_PORT_CMH=57893` to pin a fixed port if you have an
 * external consumer that needs a stable URL.
 */
export const PROXY_PORT_CMH = parsePortEnv("BEDROCK_MANTLE_PROXY_PORT_CMH", 0);

/**
 * Default desired port for the us-east-1 proxy.
 *
 * `0` means "bind an ephemeral port per pi process" (recommended). Set
 * `BEDROCK_MANTLE_PROXY_PORT_IAD=57891` to pin a fixed port.
 */
export const PROXY_PORT_IAD = parsePortEnv("BEDROCK_MANTLE_PROXY_PORT_IAD", 0);

// ─── Header filters ─────────────────────────────────────────────────────────

// Headers that must not be forwarded upstream (hop-by-hop + auth).
const DROP_REQUEST = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
  "authorization", "x-api-key", // replaced by SigV4
]);

// Headers that must not be forwarded back to the caller.
const DROP_RESPONSE = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection",
]);

// ─── SigV4 signer factory ────────────────────────────────────────────────────

/**
 * Build a fresh SignatureV4 signer that reads credentials from the current
 * process env on every call. The proxy may be long-lived across pi sessions
 * within a single process, and BEDROCK_MANTLE_AWS_PROFILE may differ per
 * extension. Resolving per-request means rotated credentials and env changes
 * take effect immediately without restarting the proxy.
 */
function makeSigner(region: string): SignatureV4 {
  const profile = process.env.BEDROCK_MANTLE_AWS_PROFILE;
  // Use fromIni when an explicit profile is set — fromNodeProviderChain reads
  // AWS_PROFILE from env which may be clobbered by other extensions
  // (e.g. pi-provider-claude-code sets AWS_PROFILE=claude-code-DO-NOT-DELETE).
  const credentials = profile
    ? fromIni({ profile })
    : fromNodeProviderChain();
  return new SignatureV4({
    credentials,
    service: "bedrock",
    region,
    sha256: Sha256,
  });
}

// ─── In-process surface: signAndForward ──────────────────────────────────────

export interface SignAndForwardInput {
  /** HTTP method. Defaults to "POST" if not set. */
  method?: string;
  /** Path on the bedrock-mantle host (e.g. "/openai/v1/responses"). */
  path: string;
  /**
   * Request headers from the caller. Hop-by-hop and auth headers are dropped;
   * `x-*` and `anthropic-*` headers are forwarded.
   */
  headers?: Record<string, string | undefined>;
  /** Request body. May be a Buffer, string, or undefined. */
  body?: Buffer | string;
  /** Bedrock region — currently "us-east-1" or "us-east-2". */
  region: string;
}

// ─── Image format normalisation ─────────────────────────────────────────────

/**
 * Pi's openai-responses driver serialises images returned by the `read` tool
 * as `{ type: "input_image", image_url: "data:<mime>;base64,<data>", detail: "auto" }`
 * (a plain data-URL string). Bedrock Mantle's Responses API rejects this with
 * HTTP 400 "Invalid or unsupported image format" — it expects the source-block
 * form `{ type: "input_image", source: { type: "base64", media_type: "...", data: "..." } }`.
 *
 * This function rewrites any `input_image` item whose `image_url` field is a
 * data-URL string into the source-block form. All other items pass through
 * unchanged.
 */
function normalisedBody(buf: Buffer, path: string): Buffer {
  // Only applies to openai/v1/responses — other paths (chat/completions,
  // anthropic/messages, health checks) don't carry input_image blocks.
  if (!/^\/openai\/v1\/responses(\?|$|\/)/.test(path)) return buf;
  if (buf.length === 0) return buf;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(buf.toString("utf-8")) as Record<string, unknown>;
  } catch {
    return buf; // not JSON — pass through unchanged
  }

  let dirty = false;

  function rewriteContent(content: unknown): unknown {
    if (!Array.isArray(content)) return content;
    return content.map((item: unknown) => {
      if (!item || typeof item !== "object") return item;
      const block = item as Record<string, unknown>;
      if (block.type !== "input_image") return block;
      const url = block.image_url;
      if (typeof url !== "string" || !url.startsWith("data:")) return block;

      // Parse data URL: data:<mediaType>[;base64],<data>
      const comma = url.indexOf(",");
      if (comma === -1) return block;
      const meta = url.slice(5, comma); // strip "data:"
      const b64 = url.slice(comma + 1);
      const mediaType = meta.endsWith(";base64") ? meta.slice(0, -7) : "application/octet-stream";

      dirty = true;
      const { image_url: _drop, ...rest } = block;
      void _drop;
      return {
        ...rest,
        source: { type: "base64", media_type: mediaType, data: b64 },
      };
    });
  }

  function rewriteInput(input: unknown): unknown {
    if (!Array.isArray(input)) return input;
    return input.map((item: unknown) => {
      if (!item || typeof item !== "object") return item;
      const msg = item as Record<string, unknown>;
      if (!Array.isArray(msg.content)) return msg;
      const newContent = rewriteContent(msg.content);
      if (newContent === msg.content) return msg;
      return { ...msg, content: newContent };
    });
  }

  const newInput = rewriteInput(parsed.input);
  if (!dirty) return buf;
  return Buffer.from(JSON.stringify({ ...parsed, input: newInput }), "utf-8");
}

/**
 * Sign and forward a single request to bedrock-mantle, returning the upstream
 * `Response` for the caller to consume (status, headers, streaming body).
 *
 * The returned `Response.body` is a `ReadableStream` — callers should read it
 * directly to preserve streaming preserves (no buffering for SSE responses).
 */
export async function signAndForward(input: SignAndForwardInput): Promise<Response> {
  const { method = "POST", path, headers = {}, body, region } = input;
  const host = `bedrock-mantle.${region}.api.aws`;
  const target = `https://${host}${path}`;

  // Normalise image blocks before signing: pi sends input_image with a data-URL
  // string in image_url; Bedrock Mantle requires the source-block form instead.
  const rawBuf = typeof body === "string"
    ? Buffer.from(body, "utf-8")
    : body ?? Buffer.alloc(0);
  const bodyBuf = normalisedBody(rawBuf, path);

  // Build the header set to sign. host + content-type are always present;
  // x-* / anthropic-* pass through verbatim.
  const headersToSign: Record<string, string> = {
    host,
    "content-type": (headers["content-type"] as string | undefined) ?? "application/json",
  };
  if (bodyBuf.length > 0) headersToSign["content-length"] = String(bodyBuf.length);

  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (
      typeof v === "string" &&
      !DROP_REQUEST.has(lower) &&
      (lower.startsWith("x-") || lower.startsWith("anthropic-"))
    ) {
      headersToSign[lower] = v;
    }
  }

  const signer = makeSigner(region);
  const signed = await signer.sign({
    method: method.toUpperCase(),
    protocol: "https:",
    hostname: host,
    path,
    headers: headersToSign,
    body: bodyBuf.toString("utf-8"),
  });

  return fetch(target, {
    method,
    headers: signed.headers as Record<string, string>,
    // Cast: Buffer extends Uint8Array which IS valid BodyInit at runtime, but
    // TypeScript's stricter Uint8Array<ArrayBufferLike> typing doesn't accept it.
    body: (bodyBuf.length > 0 ? bodyBuf : undefined) as BodyInit | undefined,
    // @ts-ignore — Node.js 18+ duplex for streaming bodies
    duplex: "half",
  });
}

// ─── HTTP wrapper ────────────────────────────────────────────────────────────

function waitForDrainOrClose(res: ServerResponse): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);

  return new Promise((resolve) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onDrain = () => { cleanup(); resolve(!res.destroyed); };
    const onClose = () => { cleanup(); resolve(false); };
    const onError = () => { cleanup(); resolve(false); };

    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

function makeHandler(region: string) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqId = newRequestId();
    const startedAt = Date.now();
    let bytesIn = 0;
    let bytesOut = 0;
    let upstreamStatus: number | undefined;
    let upstreamRequestId: string | undefined;

    try {
      // 1. Collect body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const bodyBuf = Buffer.concat(chunks);
      bytesIn = bodyBuf.length;

      // 2. Sign and forward via the in-process surface, with buffer-and-retry
      //    on empty completions for the openai-responses path. On by default;
      //    override globally with BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY
      //    (0=force off, 1=force on). A no-op pass-through for
      //    non-openai-responses paths.
      const { response: rawUpstream, attempts } = await fetchWithEmptyRetry(
        {
          method: req.method ?? "POST",
          path: req.url ?? "/",
          headers: req.headers as Record<string, string | undefined>,
          body: bodyBuf,
          region,
        },
        { requestId: reqId, region, path: req.url ?? "/" },
      );
      // 2a. Wrap with the empty-completion detector for openai-responses SSE.
      // No-ops for any other path/content-type, so this is safe to apply
      // unconditionally. dispose() must be called when the client stream
      // tears down so the tee'd upstream sees a propagated cancel.
      const detection = maybeDetectEmptyCompletion(rawUpstream, {
        requestId: reqId,
        region,
        path: req.url ?? "/",
        // Pass the raw request body so dumps can include the exact prompt
        // that triggered the empty response, for replay/forensics.
        requestBody: bodyBuf,
      });
      const upstream = detection.response;
      upstreamStatus = upstream.status;
      upstreamRequestId = upstream.headers.get("x-amzn-requestid")
        ?? upstream.headers.get("x-request-id")
        ?? undefined;

      // 3. Stream response back
      const responseHeaders: Record<string, string> = {};
      for (const [k, v] of upstream.headers.entries()) {
        if (!DROP_RESPONSE.has(k.toLowerCase())) responseHeaders[k] = v;
      }
      if (upstream.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
        responseHeaders["cache-control"] = "no-cache, no-transform";
        responseHeaders["x-accel-buffering"] = "no";
      }
      // Inject our request id so callers (pi, dashboards) can correlate logs.
      responseHeaders["x-bedrock-mantle-request-id"] = reqId;
      res.writeHead(upstream.status, responseHeaders);
      res.flushHeaders();

      if (upstream.body) {
        const reader = upstream.body.getReader();
        const cancelReader = () => {
          void reader.cancel().catch(() => {});
          // Tear down the empty-completion scanner so the tee'd upstream
          // can propagate cancel to the underlying source.
          detection.dispose();
        };
        res.once("close", cancelReader);
        res.once("error", cancelReader);
        try {
          while (!res.destroyed) {
            const { done, value } = await reader.read();
            if (done) break;
            bytesOut += value.byteLength;
            if (!res.write(Buffer.from(value)) && !(await waitForDrainOrClose(res))) break;
          }
        } finally {
          res.off("close", cancelReader);
          res.off("error", cancelReader);
          if (res.destroyed) {
            await reader.cancel().catch(() => {});
            detection.dispose();
          }
        }
      }
      if (!res.destroyed) res.end();

      // Per-request log line. `info` for non-2xx so operators see the failure
      // pattern in the default log level; `debug` for the success path so we
      // don't drown logs in noise.
      const isError = upstream.status >= 400;
      (isError ? log.warn : log.debug)("request", {
        id: reqId,
        region,
        method: req.method,
        path: req.url,
        status: upstream.status,
        latency_ms: Date.now() - startedAt,
        bytes_in: bytesIn,
        bytes_out: bytesOut,
        upstream_request_id: upstreamRequestId,
        attempts,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("request_failed", {
        id: reqId,
        region,
        method: req.method,
        path: req.url,
        latency_ms: Date.now() - startedAt,
        bytes_in: bytesIn,
        upstream_status: upstreamStatus,
        error: err instanceof Error ? err : String(err),
      });
      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type": "application/json",
          "x-bedrock-mantle-request-id": reqId,
        });
      }
      res.end(JSON.stringify({
        error: {
          message: `bedrock-mantle proxy (${region}): ${msg}`,
          type: "proxy_error",
          request_id: reqId,
        },
      }));
    }
  };
}

export interface SigningProxy {
  /** The actual bound port (resolved from the OS when desiredPort=0). */
  readonly port: number;
  /** The underlying http.Server — used by tests and lifecycle hooks. */
  readonly server: Server;
  /** Tear down the listener. Returns once the socket is closed. */
  close(): Promise<void>;
}

/**
 * Bind a SigV4 signing proxy for the given region.
 *
 * @param region - Bedrock region, e.g. "us-east-2".
 * @param desiredPort - Port to bind. `0` (default) requests an ephemeral port
 *   from the OS, which is the recommended setting — each pi process owns its
 *   own listener with no cross-process state. Pass a fixed port only if an
 *   external consumer needs a stable URL.
 */
export function createSigningProxy(region: string, desiredPort = 0): Promise<SigningProxy> {
  return new Promise((resolve, reject) => {
    const handler = makeHandler(region);
    const server = createServer((req, res) => { void handler(req, res); });
    server.on("connection", (socket) => socket.setNoDelay(true));
    // unref so the proxy doesn't keep node alive on its own.
    server.unref();
    server.listen(desiredPort, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : desiredPort;
      resolve({
        port,
        server,
        close: () => new Promise<void>((closeResolve, closeReject) => {
          server.close((err) => err ? closeReject(err) : closeResolve());
        }),
      });
    });
    server.on("error", reject);
  });
}

/**
 * @deprecated Use `createSigningProxy(region, port)` which returns the actual
 * bound port. Retained for backward compatibility with the existing public API
 * and tests.
 */
export function startProxy(port: number, region: string): Promise<void> {
  return createSigningProxy(region, port).then(() => undefined);
}
