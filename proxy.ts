/**
 * SigV4 signing proxy for bedrock-mantle.
 *
 * Parameterized by region so two instances can run simultaneously:
 *   - port 57893  us-east-2  (GPT-5.x + shared models via openai-responses)
 *   - port 57891  us-east-1  (Anthropic + shared models via anthropic-messages)
 *
 * The proxy is region-aware: signs each request with SigV4 for its assigned
 * region, then forwards verbatim to bedrock-mantle in that region. The caller
 * (pi via the provider config) is responsible for pointing each model at the
 * right proxy port.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

export function parsePortEnv(name: string, defaultPort: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultPort;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `[bedrock-mantle] Invalid ${name}=${JSON.stringify(raw)}; expected an integer port from 1 to 65535.`
    );
  }
  return value;
}

/** Port for the us-east-2 proxy (GPT-5.x and shared OpenAI-style models). Override with BEDROCK_MANTLE_PROXY_PORT_CMH. */
export const PROXY_PORT_CMH = parsePortEnv("BEDROCK_MANTLE_PROXY_PORT_CMH", 57893);

/** Port for the us-east-1 proxy (Anthropic models via anthropic-messages API). Override with BEDROCK_MANTLE_PROXY_PORT_IAD. */
export const PROXY_PORT_IAD = parsePortEnv("BEDROCK_MANTLE_PROXY_PORT_IAD", 57891);

// Headers that must not be forwarded upstream (hop-by-hop + auth).
const DROP_REQUEST = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade",
  "authorization", "x-api-key", // replaced by SigV4
]);

// Headers that must not be forwarded back to the caller.
const DROP_RESPONSE = new Set(["content-encoding", "transfer-encoding", "connection"]);

/**
 * Build a fresh SignatureV4 signer that reads credentials from the current
 * process env on every call. This is intentional: the proxy may be long-lived
 * across pi sessions, and BEDROCK_MANTLE_AWS_PROFILE / AWS_PROFILE may differ
 * per session. Resolving per-request means rotated credentials and env changes
 * take effect immediately without restarting the proxy.
 */
function makeSigner(region: string): SignatureV4 {
  const profile = process.env.BEDROCK_MANTLE_AWS_PROFILE;
  // Use fromIni when an explicit profile is set — fromNodeProviderChain
  // reads AWS_PROFILE from env which may be clobbered by other extensions
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

function makeHandler(region: string) {
  const host = `bedrock-mantle.${region}.api.aws`;
  const target = `https://${host}`;

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Create a fresh signer per-request so BEDROCK_MANTLE_AWS_PROFILE changes
    // (e.g. from a newer pi session) are picked up without restarting the proxy.
    const signer = makeSigner(region);
    try {
      // 1. Collect body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const bodyBuf = Buffer.concat(chunks);
      const body = bodyBuf.toString("utf-8");

      // 2. Build headers to sign
      const headersToSign: Record<string, string> = {
        host,
        "content-type": (req.headers["content-type"] as string | undefined) ?? "application/json",
      };
      if (bodyBuf.length > 0) headersToSign["content-length"] = String(bodyBuf.length);

      // Forward non-auth x-* and anthropic-* headers from pi (e.g. anthropic-version)
      for (const [k, v] of Object.entries(req.headers)) {
        if ((k.startsWith("x-") || k.startsWith("anthropic-")) && !DROP_REQUEST.has(k) && typeof v === "string") {
          headersToSign[k] = v;
        }
      }

      // 3. SigV4 sign
      const signed = await signer.sign({
        method: req.method?.toUpperCase() ?? "POST",
        protocol: "https:",
        hostname: host,
        path: req.url ?? "/",
        headers: headersToSign,
        body,
      });

      // 4. Forward to bedrock-mantle
      const upstream = await fetch(`${target}${req.url ?? "/"}`, {
        method: req.method,
        headers: signed.headers as Record<string, string>,
        body: bodyBuf.length > 0 ? bodyBuf : undefined,
        // @ts-ignore — Node.js 18+ duplex for streaming bodies
        duplex: "half",
      });

      // 5. Stream response back
      const responseHeaders: Record<string, string> = {};
      for (const [k, v] of upstream.headers.entries()) {
        if (!DROP_RESPONSE.has(k.toLowerCase())) responseHeaders[k] = v;
      }
      res.writeHead(upstream.status, responseHeaders);

      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `bedrock-mantle proxy (${region}): ${msg}`, type: "proxy_error" } }));
    }
  };
}

/**
 * Start a signing proxy for the given region on the given port.
 * Rejects with EADDRINUSE if the port is already taken (another session owns it).
 */
export function startProxy(port: number, region: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = makeHandler(region);
    const server = createServer((req, res) => { void handler(req, res); });
    server.unref();
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
}
