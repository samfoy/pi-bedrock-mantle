# pi-bedrock-mantle

Pi extension: all [Amazon Bedrock Mantle](https://bedrock-mantle.us-east-2.api.aws) models (GPT-5.5, DeepSeek, Qwen3, Mistral, Kimi, and more) with **SigV4 auth** — no long-term API key needed.

## Why SigV4?

Bedrock-mantle accepts both a long-term `AWS_BEARER_TOKEN_BEDROCK` key *and* standard SigV4-signed requests. SigV4 uses IAM/STS credentials — the same ones `ada`/Isengard already provides on Amazon developer machines. No extra key to provision, rotate, or store.

Credit to [Mikey O'Brien](https://github.com/mikeyobrien) for confirming SigV4 works against bedrock-mantle.

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

1. At startup, fetches the live model list from `bedrock-mantle.us-east-2.api.aws/v1/models` using SigV4.
2. Starts a lightweight HTTP proxy on `localhost:57893`.
3. Pi's built-in `openai-responses` driver sends inference requests to the proxy.
4. The proxy SigV4-signs each request (via `fromNodeProviderChain` — picks up ada/env/config creds automatically) and forwards to `bedrock-mantle.us-east-2.api.aws/openai/v1/responses`.
5. Streaming SSE responses are piped back to pi unchanged.

If multiple pi sessions are running, the first one starts the proxy; subsequent ones reuse it.

## Setup

### 1. Install

```bash
git clone <this-repo> ~/path/to/pi-bedrock-mantle
cd ~/path/to/pi-bedrock-mantle
npm install
```

### 2. Register with pi

Add to `~/.pi/settings.json`:

```json
{
  "packages": [
    "/path/to/pi-bedrock-mantle"
  ]
}
```

### 3. Configure credentials

Add to `~/.aws/config`:

```ini
[profile bedrock-mantle]
region=us-east-2
output=json
credential_process=timeout 10 ada credentials print \
  --account=<your-account-id> \
  --provider=conduit \
  --role=IibsAdminAccess-DO-NOT-DELETE \
  --format=json
```

Add to `~/.zshrc`:

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

The proxy uses [`fromNodeProviderChain`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-credential-providers/) which tries these in order:

1. `BEDROCK_MANTLE_AWS_PROFILE` env var (explicit override — recommended)
2. `AWS_PROFILE` env var
3. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` env vars
4. `~/.aws/credentials` + `~/.aws/config`
5. EC2/ECS instance metadata

## Troubleshooting

**Models don't appear** — extension not loading. Check that the path in `settings.json` is correct and `npm install` has been run.

**`[bedrock-mantle] Model discovery failed`** — AWS creds unavailable at startup. Models fall back to a static list. Run `ada credentials update` and restart pi to get the live list.

**HTTP 401** — role doesn't have `bedrock-mantle:CreateInference`. Use a role with Bedrock access (e.g. `IibsAdminAccess-DO-NOT-DELETE` on your personal dev account).

**HTTP 403** — account not allowlisted for bedrock-mantle. Your personal dev account should work.

**HTTP 400 on reasoning models** — GPT-5.x rejects effort `"minimal"`. This is handled automatically via `thinkingLevelMap: { minimal: "low" }`.

**Proxy port conflict** — if something else is on port 57893, change `PROXY_PORT` in `proxy.ts`.
