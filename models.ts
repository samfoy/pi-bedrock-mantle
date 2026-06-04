/**
 * Model spec registry for bedrock-mantle.
 *
 * Fetches the live model list from the bedrock-mantle /v1/models endpoint and
 * maps each model to a pi ProviderModelConfig. Falls back to a curated static
 * list when discovery fails (expired creds at startup, network error, etc.).
 */

import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

export interface ModelSpec {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

export interface PiModelConfig extends ModelSpec {
  id: string;
  name: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

// ─── Known specs ─────────────────────────────────────────────────────────────
// Verified values. Anything not in this table gets inferred heuristically.

const KNOWN: Record<string, ModelSpec> = {
  // OpenAI GPT-5 family — reasoning models, 272K context
  "openai.gpt-5.5":              { contextWindow: 272000, maxTokens: 128000, reasoning: true,  input: ["text", "image"], thinkingLevelMap: { minimal: "low" } },
  "openai.gpt-5.5-2026-04-23":   { contextWindow: 272000, maxTokens: 128000, reasoning: true,  input: ["text", "image"], thinkingLevelMap: { minimal: "low" } },
  "openai.gpt-5.4":              { contextWindow: 272000, maxTokens: 128000, reasoning: true,  input: ["text", "image"], thinkingLevelMap: { minimal: "low" } },
  "openai.gpt-5.4-2026-03-05":   { contextWindow: 272000, maxTokens: 128000, reasoning: true,  input: ["text", "image"], thinkingLevelMap: { minimal: "low" } },
  // OpenAI OSS variants (no reasoning)
  "openai.gpt-oss-120b":         { contextWindow: 128000, maxTokens: 16384,  reasoning: false, input: ["text"] },
  "openai.gpt-oss-20b":          { contextWindow: 128000, maxTokens: 16384,  reasoning: false, input: ["text"] },
  "openai.gpt-oss-safeguard-120b": { contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"] },
  "openai.gpt-oss-safeguard-20b":  { contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text"] },
  // DeepSeek
  "deepseek.v3.1":               { contextWindow: 163840, maxTokens: 32768,  reasoning: false, input: ["text"] },
  "deepseek.v3.2":               { contextWindow: 163840, maxTokens: 32768,  reasoning: false, input: ["text"] },
  // Moonshot Kimi
  "moonshotai.kimi-k2-thinking": { contextWindow: 128000, maxTokens: 32768,  reasoning: true,  input: ["text"] },
  "moonshotai.kimi-k2.5":        { contextWindow: 128000, maxTokens: 32768,  reasoning: true,  input: ["text"] },
  // MiniMax
  "minimax.minimax-m2":          { contextWindow: 1000000, maxTokens: 65536, reasoning: false, input: ["text", "image"] },
  "minimax.minimax-m2.1":        { contextWindow: 1000000, maxTokens: 65536, reasoning: false, input: ["text", "image"] },
  "minimax.minimax-m2.5":        { contextWindow: 1000000, maxTokens: 65536, reasoning: false, input: ["text", "image"] },
  // Qwen3 variants
  "qwen.qwen3-32b":              { contextWindow: 131072, maxTokens: 32768,  reasoning: true,  input: ["text"] },
  "qwen.qwen3-235b-a22b-2507":   { contextWindow: 131072, maxTokens: 32768,  reasoning: true,  input: ["text"] },
  "qwen.qwen3-coder-30b-a3b-instruct":  { contextWindow: 131072, maxTokens: 32768, reasoning: true, input: ["text"] },
  "qwen.qwen3-coder-480b-a35b-instruct": { contextWindow: 131072, maxTokens: 32768, reasoning: true, input: ["text"] },
  "qwen.qwen3-coder-next":       { contextWindow: 131072, maxTokens: 32768,  reasoning: true,  input: ["text"] },
  "qwen.qwen3-next-80b-a3b-instruct": { contextWindow: 131072, maxTokens: 32768, reasoning: true, input: ["text"] },
  "qwen.qwen3-vl-235b-a22b-instruct": { contextWindow: 131072, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
};

// ─── Heuristics for unknown models ───────────────────────────────────────────

function inferSpec(id: string): ModelSpec {
  const reasoning =
    id.includes("gpt-5") ||
    id.includes("thinking") ||
    id.includes("kimi-k2") ||
    id.includes("qwq") ||
    id.includes("o1") ||
    id.includes("o3") ||
    id.includes("r1");

  const hasVision =
    id.includes("vision") ||
    id.includes("-vl-") ||
    id.includes("gemma") ||
    id.includes("gpt-5") ||
    id.includes("palmyra");

  return {
    contextWindow: 128000,
    maxTokens: 16384,
    reasoning,
    input: hasVision ? ["text", "image"] : ["text"],
    thinkingLevelMap: reasoning ? { minimal: "low" } : undefined,
  };
}

// ─── Display name formatting ──────────────────────────────────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  openai:      "OpenAI",
  deepseek:    "DeepSeek",
  qwen:        "Qwen",
  mistral:     "Mistral",
  google:      "Google",
  nvidia:      "NVIDIA",
  moonshotai:  "Moonshot AI",
  minimax:     "MiniMax",
  zai:         "ZAI",
  writer:      "Writer",
};

function modelDisplayName(id: string): string {
  const dot = id.indexOf(".");
  if (dot === -1) return `${id} (Bedrock)`;
  const provider = id.slice(0, dot);
  const model = id.slice(dot + 1);
  const label = PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
  // "gpt-5.5" → "GPT-5.5", "qwen3-32b" → "Qwen3 32B"
  const formatted = model
    .replace(/gpt-(\S+)/, (_, v) => `GPT-${v}`)
    .replace(/[-_]/g, " ")
    .replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
  return `${label} ${formatted} (Bedrock)`;
}

// ─── Model config builder ─────────────────────────────────────────────────────

function toConfig(id: string): PiModelConfig {
  const spec = KNOWN[id] ?? inferSpec(id);
  return {
    id,
    name: modelDisplayName(id),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...spec,
  };
}

// ─── Live model discovery ─────────────────────────────────────────────────────

const MODELS_URL = "https://bedrock-mantle.us-east-2.api.aws/v1/models";

export async function fetchModels(): Promise<PiModelConfig[]> {
  try {
    const signer = new SignatureV4({
      credentials: fromNodeProviderChain(),
      service: "bedrock",
      region: "us-east-2",
      sha256: Sha256,
    });

    const url = new URL(MODELS_URL);
    const signed = await signer.sign({
      method: "GET",
      protocol: "https:",
      hostname: url.hostname,
      path: url.pathname,
      headers: { host: url.hostname },
      body: "",
    });

    const res = await fetch(MODELS_URL, {
      headers: signed.headers as Record<string, string>,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = (await res.json()) as { data: { id: string }[] };
    return payload.data.map((m) => toConfig(m.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[bedrock-mantle] Model discovery failed (${msg}) — using fallback list. ` +
      `Run 'ada credentials update' and restart pi to get the live list.`
    );
    return FALLBACK_MODELS;
  }
}

// ─── Fallback (used when discovery fails) ────────────────────────────────────

export const FALLBACK_MODELS: PiModelConfig[] = Object.keys(KNOWN).map(toConfig);
