/**
 * pi-bedrock-mantle
 *
 * Pi extension: all bedrock-mantle models via SigV4 — no long-term API key needed.
 *
 * Bedrock-mantle accepts both a long-term AWS_BEARER_TOKEN_BEDROCK key *and*
 * standard SigV4-signed requests. This extension takes the SigV4 path so any
 * machine with valid IAM/STS credentials (ada, Isengard, env vars, ~/.aws/config
 * credential_process) can use every bedrock-mantle model without extra provisioning.
 *
 * How it works:
 *   1. An async factory fetches the live model list from bedrock-mantle at startup,
 *      falling back to a curated static list if creds are unavailable.
 *   2. A lightweight HTTP proxy starts on localhost:57893. Pi's built-in
 *      openai-responses driver sends inference requests here.
 *   3. The proxy SigV4-signs each request using fromNodeProviderChain() and
 *      forwards it to bedrock-mantle. Streaming SSE is piped back unchanged.
 *
 * Credential setup (one-time):
 *   Add to ~/.aws/config:
 *     [profile personal-dev]
 *     region=us-east-2
 *     credential_process=timeout 10 ada credentials print \
 *       --account=<your-account-id> --provider=conduit \
 *       --role=IibsAdminAccess-DO-NOT-DELETE --format=json
 *
 *   Then set in ~/.zshrc:
 *     export BEDROCK_MANTLE_AWS_PROFILE=personal-dev
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchModels } from "./models.js";
import { startProxy, PROXY_PORT } from "./proxy.js";

export default async function bedrockMantleExtension(pi: ExtensionAPI): Promise<void> {
  // Honor explicit profile override before the credential chain resolves.
  const profile = process.env.BEDROCK_MANTLE_AWS_PROFILE;
  if (profile) {
    process.env.AWS_PROFILE = profile;
  }

  // Start the signing proxy (or reuse one already running from another session).
  try {
    await startProxy();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bedrock-mantle] Failed to start signing proxy: ${msg}`);
      return;
    }
    // Another pi session already owns the proxy — reuse it.
  }

  // Fetch the live model list; falls back to a curated static list on failure.
  const models = await fetchModels();

  pi.registerProvider("bedrock-mantle", {
    name: "Bedrock Mantle",
    // baseUrl must include /openai/v1 — pi's openai-responses driver appends /responses,
    // making the full inference URL: bedrock-mantle.us-east-2.api.aws/openai/v1/responses
    baseUrl: `http://127.0.0.1:${PROXY_PORT}/openai/v1`,
    api: "openai-responses",
    // apiKey is required by pi's schema but unused — SigV4 auth is in the proxy.
    apiKey: "sigv4-via-proxy",
    authHeader: false,
    models,
  });
}
