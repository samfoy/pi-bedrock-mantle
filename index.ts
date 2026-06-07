/**
 * pi-bedrock-mantle
 *
 * Pi extension: all bedrock-mantle models — GPT-5.x, Anthropic Claude, DeepSeek,
 * Qwen3, Mistral, Kimi, and more — via SigV4 auth. No long-term API key needed.
 *
 * Each pi process binds its own ephemeral-port loopback proxy by default
 * (override with BEDROCK_MANTLE_PROXY_PORT_CMH/IAD if you need a stable URL
 * for an external consumer). Two regions are bridged:
 *
 *   - 127.0.0.1:<cmh>  →  bedrock-mantle.us-east-2.api.aws  (GPT-5.x + shared)
 *   - 127.0.0.1:<iad>  →  bedrock-mantle.us-east-1.api.aws  (Anthropic Claude)
 *
 * Anthropic models use pi's anthropic-messages driver, GPT-5.x uses pi's
 * openai-responses driver, and GPT OSS / other OpenAI-compatible models use
 * openai-completions. Per-model baseUrl overrides route each model to the
 * right proxy automatically.
 *
 * In-process surface: callers that want to use bedrock-mantle without the
 * HTTP indirection can `import { signAndForward, createSigningProxy } from
 * "pi-bedrock-mantle"`. See proxy.ts for the API.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  discoverModels,
  fastModels,
  type PiModelConfig,
  type ProxyPorts,
  writeCachedModels,
} from "./models.js";
import {
  createSigningProxy,
  PROXY_PORT_CMH,
  PROXY_PORT_IAD,
  type SigningProxy,
} from "./proxy.js";

// Public re-exports for in-process callers.
export {
  signAndForward,
  createSigningProxy,
  type SigningProxy,
  type SignAndForwardInput,
} from "./proxy.js";

interface ProxySetup {
  cmh: SigningProxy | null;
  iad: SigningProxy | null;
  ports: ProxyPorts;
}

/**
 * Bind both region proxies. Each is independent: if one region's proxy fails
 * to bind (e.g. a fixed port is already taken by another process), the other
 * still starts. The returned `ports` reflect the *actual* bound ports — these
 * are what models.ts uses to build baseUrls.
 */
async function startProxies(): Promise<ProxySetup> {
  const [cmhResult, iadResult] = await Promise.allSettled([
    createSigningProxy("us-east-2", PROXY_PORT_CMH),
    createSigningProxy("us-east-1", PROXY_PORT_IAD),
  ]);

  const cmh = cmhResult.status === "fulfilled" ? cmhResult.value : null;
  const iad = iadResult.status === "fulfilled" ? iadResult.value : null;

  // If a fixed port was requested and is already taken, log enough detail to
  // diagnose. Ephemeral binds can't fail on EADDRINUSE so this is purely for
  // operators who pinned a port.
  if (!cmh && cmhResult.status === "rejected") {
    console.warn(`[bedrock-mantle] us-east-2 proxy failed to bind: ${describeErr(cmhResult.reason)}`);
  }
  if (!iad && iadResult.status === "rejected") {
    console.warn(`[bedrock-mantle] us-east-1 proxy failed to bind: ${describeErr(iadResult.reason)}`);
  }

  return {
    cmh,
    iad,
    ports: {
      // 0 means "not bound" — models gated to a missing region will be filtered
      // out / show with an unreachable baseUrl, which surfaces as a clear
      // network error rather than a silent failure.
      cmh: cmh?.port ?? 0,
      iad: iad?.port ?? 0,
    },
  };
}

function describeErr(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

function registerBedrockMantleProvider(pi: ExtensionAPI, models: PiModelConfig[], ports: ProxyPorts): void {
  // Pick a baseUrl that points at any live proxy — pi requires a provider-level
  // baseUrl even though every model overrides it. Prefer the CMH proxy (more
  // models route there); fall back to IAD; if neither is up, register a stub
  // baseUrl that will surface ECONNREFUSED on the first request rather than
  // failing extension load.
  const fallbackPort = ports.cmh || ports.iad || 0;

  pi.registerProvider("bedrock-mantle", {
    name: "Bedrock Mantle",
    baseUrl: `http://127.0.0.1:${fallbackPort}/v1`,
    api: "openai-completions",
    // apiKey required by pi's schema; unused — SigV4 auth is handled by the proxies.
    apiKey: "sigv4-via-proxy",
    authHeader: false,
    models,
  });
}

export default async function bedrockMantleExtension(pi: ExtensionAPI): Promise<void> {
  // Credentials are resolved per-request in the proxy (not at startup), so
  // BEDROCK_MANTLE_AWS_PROFILE takes effect on every call. We no longer
  // clobber AWS_PROFILE globally.
  const profile = process.env.BEDROCK_MANTLE_AWS_PROFILE;
  const profileLabel = profile ? `profile=${profile}` : "default credential chain";

  // Bind proxies first so the cache-derived baseUrls reference real ports.
  const setup = await startProxies();

  if (!setup.cmh && !setup.iad) {
    console.error("[bedrock-mantle] Both proxies failed to bind — aborting registration.");
    return;
  }

  const proxyStatus = setup.cmh && setup.iad
    ? `proxies ready on :${setup.cmh.port}/:${setup.iad.port}`
    : setup.cmh
      ? `proxy ready on :${setup.cmh.port} (us-east-1 unavailable)`
      : `proxy ready on :${setup.iad!.port} (us-east-2 unavailable)`;

  console.log(`[bedrock-mantle] ${proxyStatus} — signing with ${profileLabel}`);

  // Register from the cache/fallback synchronously so the model list is
  // available immediately. Live discovery runs in the background.
  registerBedrockMantleProvider(pi, fastModels(setup.ports), setup.ports);

  void (async () => {
    try {
      const models = await discoverModels(setup.ports);
      registerBedrockMantleProvider(pi, models, setup.ports);
      try {
        writeCachedModels(models);
      } catch (err) {
        console.warn(`[bedrock-mantle] Live model cache write failed (${describeErr(err)})`);
      }
      console.log(`[bedrock-mantle] refreshed ${models.length} models from live discovery`);
    } catch (err) {
      console.warn(
        `[bedrock-mantle] Background model discovery failed (${describeErr(err)}) — using cached/fallback model list.`
      );
    }
  })();
}
