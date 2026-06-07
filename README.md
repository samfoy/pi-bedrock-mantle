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

1. At startup, the extension binds two **per-process loopback proxies on ephemeral ports** (one for each region: us-east-2/CMH, us-east-1/IAD). Each pi process owns its own proxies — no singleton state shared across processes, no port conflicts, no stale credentials surviving across long-lived consumers.
2. The proxies sign every inbound request with SigV4 (using `BEDROCK_MANTLE_AWS_PROFILE` if set, else the default credential chain) and forward it to `bedrock-mantle.us-east-{1,2}.api.aws`.
3. Live model discovery runs in the background — `/v1/models` queried in both regions, results merged. While discovery runs, pi uses a cached or curated fallback list so startup never blocks.
4. Pi routes each model to the right driver based on the model id:
   - Anthropic Claude → `anthropic-messages` via `/anthropic/v1/messages`
   - GPT-5.x → `openai-responses` via `/openai/v1/responses`
   - GPT OSS and other OpenAI-compatible models → `openai-completions` via `/v1/chat/completions`
5. Streaming SSE responses are piped back to pi unchanged.

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

**Proxy port conflict** — by default, each pi process binds its own ephemeral ports, so port conflicts are impossible. If you've explicitly pinned `BEDROCK_MANTLE_PROXY_PORT_CMH` or `BEDROCK_MANTLE_PROXY_PORT_IAD` to a fixed value (e.g. for an external consumer that needs a stable URL), and that port is taken, change the value or unset the env var to fall back to ephemeral.

## Logging

The extension logs to stderr with a leveled, key=value format:

```
[bedrock-mantle] level=info kind=ready cmh_port=54321 iad_port=54322 profile=openclaw-bedrock
[bedrock-mantle] level=debug kind=request id=Az3kP9 region=us-east-2 method=POST path=/openai/v1/responses status=200 latency_ms=412 bytes_in=2851 bytes_out=18432
[bedrock-mantle] level=warn kind=request id=Bx7mQ2 region=us-east-1 status=403 latency_ms=98
```

Level is controlled by `BEDROCK_MANTLE_LOG`:

| Value | Behavior |
|---|---|
| `silent` / `off` / `none` | nothing |
| `error` | upstream/network failures only |
| `warn` | + non-2xx responses |
| `info` *(default)* | + startup, model discovery |
| `debug` | + per-request line for every call |

Every proxied response carries an `x-bedrock-mantle-request-id` header that
matches the `id=` field in the log line, so callers (pi, dashboards) can
correlate a user-visible failure to the matching server log.

### Empty-completion detection

GPT-5.x via the OpenAI Responses API can occasionally return zero visible
content after running tools — the model exhausts its output budget on hidden
reasoning and emits `output_tokens: 0` with `stop_reason: "stop"`. To pi (and
any agent loop) this looks like a clean "done" with nothing to render, and
the slot exits silently mid-turn.

The proxy detects this pattern on `/openai/v1/responses` SSE streams without
modifying the response. When detected, it emits a warn-level log line
correlated to the request id:

```
[bedrock-mantle] level=warn kind=empty_completion id=Az3kP9 region=us-east-2
  model=openai.gpt-5.5 output_tokens=0 reasoning_tokens=850
  output_item_types=reasoning stop_reason=completed
  hint="model returned no message content after tool use; lower reasoning effort or raise max_output_tokens"
```

The upstream bytes are passed to the client unchanged — detection is
observability only, never a transformation. Pi (or operators reading the
log) can decide whether to retry, surface the error to the user, or adjust
the reasoning-effort knob.
