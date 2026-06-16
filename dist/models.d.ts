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
/**
 * Bound proxy ports for the two regions. Used both to construct per-model
 * baseUrls and to invalidate stale caches when the ports change between runs
 * (e.g. ephemeral ports change every restart, fixed ports stay stable).
 */
export interface ProxyPorts {
    /** us-east-2 (CMH) — GPT-5.x and shared OpenAI-style models. */
    cmh: number;
    /** us-east-1 (IAD) — Anthropic Claude. */
    iad: number;
}
export interface PiModelConfig {
    id: string;
    name: string;
    api?: string;
    baseUrl?: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
    thinkingLevelMap?: Partial<Record<string, string | null>>;
}
export declare function readCachedModels(ports: ProxyPorts, options?: {
    maxAgeMs?: number;
}): PiModelConfig[] | null;
export declare function writeCachedModels(models: PiModelConfig[]): void;
export declare function fastModels(ports: ProxyPorts): PiModelConfig[];
export declare function discoverModels(ports: ProxyPorts): Promise<PiModelConfig[]>;
export declare function fetchModels(ports: ProxyPorts): Promise<PiModelConfig[]>;
/**
 * Curated fallback list with port placeholders. Use `applyPorts` (or `fastModels`)
 * to substitute actual bound ports before passing to pi.
 */
export declare const FALLBACK_MODELS_RAW: PiModelConfig[];
/**
 * @deprecated Use `fastModels(ports)` or `applyPorts(FALLBACK_MODELS_RAW, ports)`.
 * Retained as the placeholder list for callers that don't have ports yet.
 */
export declare const FALLBACK_MODELS: PiModelConfig[];
