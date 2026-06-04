/**
 * SigV4 signing proxy for bedrock-mantle.
 *
 * Runs as a lightweight HTTP server on localhost. Pi's built-in openai-responses
 * driver sends requests here; the proxy signs them with SigV4 using the AWS
 * credential chain (env vars, ~/.aws/credentials, IMDS — whatever ada/Isengard
 * populated) and forwards to the real bedrock-mantle endpoint.
 *
 * This means any machine with valid AWS creds can use GPT-5.x on Bedrock without
 * provisioning a long-term AWS_BEARER_TOKEN_BEDROCK key.
 *
 * Port selection: fixed at PROXY_PORT. If the port is already in use (another pi
 * session started the proxy), startProxy() returns normally and the caller reuses
 * that existing proxy.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

const TARGET = "https://bedrock-mantle.us-east-2.api.aws";
const REGION = "us-east-2";
const SERVICE = "bedrock";

/** Port the local signing proxy listens on. */
export const PROXY_PORT = 57893;

// Headers that must not be forwarded to the upstream (hop-by-hop + auth).
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "authorization", // We replace this with SigV4
]);

// Headers that must not be forwarded to the pi caller in the response
// (fetch() auto-decompresses, so don't claim the body is still gzip).
const DROP_RESPONSE = new Set(["content-encoding", "transfer-encoding", "connection"]);

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // 1. Collect the request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const bodyBuf = Buffer.concat(chunks);
    const body = bodyBuf.toString("utf-8");

    // 2. Build the target URL
    const targetUrl = `${TARGET}${req.url ?? "/"}`;
    const parsed = new URL(targetUrl);

    // 3. Assemble headers to sign (only what SigV4 needs; no hop-by-hop, no auth)
    const headersToSign: Record<string, string> = {
      host: parsed.hostname,
      "content-type": (req.headers["content-type"] as string | undefined) ?? "application/json",
    };
    if (bodyBuf.length > 0) {
      headersToSign["content-length"] = String(bodyBuf.length);
    }
    // Forward any x-* headers from the upstream client (e.g. openai-beta)
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.startsWith("x-") && !HOP_BY_HOP.has(k) && typeof v === "string") {
        headersToSign[k] = v;
      }
    }

    // 4. Sign with SigV4 — credentials come from the chain (ada/Isengard, env, config)
    const signer = new SignatureV4({
      credentials: fromNodeProviderChain(),
      service: SERVICE,
      region: REGION,
      sha256: Sha256,
    });

    const signed = await signer.sign({
      method: req.method?.toUpperCase() ?? "POST",
      protocol: "https:",
      hostname: parsed.hostname,
      path: parsed.pathname + (parsed.search ?? ""),
      headers: headersToSign,
      body,
    });

    // 5. Forward to bedrock-mantle
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: signed.headers as Record<string, string>,
      body: bodyBuf.length > 0 ? bodyBuf : undefined,
      // @ts-ignore — Node.js 18+ supports this
      duplex: "half",
    });

    // 6. Stream the response back to pi (filter hop-by-hop / content-encoding)
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of upstream.headers.entries()) {
      if (!DROP_RESPONSE.has(k.toLowerCase())) {
        responseHeaders[k] = v;
      }
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
    console.error("[bedrock-mantle proxy] Request error:", msg);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: { message: `bedrock-mantle proxy: ${msg}`, type: "proxy_error", code: 500 } }));
  }
}

/**
 * Start the signing proxy. Resolves once the server is listening.
 * Rejects with EADDRINUSE if the port is already taken (another pi session owns it).
 */
export function startProxy(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handleRequest(req, res);
    });
    // Don't let the proxy server prevent the pi process from exiting cleanly.
    server.unref();
    server.listen(PROXY_PORT, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
}
