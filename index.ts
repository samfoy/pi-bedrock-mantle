/**
 * pi-bedrock-mantle
 *
 * Pi extension: all bedrock-mantle models — GPT-5.x, Anthropic Claude, DeepSeek,
 * Qwen3, Mistral, Kimi, and more — via SigV4 auth. No long-term API key needed.
 *
 * Two regions, two proxies:
 *   - localhost:57893  →  bedrock-mantle.us-east-2.api.aws  (GPT-5.x + shared)
 *   - localhost:57891  →  bedrock-mantle.us-east-1.api.aws  (Anthropic Claude)
 *
 * Anthropic models use pi's anthropic-messages driver; everything else uses
 * openai-responses. Per-model baseUrl overrides route each model to the right
 * proxy automatically.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fetchModels } from "./models.js";
import { startProxy, PROXY_PORT_CMH, PROXY_PORT_IAD } from "./proxy.js";

async function ensureProxy(port: number, region: string): Promise<void> {
  try {
    await startProxy(port, region);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      throw err;
    }
    // Another pi session owns this proxy — reuse it.
  }
}

export default async function bedrockMantleExtension(pi: ExtensionAPI): Promise<void> {
  // Honor explicit profile override before the credential chain resolves.
  const profile = process.env.BEDROCK_MANTLE_AWS_PROFILE;
  if (profile) process.env.AWS_PROFILE = profile;

  // Start both regional proxies (or reuse existing ones).
  const [cmhErr, iadErr] = await Promise.allSettled([
    ensureProxy(PROXY_PORT_CMH, "us-east-2"),
    ensureProxy(PROXY_PORT_IAD, "us-east-1"),
  ]);

  if (cmhErr.status === "rejected" && iadErr.status === "rejected") {
    console.error("[bedrock-mantle] Both proxies failed to start — aborting registration.");
    return;
  }

  // Fetch live model list from both regions; falls back to curated static list.
  const models = await fetchModels();

  pi.registerProvider("bedrock-mantle", {
    name: "Bedrock Mantle",
    // Default api/baseUrl (overridden per-model via PiModelConfig fields).
    // Most models use openai-completions; GPT-5.x uses openai-responses;
    // Anthropic uses anthropic-messages. Each model sets its own baseUrl.
    baseUrl: `http://127.0.0.1:${PROXY_PORT_CMH}/v1`,
    api: "openai-completions",
    // apiKey required by pi's schema; unused — SigV4 auth is handled by the proxies.
    apiKey: "sigv4-via-proxy",
    authHeader: false,
    models,
  });
}
