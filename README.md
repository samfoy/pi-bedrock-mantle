# pi-bedrock-mantle

Pi extension: all [Amazon Bedrock Mantle](https://bedrock-mantle.us-east-2.api.aws) models (GPT-5.5, DeepSeek, Qwen3, Mistral, Kimi, and more) with **SigV4 auth** — no long-term API key needed.

## Why SigV4?

Bedrock-mantle accepts both a long-term `AWS_BEARER_TOKEN_BEDROCK` key *and* standard SigV4-signed requests. 

## Models

Dynamically discovered at startup from the live `/v1/models` endpoint. As of June 2026, includes:

- **OpenAI**: GPT-5.5, GPT-5.4 (+ dated variants), GPT-OSS 120B/20B
- **DeepSeek**: V3.1, V3.2
- **Qwen3**: 32B, 235B, Coder variants, VL (vision)
- **Mistral**: Magistral, Devstral, Ministral, Voxtral
- **Moonshot Kimi**: K2 Thinking, K2.5
- **MiniMax**: M2, M2.1, M2.5
- **NVIDIA**: Nemotron Nano, Nemotron Super
- **Google**: Gemma 3 (4B, 12B, 27B)
- **ZAI**: GLM-4.6, GLM-4.7, GLM-5
- **Writer**: Palmyra Vision 7B

Falls back to a curated static list if discovery fails (expired creds at startup).

## How it works

1. At startup, fetches the live model list from both `bedrock-mantle.us-east-1.api.aws/v1/models` and `bedrock-mantle.us-east-2.api.aws/v1/models` using SigV4, then merges the regional results.
2. Starts lightweight regional HTTP proxies on `localhost:57893` (us-east-2/CMH) and `localhost:57891` (us-east-1/IAD).
3. Pi sends inference requests to the regional proxy using the API driver selected per model:
   - Anthropic Claude → `anthropic-messages` via `/anthropic/v1/messages`
   - GPT-5.x → `openai-responses` via `/openai/v1/responses`
   - GPT OSS and other OpenAI-compatible models → `openai-completions` via `/v1/chat/completions`
4. The proxy SigV4-signs each request (via `fromNodeProviderChain` — picks up ada/env/config creds automatically) and forwards it to the matching Bedrock Mantle regional endpoint.
5. Streaming SSE responses are piped back to pi unchanged.

If multiple pi sessions are running, the first one starts the proxy; subsequent ones reuse it.

## Setup

### 1. Install

```bash
# Via pi (recommended)
pi install npm:pi-bedrock-mantle

# Or manually
npm install -g pi-bedrock-mantle
```

### 2. Register with pi

If installed via `pi install`, it's already active. Otherwise add to `~/.pi/settings.json`:

```json
{
  "packages": ["npm:pi-bedrock-mantle"]
}
```

### 3. Configure credentials

Add to `~/.aws/config`:

```ini
[profile bedrock-mantle]
region=us-east-2
output=json
credential_process=...
```

Add to shell init:

```bash
export BEDROCK_MANTLE_AWS_PROFILE=bedrock-mantle
```

> The `credential_process` auto-refreshes credentials on demand — no manual `ada credentials update` needed.

### 4. Use

Start pi and use `/model` → `bedrock-mantle` → pick a model.

Or launch directly:

```bash
pi --model bedrock-mantle/openai.gpt-5.5
```

## Credential options

The extension and proxy first honor `BEDROCK_MANTLE_AWS_PROFILE` via `fromIni({ profile })` (recommended, because other pi extensions may set `AWS_PROFILE`). If that is unset, they fall back to [`fromNodeProviderChain`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-credential-providers/), which tries:

1. `AWS_PROFILE` env var
2. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` env vars
3. `~/.aws/credentials` + `~/.aws/config`
4. EC2/ECS instance metadata

## Troubleshooting

**Models don't appear** — extension not loading. Check that the path in `settings.json` is correct and `npm install` has been run.

**`[bedrock-mantle] Model discovery failed`** — AWS creds unavailable at startup. Models fall back to a static list. 

**HTTP 401** — role doesn't have `bedrock-mantle:CreateInference`. Use a role with Bedrock access (e.g. `IibsAdminAccess-DO-NOT-DELETE` on your personal dev account).

**HTTP 403** — account not allowlisted for bedrock-mantle.

**Proxy port conflict** — if something else is on port 57893 or 57891, set `BEDROCK_MANTLE_PROXY_PORT_CMH` or `BEDROCK_MANTLE_PROXY_PORT_IAD` to another valid port.
