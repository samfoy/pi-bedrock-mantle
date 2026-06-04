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
 *   - All other models (OpenAI-style):
 *       api: "openai-responses"
 *       baseUrl: http://localhost:57893/openai/v1   (pi appends /responses)
 *       Region preference: us-east-2 when available (GPT-5.x is us-east-2 only),
 *       fallback to us-east-1 for models only available there.
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";
import { PROXY_PORT_CMH, PROXY_PORT_IAD } from "./proxy.js";

export interface PiModelConfig {
  id: string;
  name: string;
  api?: string;
  baseUrl?: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

// ─── Known specs ─────────────────────────────────────────────────────────────

interface ModelSpec {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

const KNOWN: Record<string, ModelSpec> = {
  // OpenAI GPT-5 — us-east-2 only
  "openai.gpt-5.5":              { contextWindow: 272000, maxTokens: 128000, reasoning: true,  input: ["text", "image"], thinkingLevelMap: { minimal: "low" } },
  "openai.gpt-5.5-2026-04-23":   { contextWindow: 272000, maxTokens: 128000, reasoning: true,  input: ["text", "image"], thinkingLevelMap: { minimal: "low" } },
  "openai.gpt-5.4":              { contextWindow: 272000, maxTokens: 128000, reasoning: true,  input: ["text", "image"], thinkingLevelMap: { minimal: "low" } },
  "openai.gpt-5.4-2026-03-05":   { contextWindow: 272000, maxTokens: 128000, reasoning: true,  input: ["text", "image"], thinkingLevelMap: { minimal: "low" } },
  // OpenAI OSS
  "openai.gpt-oss-120b":           { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text"] },
  "openai.gpt-oss-20b":            { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text"] },
  "openai.gpt-oss-safeguard-120b": { contextWindow: 128000, maxTokens: 4096,  reasoning: false, input: ["text"] },
  "openai.gpt-oss-safeguard-20b":  { contextWindow: 128000, maxTokens: 4096,  reasoning: false, input: ["text"] },
  // Anthropic — us-east-1 only
  "anthropic.claude-opus-4-7":   { contextWindow: 200000, maxTokens: 32000,  reasoning: true,  input: ["text", "image"] },
  "anthropic.claude-opus-4-8":   { contextWindow: 200000, maxTokens: 32000,  reasoning: true,  input: ["text", "image"] },
  "anthropic.claude-haiku-4-5":  { contextWindow: 200000, maxTokens: 16000,  reasoning: true,  input: ["text", "image"] },
  // DeepSeek
  "deepseek.v3.1":               { contextWindow: 163840, maxTokens: 32768, reasoning: false, input: ["text"] },
  "deepseek.v3.2":               { contextWindow: 163840, maxTokens: 32768, reasoning: false, input: ["text"] },
  // Moonshot Kimi
  "moonshotai.kimi-k2-thinking": { contextWindow: 128000, maxTokens: 32768, reasoning: true,  input: ["text"] },
  "moonshotai.kimi-k2.5":        { contextWindow: 128000, maxTokens: 32768, reasoning: true,  input: ["text"] },
  // MiniMax
  "minimax.minimax-m2":          { contextWindow: 1000000, maxTokens: 65536, reasoning: false, input: ["text", "image"] },
  "minimax.minimax-m2.1":        { contextWindow: 1000000, maxTokens: 65536, reasoning: false, input: ["text", "image"] },
  "minimax.minimax-m2.5":        { contextWindow: 1000000, maxTokens: 65536, reasoning: false, input: ["text", "image"] },
  // Qwen3
  "qwen.qwen3-32b":                       { contextWindow: 131072, maxTokens: 32768, reasoning: true,  input: ["text"] },
  "qwen.qwen3-235b-a22b-2507":            { contextWindow: 131072, maxTokens: 32768, reasoning: true,  input: ["text"] },
  "qwen.qwen3-coder-30b-a3b-instruct":    { contextWindow: 131072, maxTokens: 32768, reasoning: true,  input: ["text"] },
  "qwen.qwen3-coder-480b-a35b-instruct":  { contextWindow: 131072, maxTokens: 32768, reasoning: true,  input: ["text"] },
  "qwen.qwen3-coder-next":                { contextWindow: 131072, maxTokens: 32768, reasoning: true,  input: ["text"] },
  "qwen.qwen3-next-80b-a3b-instruct":     { contextWindow: 131072, maxTokens: 32768, reasoning: true,  input: ["text"] },
  "qwen.qwen3-vl-235b-a22b-instruct":     { contextWindow: 131072, maxTokens: 32768, reasoning: true,  input: ["text", "image"] },
};

const ANTHROPIC_IDS = new Set([
  "anthropic.claude-opus-4-7",
  "anthropic.claude-opus-4-8",
  "anthropic.claude-haiku-4-5",
]);

// ─── Heuristics for unknown models ───────────────────────────────────────────

function inferSpec(id: string): ModelSpec {
  const reasoning =
    id.includes("gpt-5") || id.includes("thinking") || id.includes("kimi-k2") ||
    id.includes("qwq") || id.includes("o1") || id.includes("o3") || id.includes("r1") ||
    id.startsWith("anthropic.");

  const hasVision =
    id.includes("vision") || id.includes("-vl-") || id.includes("gemma") ||
    id.includes("gpt-5") || id.includes("palmyra") || id.startsWith("anthropic.");

  return {
    contextWindow: id.startsWith("anthropic.") ? 200000 : 128000,
    maxTokens: id.startsWith("anthropic.") ? 16000 : 16384,
    reasoning,
    input: hasVision ? ["text", "image"] : ["text"],
    thinkingLevelMap: reasoning ? { minimal: "low" } : undefined,
  };
}

// ─── Display name ─────────────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI", deepseek: "DeepSeek", qwen: "Qwen", mistral: "Mistral",
  google: "Google", nvidia: "NVIDIA", moonshotai: "Moonshot AI",
  minimax: "MiniMax", zai: "ZAI", writer: "Writer", anthropic: "Anthropic",
};

function displayName(id: string): string {
  const dot = id.indexOf(".");
  if (dot === -1) return `${id} (Bedrock)`;
  const provider = id.slice(0, dot);
  const model = id.slice(dot + 1);
  const label = PROVIDER_LABELS[provider] ?? (provider[0].toUpperCase() + provider.slice(1));
  const formatted = model
    .replace(/gpt-(\S+)/, (_, v) => `GPT-${v}`)
    .replace(/[-_]/g, " ")
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
  return `${label} ${formatted} (Bedrock)`;
}

// ─── Route assignment ─────────────────────────────────────────────────────────
// openai.gpt-5.* (and dated variants)  → openai-responses  on us-east-2
// anthropic.*                          → anthropic-messages on us-east-1
// everything else                      → openai-completions  on us-east-2 (or us-east-1 fallback)

function isOpenAIResponses(id: string): boolean {
  // Only the GPT-5 family uses the Responses API — gpt-oss-* and all other
  // providers use the Chat Completions API instead.
  return /^openai\.gpt-5\./.test(id);
}

function buildConfig(id: string, regions: Set<string>): PiModelConfig {
  const spec = KNOWN[id] ?? inferSpec(id);
  const isAnthropic = id.startsWith("anthropic.");

  const base: PiModelConfig = {
    id,
    name: displayName(id),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...spec,
  };

  if (isAnthropic) {
    // Anthropic Messages API on us-east-1 proxy.
    // pi's anthropic-messages driver calls {baseUrl}/v1/messages →
    //   http://localhost:57891/anthropic/v1/messages →
    //   https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages ✓
    return {
      ...base,
      api: "anthropic-messages",
      baseUrl: `http://127.0.0.1:${PROXY_PORT_IAD}/anthropic`,
      headers: { "anthropic-version": "2023-06-01" },
    };
  }

  const port = regions.has("us-east-2") ? PROXY_PORT_CMH : PROXY_PORT_IAD;

  if (isOpenAIResponses(id)) {
    // GPT-5.x family: uses the OpenAI Responses API.
    // pi's openai-responses driver calls {baseUrl}/responses →
    //   http://localhost:57893/openai/v1/responses →
    //   https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses ✓
    return {
      ...base,
      api: "openai-responses",
      baseUrl: `http://127.0.0.1:${port}/openai/v1`,
    };
  }

  // All other providers (DeepSeek, Qwen, Mistral, Kimi, MiniMax, NVIDIA, Gemma,
  // ZAI, Writer, openai.gpt-oss-*): use the OpenAI Chat Completions API.
  // pi's openai-completions driver calls {baseUrl}/chat/completions →
    //   http://localhost:57893/v1/chat/completions →
  //   https://bedrock-mantle.us-east-2.api.aws/v1/chat/completions ✓
  return {
    ...base,
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${port}/v1`,
  };
}

// ─── Live discovery ───────────────────────────────────────────────────────────

const REGIONS = ["us-east-1", "us-east-2"] as const;

async function fetchRegionModels(region: string): Promise<string[]> {
  const host = `bedrock-mantle.${region}.api.aws`;
  const signer = new SignatureV4({
    credentials: fromNodeProviderChain(),
    service: "bedrock",
    region,
    sha256: Sha256,
  });
  const signed = await signer.sign({
    method: "GET", protocol: "https:",
    hostname: host, path: "/v1/models",
    headers: { host }, body: "",
  });
  const res = await fetch(`https://${host}/v1/models`, { headers: signed.headers as Record<string, string> });
  if (!res.ok) throw new Error(`${region}: HTTP ${res.status}`);
  const data = (await res.json()) as { data: { id: string }[] };
  return data.data.map((m) => m.id);
}

export async function fetchModels(): Promise<PiModelConfig[]> {
  try {
    const results = await Promise.allSettled(REGIONS.map(fetchRegionModels));

    // Map model id → set of regions it's available in
    const modelRegions = new Map<string, Set<string>>();
    for (let i = 0; i < REGIONS.length; i++) {
      const result = results[i];
      if (result.status !== "fulfilled") continue;
      for (const id of result.value) {
        if (!modelRegions.has(id)) modelRegions.set(id, new Set());
        modelRegions.get(id)!.add(REGIONS[i]);
      }
    }

    if (modelRegions.size === 0) throw new Error("All regions failed");

    return Array.from(modelRegions.entries()).map(([id, regions]) =>
      buildConfig(id, regions)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[bedrock-mantle] Model discovery failed (${msg}) — using fallback list. ` +
      `Run 'ada credentials update' and restart pi to get the live list.`
    );
    return FALLBACK_MODELS;
  }
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

export const FALLBACK_MODELS: PiModelConfig[] = Object.keys(KNOWN).map((id) => {
  const regions = new Set(ANTHROPIC_IDS.has(id) ? ["us-east-1"] : ["us-east-2"]);
  return buildConfig(id, regions);
});
