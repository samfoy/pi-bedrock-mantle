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
 * Anthropic models use pi's anthropic-messages driver, GPT-5.x uses pi's
 * openai-responses driver, and GPT OSS / other OpenAI-compatible models use
 * openai-completions. Per-model baseUrl overrides route each model to the
 * right proxy automatically.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverModels, fastModels, type PiModelConfig, writeCachedModels } from "./models.js";
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

function registerBedrockMantleProvider(pi: ExtensionAPI, models: PiModelConfig[]): void {
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

export default async function bedrockMantleExtension(pi: ExtensionAPI): Promise<void> {
  // Credentials are resolved per-request in the proxy (not at startup), so
  // BEDROCK_MANTLE_AWS_PROFILE takes effect on every call even when the proxy
  // is shared across sessions. We no longer clobber AWS_PROFILE globally.
  const profile = process.env.BEDROCK_MANTLE_AWS_PROFILE;
  const profileLabel = profile ? `profile=${profile}` : "default credential chain";

  // Keep local proxy bind on the startup path so the first request has a
  // listener, but do not block on remote /v1/models discovery.
  const [cmhErr, iadErr] = await Promise.allSettled([
    ensureProxy(PROXY_PORT_CMH, "us-east-2"),
    ensureProxy(PROXY_PORT_IAD, "us-east-1"),
  ]);

  const cmhReady = cmhErr.status === "fulfilled";
  const iadReady = iadErr.status === "fulfilled";

  if (!cmhReady && !iadReady) {
    console.error("[bedrock-mantle] Both proxies failed to start — aborting registration.");
    return;
  }

  const proxyStatus = cmhReady && iadReady
    ? `proxies ready on :${PROXY_PORT_CMH}/:${PROXY_PORT_IAD}`
    : cmhReady
      ? `proxy ready on :${PROXY_PORT_CMH} (IAD unavailable)`
      : `proxy ready on :${PROXY_PORT_IAD} (CMH unavailable)`;

  console.log(`[bedrock-mantle] ${proxyStatus} — signing with ${profileLabel}`);

  // Register immediately from cache/fallback. Live model discovery runs in the
  // background and re-registers the provider when it completes so extension
  // startup does not block pi's time-to-first-token.
  registerBedrockMantleProvider(pi, fastModels());

  void (async () => {
    try {
      const models = await discoverModels();
      registerBedrockMantleProvider(pi, models);
      try {
        writeCachedModels(models);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[bedrock-mantle] Live model cache write failed (${msg})`);
      }
      console.log(`[bedrock-mantle] refreshed ${models.length} models from live discovery`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[bedrock-mantle] Background model discovery failed (${msg}) — using cached/fallback model list.`
      );
    }
  })();
}
