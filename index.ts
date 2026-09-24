/**
 * pi-bedrock-mantle
 *
 * Pi extension: all bedrock-mantle models — GPT-5.x, Anthropic Claude, DeepSeek,
 * Qwen3, Mistral, Kimi, and more — via SigV4 auth. No long-term API key needed.
 *
 * Each pi session binds its own ephemeral-port loopback proxies on
 * session_start and closes them on session_shutdown (override the ports with
 * BEDROCK_MANTLE_PROXY_PORT_CMH/IAD if you need a stable URL for an external
 * consumer). Two regions are bridged:
 *
 *   - 127.0.0.1:<cmh>  →  bedrock-mantle.us-east-2.api.aws  (GPT-5.x + shared)
 *   - 127.0.0.1:<iad>  →  bedrock-mantle.us-east-1.api.aws  (Anthropic Claude)
 *
 * Anthropic models use pi's anthropic-messages driver, GPT-5.x uses pi's
 * openai-responses driver, and GPT OSS / other OpenAI-compatible models use
 * openai-completions. Per-model baseUrls route each model to the right proxy,
 * and every request re-resolves the live port (see liveBaseUrl).
 */

import {
  anthropicMessagesApi,
  type Api,
  createProvider,
  lazyStream,
  type Model,
  openAICompletionsApi,
  openAIResponsesApi,
  type ProviderAuth,
  type ProviderStreams,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  discoverModels,
  fastModels,
  liveBaseUrl,
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
import { log } from "./log.js";

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
    log.warn("proxy_bind_failed", { region: "us-east-2", error: cmhResult.reason });
  }
  if (!iad && iadResult.status === "rejected") {
    log.warn("proxy_bind_failed", { region: "us-east-1", error: iadResult.reason });
  }

  return {
    cmh,
    iad,
    ports: {
      // 0 means "not bound": liveBaseUrl rejects requests for that region.
      cmh: cmh?.port ?? 0,
      iad: iad?.port ?? 0,
    },
  };
}

const PROVIDER_ID = "bedrock-mantle";

// pi's drivers need an API key; the proxies drop it and sign with SigV4.
const SIGV4_AUTH: ProviderAuth = {
  apiKey: {
    name: "AWS credentials (SigV4)",
    resolve: async () => ({ auth: { apiKey: "sigv4-via-proxy" }, source: "AWS credentials via the SigV4 proxy" }),
  },
};

const API_STREAMS: Record<string, ProviderStreams> = {
  "anthropic-messages": anthropicMessagesApi(),
  "openai-responses": openAIResponsesApi(),
  "openai-completions": openAICompletionsApi(),
};

/** pi's API streams, sending each request to the live proxy whatever port the model object names. */
function viaLiveProxy(baseUrlFor: (model: Model<Api>) => string): Record<string, ProviderStreams> {
  const live = (model: Model<Api>): Model<Api> => ({ ...model, baseUrl: baseUrlFor(model) });
  return Object.fromEntries(Object.entries(API_STREAMS).map(([api, streams]) => [api, {
    stream: (model, context, options) => lazyStream(model, async () => streams.stream(live(model), context, options)),
    streamSimple: (model, context, options) =>
      lazyStream(model, async () => streams.streamSimple(live(model), context, options)),
  } satisfies ProviderStreams]));
}

function toModel(config: PiModelConfig, providerBaseUrl: string): Model<Api> {
  return {
    ...config,
    api: config.api ?? "openai-completions",
    baseUrl: config.baseUrl ?? providerBaseUrl,
    provider: PROVIDER_ID,
    thinkingLevelMap: config.thinkingLevelMap as ThinkingLevelMap | undefined,
  };
}

function registerBedrockMantleProvider(
  pi: ExtensionAPI,
  models: PiModelConfig[],
  ports: ProxyPorts,
  api: Record<string, ProviderStreams>,
): void {
  // Prefer the CMH proxy (more models route there); port 0 until one binds.
  const baseUrl = `http://127.0.0.1:${ports.cmh || ports.iad || 0}/v1`;
  pi.registerProvider(createProvider({
    id: PROVIDER_ID,
    name: "Bedrock Mantle",
    baseUrl,
    auth: SIGV4_AUTH,
    models: models.map((model) => toModel(model, baseUrl)),
    api,
  }));
}

/** Ports before session_start binds the proxies; liveBaseUrl rejects requests until then. */
const UNBOUND: ProxyPorts = { cmh: 0, iad: 0 };

function closeProxies(setup: ProxySetup): Promise<unknown> {
  return Promise.allSettled([setup.cmh?.close(), setup.iad?.close()]);
}

export default function bedrockMantleExtension(pi: ExtensionAPI): void {
  const profile = process.env.BEDROCK_MANTLE_AWS_PROFILE;
  let setup: ProxySetup | undefined;
  let shutDown = false;
  let registered: readonly PiModelConfig[] = [];

  // Read at request time: the proxies up now and the latest registration.
  const api = viaLiveProxy((model) => liveBaseUrl(model, setup && { ports: setup.ports, models: registered }));
  const register = (models: PiModelConfig[], ports: ProxyPorts): void => {
    registerBedrockMantleProvider(pi, models, ports, api);
    registered = models;
  };

  // Register now so `--model` / `--list-models` resolve during startup. Sockets
  // wait for session_start: pi's lifecycle contract forbids them in the factory,
  // since some invocations load extensions without starting a session.
  register(fastModels(UNBOUND), UNBOUND);

  pi.on("session_start", async () => {
    if (setup || shutDown) return;
    const started = await startProxies();
    if (shutDown) {
      await closeProxies(started);
      return;
    }
    setup = started;

    if (!started.cmh && !started.iad) {
      log.error("startup_failed", { reason: "both_proxies_failed" });
      return;
    }

    log.info("ready", {
      cmh_port: started.cmh?.port,
      iad_port: started.iad?.port,
      profile: profile ?? "default-credential-chain",
    });

    // Re-register with the bound ports. pi refreshes only the selected model
    // from the registry, so requests re-resolve the port of any stale copy.
    // Live discovery runs in the background.
    register(fastModels(started.ports), started.ports);

    void (async () => {
      try {
        const models = await discoverModels(started.ports);
        // The runtime is stale after shutdown: registering would throw.
        if (shutDown) return;
        register(models, started.ports);
        try {
          writeCachedModels(models, started.ports);
        } catch (err) {
          log.warn("cache_write_failed", { error: err });
        }
        log.info("discovery_refreshed", { models: models.length });
      } catch (err) {
        log.warn("discovery_failed", { error: err, fallback: "cached_or_curated" });
      }
    })();
  });

  // Every /new, /resume, /fork and /reload loads a fresh copy of this
  // extension, so the old copy must release its listeners. Idempotent.
  pi.on("session_shutdown", async () => {
    shutDown = true;
    const current = setup;
    setup = undefined;
    if (current) await closeProxies(current);
  });
}
