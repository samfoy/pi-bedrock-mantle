/**
 * Model spec registry and live discovery for bedrock-mantle.
 *
 * Queries both us-east-1 and us-east-2 in parallel and merges the results.
 * Each model is assigned the correct API type and proxy baseUrl:
 *
 *   - Anthropic models (us-east-1 only):
 *       api: "anthropic-messages"
 *       baseUrl: http://localhost:57891/anthropic   (pi appends /v1/messages)
 *       headers: { anthropic-version: "2023-06-01" }
 *
 *   - GPT-5.x models:
 *       api: "openai-responses"
 *       baseUrl: http://localhost:57893/openai/v1   (pi appends /responses)
 *
 *   - Other OpenAI-compatible models:
 *       api: "openai-completions"
 *       baseUrl: http://localhost:57893/v1          (pi appends /chat/completions)
 *
 *   OpenAI-compatible route preference is us-east-2 when available, with
 *   fallback to us-east-1 for models only available there.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";
import { log } from "./log.js";
const CACHE_VERSION = 2;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_ENV = "BEDROCK_MANTLE_MODEL_CACHE";
const CMH_PLACEHOLDER = "{{CMH_PORT}}";
const IAD_PLACEHOLDER = "{{IAD_PORT}}";
/**
 * The pinned ports requested via env (0 = ephemeral). Used as the cache-key
 * dimension so a cache written when the user pinned ports doesn't get reused
 * after they un-pin (or vice versa). The actual bound ports go into baseUrls
 * via `applyPorts`.
 */
function requestedPorts() {
    return {
        cmh: Number(process.env.BEDROCK_MANTLE_PROXY_PORT_CMH ?? 0) || 0,
        iad: Number(process.env.BEDROCK_MANTLE_PROXY_PORT_IAD ?? 0) || 0,
    };
}
function cachePath() {
    if (process.env[CACHE_ENV])
        return process.env[CACHE_ENV];
    const root = process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? tmpdir(), ".cache");
    return join(root, "pi-bedrock-mantle", "models.json");
}
function isModelConfig(value) {
    if (!value || typeof value !== "object")
        return false;
    const model = value;
    return typeof model.id === "string" &&
        typeof model.name === "string" &&
        typeof model.contextWindow === "number" &&
        typeof model.maxTokens === "number" &&
        typeof model.reasoning === "boolean" &&
        Array.isArray(model.input) &&
        typeof model.cost === "object";
}
function parseCachedModels(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (parsed.version !== CACHE_VERSION)
            return null;
        if (typeof parsed.generatedAt !== "number")
            return null;
        const want = requestedPorts();
        if (parsed.proxyPorts?.cmh !== want.cmh || parsed.proxyPorts?.iad !== want.iad)
            return null;
        if (!Array.isArray(parsed.models) || !parsed.models.every(isModelConfig))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/**
 * Replace `{{CMH_PORT}}` / `{{IAD_PORT}}` placeholders in baseUrls with the
 * actual bound ports for this process. Called when reading from cache and
 * when building the fallback model list.
 */
function applyPorts(models, ports) {
    return models.map((m) => {
        if (!m.baseUrl)
            return m;
        const baseUrl = m.baseUrl
            .replace(CMH_PLACEHOLDER, String(ports.cmh))
            .replace(IAD_PLACEHOLDER, String(ports.iad));
        return { ...m, baseUrl };
    });
}
/**
 * Read the raw cache (with placeholder baseUrls) without rehydrating ports.
 * Mostly useful for tests; production code should call `readCachedModels`.
 */
function readRawCachedModels(options = {}) {
    const cached = (() => {
        try {
            return parseCachedModels(readFileSync(cachePath(), "utf8"));
        }
        catch {
            return null;
        }
    })();
    if (!cached)
        return null;
    const maxAgeMs = options.maxAgeMs;
    if (maxAgeMs !== undefined && Date.now() - cached.generatedAt > maxAgeMs)
        return null;
    return cached.models;
}
export function readCachedModels(ports, options = {}) {
    const raw = readRawCachedModels(options);
    return raw ? applyPorts(raw, ports) : null;
}
export function writeCachedModels(models) {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    // Strip the bound ports out of baseUrls before persisting — bound ports
    // change every run when ephemeral, but the routing logic (which port goes
    // with which region/api) is stable.
    const sanitized = models.map((m) => {
        if (!m.baseUrl)
            return m;
        const isAnthropic = m.api === "anthropic-messages";
        const placeholder = isAnthropic ? IAD_PLACEHOLDER : CMH_PLACEHOLDER;
        // Replace any 1-5-digit port immediately after `127.0.0.1:` with the placeholder.
        const baseUrl = m.baseUrl.replace(/(127\.0\.0\.1:)\d+/, `$1${placeholder}`);
        return { ...m, baseUrl };
    });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({
        version: CACHE_VERSION,
        generatedAt: Date.now(),
        proxyPorts: requestedPorts(),
        models: sanitized,
    }, null, 2));
    renameSync(tmp, path);
}
export function fastModels(ports) {
    // Prefer a fresh cache, then a stale cache, then the curated static list.
    // The cache stores baseUrls with port placeholders; applyPorts substitutes
    // the actual bound ports for this process.
    return readCachedModels(ports, { maxAgeMs: CACHE_TTL_MS })
        ?? readCachedModels(ports)
        ?? applyPorts(FALLBACK_MODELS_RAW, ports);
}
const KNOWN = {
    // OpenAI GPT-5 — us-east-2 only
    "openai.gpt-5.5": { contextWindow: 272000, maxTokens: 128000, reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, xhigh: "xhigh" } },
    "openai.gpt-5.5-2026-04-23": { contextWindow: 272000, maxTokens: 128000, reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, xhigh: "xhigh" } },
    "openai.gpt-5.4": { contextWindow: 272000, maxTokens: 128000, reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, xhigh: "xhigh" } },
    "openai.gpt-5.4-2026-03-05": { contextWindow: 272000, maxTokens: 128000, reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, xhigh: "xhigh" } },
    // OpenAI OSS
    "openai.gpt-oss-120b": { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text"] },
    "openai.gpt-oss-20b": { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text"] },
    "openai.gpt-oss-safeguard-120b": { contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"] },
    "openai.gpt-oss-safeguard-20b": { contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"] },
    // Anthropic — us-east-1 only
    // opus-4-7: adaptive thinking (reasoning summaries via display:summarized); effort levels low/medium/high/xhigh
    "anthropic.claude-opus-4-7": { contextWindow: 1000000, maxTokens: 32000, reasoning: true, input: ["text", "image"], thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" } },
    // opus-4-8: adaptive thinking (1M context); budget-based extended thinking
    "anthropic.claude-opus-4-8": { contextWindow: 1000000, maxTokens: 32000, reasoning: true, input: ["text", "image"], thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" } },
    // haiku-4-5: budget-based extended thinking
    "anthropic.claude-haiku-4-5": { contextWindow: 200000, maxTokens: 16000, reasoning: true, input: ["text", "image"], thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" } },
    // DeepSeek
    "deepseek.v3.1": { contextWindow: 163840, maxTokens: 32768, reasoning: false, input: ["text"] },
    "deepseek.v3.2": { contextWindow: 163840, maxTokens: 32768, reasoning: false, input: ["text"] },
    // Moonshot Kimi
    "moonshotai.kimi-k2-thinking": { contextWindow: 128000, maxTokens: 32768, reasoning: true, input: ["text"] },
    "moonshotai.kimi-k2.5": { contextWindow: 128000, maxTokens: 32768, reasoning: true, input: ["text"] },
    // MiniMax
    "minimax.minimax-m2": { contextWindow: 1000000, maxTokens: 65536, reasoning: false, input: ["text", "image"] },
    "minimax.minimax-m2.1": { contextWindow: 1000000, maxTokens: 65536, reasoning: false, input: ["text", "image"] },
    "minimax.minimax-m2.5": { contextWindow: 1000000, maxTokens: 65536, reasoning: false, input: ["text", "image"] },
    // Qwen3
    "qwen.qwen3-32b": { contextWindow: 131072, maxTokens: 32768, reasoning: true, input: ["text"] },
    "qwen.qwen3-235b-a22b-2507": { contextWindow: 131072, maxTokens: 32768, reasoning: true, input: ["text"] },
    "qwen.qwen3-coder-30b-a3b-instruct": { contextWindow: 131072, maxTokens: 32768, reasoning: true, input: ["text"] },
    "qwen.qwen3-coder-480b-a35b-instruct": { contextWindow: 131072, maxTokens: 32768, reasoning: true, input: ["text"] },
    "qwen.qwen3-coder-next": { contextWindow: 131072, maxTokens: 32768, reasoning: true, input: ["text"] },
    "qwen.qwen3-next-80b-a3b-instruct": { contextWindow: 131072, maxTokens: 32768, reasoning: true, input: ["text"] },
    "qwen.qwen3-vl-235b-a22b-instruct": { contextWindow: 131072, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
};
const ANTHROPIC_IDS = new Set([
    "anthropic.claude-opus-4-7",
    "anthropic.claude-opus-4-8",
    "anthropic.claude-haiku-4-5",
]);
// ─── Heuristics for unknown models ───────────────────────────────────────────
function inferSpec(id) {
    const reasoning = id.includes("gpt-5") || id.includes("thinking") || id.includes("kimi-k2") ||
        id.includes("qwq") || id.includes("o1") || id.includes("o3") || id.includes("r1") ||
        id.startsWith("anthropic.");
    const hasVision = id.includes("vision") || id.includes("-vl-") || id.includes("gemma") ||
        id.includes("gpt-5") || id.includes("palmyra") || id.startsWith("anthropic.");
    const thinkingLevelMap = reasoning
        ? id.includes("gpt-5")
            ? { off: null, xhigh: "xhigh" }
            : { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" }
        : undefined;
    return {
        contextWindow: id.startsWith("anthropic.") ? 200000 : 128000,
        maxTokens: id.startsWith("anthropic.") ? 16000 : 16384,
        reasoning,
        input: hasVision ? ["text", "image"] : ["text"],
        thinkingLevelMap,
    };
}
// ─── Display name ─────────────────────────────────────────────────────────────
const PROVIDER_LABELS = {
    openai: "OpenAI", deepseek: "DeepSeek", qwen: "Qwen", mistral: "Mistral",
    google: "Google", nvidia: "NVIDIA", moonshotai: "Moonshot AI",
    minimax: "MiniMax", zai: "ZAI", writer: "Writer", anthropic: "Anthropic",
};
function displayName(id) {
    const dot = id.indexOf(".");
    if (dot === -1)
        return `${id} (Bedrock)`;
    const provider = id.slice(0, dot);
    const model = id.slice(dot + 1);
    const label = PROVIDER_LABELS[provider] ?? (provider[0].toUpperCase() + provider.slice(1));
    const formatted = model
        .replace(/gpt-(\S+)/, (_, v) => `GPT-${v}`)
        .replace(/[-_]/g, " ")
        .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
        .replace(/\s+/g, " ")
        .trim();
    return `${label} ${formatted} (Bedrock)`;
}
// ─── Route assignment ─────────────────────────────────────────────────────────
// openai.gpt-5.* (and dated variants)  → openai-responses  on us-east-2
// anthropic.*                          → anthropic-messages on us-east-1
// everything else                      → openai-completions  on us-east-2 (or us-east-1 fallback)
function isOpenAIResponses(id) {
    // Only the GPT-5 family uses the Responses API — gpt-oss-* and all other
    // providers use the Chat Completions API instead.
    return /^openai\.gpt-5\./.test(id);
}
/**
 * Build a model config with placeholder baseUrls. The placeholder port is
 * substituted with the actual bound port via `applyPorts` either at cache
 * read time or when fastModels()/discoverModels() returns.
 */
function buildConfig(id, regions) {
    const spec = KNOWN[id] ?? inferSpec(id);
    const isAnthropic = id.startsWith("anthropic.");
    const base = {
        id,
        name: displayName(id),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...spec,
    };
    if (isAnthropic) {
        // Anthropic Messages API on us-east-1 proxy.
        return {
            ...base,
            api: "anthropic-messages",
            baseUrl: `http://127.0.0.1:${IAD_PLACEHOLDER}/anthropic`,
            headers: { "anthropic-version": "2023-06-01" },
        };
    }
    const placeholder = regions.has("us-east-2") ? CMH_PLACEHOLDER : IAD_PLACEHOLDER;
    if (isOpenAIResponses(id)) {
        // GPT-5.x family: uses the OpenAI Responses API.
        return {
            ...base,
            api: "openai-responses",
            baseUrl: `http://127.0.0.1:${placeholder}/openai/v1`,
        };
    }
    // All other providers (DeepSeek, Qwen, Mistral, Kimi, MiniMax, NVIDIA, Gemma,
    // ZAI, Writer, openai.gpt-oss-*): use the OpenAI Chat Completions API.
    return {
        ...base,
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${placeholder}/v1`,
    };
}
// ─── Live discovery ───────────────────────────────────────────────────────────
const REGIONS = ["us-east-1", "us-east-2"];
async function fetchRegionModels(region) {
    const host = `bedrock-mantle.${region}.api.aws`;
    const profile = process.env.BEDROCK_MANTLE_AWS_PROFILE;
    // Match proxy.ts: prefer the extension-specific profile when set instead of
    // relying on AWS_PROFILE/default chain, which other pi extensions may clobber.
    const credentials = profile
        ? fromIni({ profile })
        : fromNodeProviderChain();
    const signer = new SignatureV4({
        credentials,
        service: "bedrock",
        region,
        sha256: Sha256,
    });
    const signed = await signer.sign({
        method: "GET", protocol: "https:",
        hostname: host, path: "/v1/models",
        headers: { host }, body: "",
    });
    const res = await fetch(`https://${host}/v1/models`, { headers: signed.headers });
    if (!res.ok)
        throw new Error(`${region}: HTTP ${res.status}`);
    const data = (await res.json());
    return data.data.map((m) => m.id);
}
export async function discoverModels(ports) {
    const results = await Promise.allSettled(REGIONS.map(fetchRegionModels));
    // Map model id → set of regions it's available in
    const modelRegions = new Map();
    for (let i = 0; i < REGIONS.length; i++) {
        const result = results[i];
        if (result.status !== "fulfilled")
            continue;
        for (const id of result.value) {
            if (!modelRegions.has(id))
                modelRegions.set(id, new Set());
            modelRegions.get(id).add(REGIONS[i]);
        }
    }
    if (modelRegions.size === 0) {
        const reasons = results.map((result, i) => {
            if (result.status === "fulfilled")
                return `${REGIONS[i]}: no models returned`;
            const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
            return `${REGIONS[i]}: ${reason}`;
        });
        throw new Error(`All regions failed (${reasons.join("; ")})`);
    }
    const placeholderConfigs = Array.from(modelRegions.entries()).map(([id, regions]) => buildConfig(id, regions));
    return applyPorts(placeholderConfigs, ports);
}
export async function fetchModels(ports) {
    try {
        const models = await discoverModels(ports);
        writeCachedModels(models);
        return models;
    }
    catch (err) {
        log.warn("discovery_failed", {
            error: err,
            fallback: "curated_static_list",
            hint: "refresh credentials and restart pi for the live model list",
        });
        return applyPorts(FALLBACK_MODELS_RAW, ports);
    }
}
// ─── Fallback ─────────────────────────────────────────────────────────────────
/**
 * Curated fallback list with port placeholders. Use `applyPorts` (or `fastModels`)
 * to substitute actual bound ports before passing to pi.
 */
export const FALLBACK_MODELS_RAW = Object.keys(KNOWN).map((id) => {
    const regions = new Set(ANTHROPIC_IDS.has(id) ? ["us-east-1"] : ["us-east-2"]);
    return buildConfig(id, regions);
});
/**
 * @deprecated Use `fastModels(ports)` or `applyPorts(FALLBACK_MODELS_RAW, ports)`.
 * Retained as the placeholder list for callers that don't have ports yet.
 */
export const FALLBACK_MODELS = FALLBACK_MODELS_RAW;
