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
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function bedrockMantleExtension(pi: ExtensionAPI): Promise<void>;
