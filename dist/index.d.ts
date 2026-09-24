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
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
/**
 * Why this pi cannot run the extension, or undefined when it can. pi 0.81.0
 * is the first to accept a createProvider() provider in registerProvider;
 * older pi drops every model of it.
 */
export declare function piVersionError(version: string | undefined): string | undefined;
export default function bedrockMantleExtension(pi: ExtensionAPI, piVersion?: string | undefined): Promise<void>;
