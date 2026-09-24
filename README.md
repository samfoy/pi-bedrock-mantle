# pi-bedrock-mantle

Pi extension: all [Amazon Bedrock Mantle](https://bedrock-mantle.us-east-2.api.aws) models (GPT-5.x, Claude, DeepSeek, Qwen3, Mistral, Kimi, and more) with **SigV4 auth** — no long-term API key needed.

## Why SigV4?

Bedrock-mantle accepts both a long-term `AWS_BEARER_TOKEN_BEDROCK` key *and* standard SigV4-signed requests. This extension signs with SigV4, so it works with the short-lived AWS credentials you already use (SSO, `credential_process`, instance or container roles), and you never create, store or rotate a long-term API key.

## Models

Dynamically discovered when a session starts, from the live `/v1/models` endpoint in both regions. Models seen so far include:

- **OpenAI**: GPT-5.6 Luna/Sol/Terra (1M context), GPT-5.5, GPT-5.4 (+ dated variants), GPT-OSS 120B/20B, GPT-OSS Safeguard 120B/20B
- **Anthropic** (us-east-1): Claude Opus 4.8, Claude Opus 4.7, Claude Haiku 4.5
- **DeepSeek**: V3.1, V3.2
- **Qwen3**: 32B, 235B, Coder variants, VL (vision)
- **Mistral**: Magistral, Devstral, Ministral, Voxtral
- **Moonshot Kimi**: K2 Thinking, K2.5
- **MiniMax**: M2, M2.1, M2.5
- **NVIDIA**: Nemotron Nano, Nemotron Super
- **Google**: Gemma 3 (4B, 12B, 27B)
- **ZAI**: GLM-4.6, GLM-4.7, GLM-5
- **Writer**: Palmyra Vision 7B

Falls back to the curated static list in `models.ts` if discovery fails (expired creds at startup). The last successful discovery is cached in `${XDG_CACHE_HOME:-~/.cache}/pi-bedrock-mantle/models.json` (override the path with `BEDROCK_MANTLE_MODEL_CACHE`) and used on the next start while discovery refreshes in the background. A cached entry whose `baseUrl` is not one of the extension's own loopback proxy routes is rejected, and the whole cache falls back to the curated list. With neither `HOME` nor `XDG_CACHE_HOME` set, caching is skipped.

## How it works

1. When a pi session starts, the extension binds two **loopback proxies on ephemeral ports** (one for each region: us-east-2/CMH, us-east-1/IAD) and closes them when the session ends (`/new`, `/resume`, `/fork`, `/reload` or quit). Each session owns its own proxies — no singleton state shared across processes, no port conflicts, no stale credentials surviving across long-lived consumers.
2. The proxies sign every inbound request with SigV4 (see [Credentials](#credentials)) and forward it to `bedrock-mantle.us-east-{1,2}.api.aws`.
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

# Or straight from GitHub
pi install git:github.com/samfoy/pi-bedrock-mantle

# Or manually
npm install -g pi-bedrock-mantle
```

### 2. Register with pi

If installed via `pi install`, it's already active. Otherwise add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-bedrock-mantle"]
}
```

### 3. Point it at credentials

The extension signs with credentials you already have; it does not create them. The usual setup is a dedicated profile:

```bash
export BEDROCK_MANTLE_AWS_PROFILE=bedrock-mantle
```

See [Credentials](#credentials) for the profile types that work and for the default chain used when the variable is unset.

### 4. Use

Start pi and use `/model` → `bedrock-mantle` → pick a model.

Or launch directly:

```bash
pi --model bedrock-mantle/openai.gpt-5.5
```

## Credentials

The extension does **not** vend credentials. It signs each request with AWS
credentials that already exist on your machine, so you must point it at a
source that yields them. The identity needs Bedrock Mantle inference access
(see [Troubleshooting](#troubleshooting) for 401 and 403).

### A dedicated profile (recommended)

Set `BEDROCK_MANTLE_AWS_PROFILE` to a profile name. The extension resolves it
with the AWS SDK's `fromIni`, which reads `~/.aws/config` and
`~/.aws/credentials` and supports static keys, `credential_process`, IAM
Identity Center (SSO) profiles, and role assumption (`role_arn` with
`source_profile`). A dedicated variable also means another pi extension that
changes `AWS_PROFILE` cannot redirect signing.

For example, a profile backed by `credential_process`, which runs a command
that prints credentials:

```ini
# ~/.aws/config
[profile bedrock-mantle]
credential_process = /usr/local/bin/print-aws-credentials
```

```bash
export BEDROCK_MANTLE_AWS_PROFILE=bedrock-mantle
```

The command must be non-interactive and print JSON in the
[`credential_process` format](https://docs.aws.amazon.com/sdkref/latest/guide/feature-process-credentials.html)
to stdout:

```json
{
  "Version": 1,
  "AccessKeyId": "AKIAIOSFODNN7EXAMPLE",
  "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "SessionToken": "example-session-token",
  "Expiration": "2026-09-24T18:00:00Z"
}
```

`SessionToken` and `Expiration` are optional; leave both out for long-lived
keys. Credentials are currently resolved for every request, so the command
runs once per model call (see *Known issues* in the
[CHANGELOG](https://github.com/samfoy/pi-bedrock-mantle/blob/main/CHANGELOG.md)).
Keep it fast, and cache inside the helper if fetching is slow.

An SSO profile needs a live login first (`aws sso login --profile <name>`):
the extension reads the cached SSO token and cannot open a browser.

### The default credential chain

With `BEDROCK_MANTLE_AWS_PROFILE` unset, the extension uses the Node default
chain from the AWS SDK for JavaScript
([`@aws-sdk/credential-provider-node`](https://github.com/aws/aws-sdk-js-v3/tree/main/packages-internal/credential-provider-node)
`defaultProvider`) and takes the first source that yields credentials:

1. **Environment keys**: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
   (plus `AWS_SESSION_TOKEN`). Skipped when `AWS_PROFILE` is set.
2. **Shared config and credentials files**: the profile named by
   `AWS_PROFILE`, or `default`. Every profile type listed above works here,
   including `credential_process` and SSO.
3. **`credential_process`** of that profile, through the standalone process
   provider.
4. **Web-identity token file**: `AWS_WEB_IDENTITY_TOKEN_FILE` with
   `AWS_ROLE_ARN`.
5. **Container or instance metadata**: ECS container credentials
   (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` or `_FULL_URI`), otherwise EC2
   instance metadata unless `AWS_EC2_METADATA_DISABLED=true`.

### Regions are fixed

The region comes from the model family, not from your configuration:

| Models | Region | Endpoint |
|---|---|---|
| GPT-5.x, GPT-OSS and the other shared models | us-east-2 | `bedrock-mantle.us-east-2.api.aws` |
| Anthropic Claude | us-east-1 | `bedrock-mantle.us-east-1.api.aws` |

A non-Claude model that discovery finds only in us-east-1 is sent there.
`AWS_REGION`, `AWS_DEFAULT_REGION` and a profile's `region` setting are
ignored for routing and signing, so the profile does not need one.

## Troubleshooting

**Models don't appear** — extension not loading. Check that the path in `settings.json` is correct and `npm install` has been run.

**`[bedrock-mantle] level=warn kind=discovery_failed`** — the model list could not be fetched at startup. The `error` field names each region's cause: a credential error, `HTTP 401` or `HTTP 403` (below). Models fall back to the cached or curated static list.

The proxy passes Bedrock Mantle's status and error body through to pi unchanged, and logs each failure as `level=warn kind=request ... status=<code>`.

**HTTP 401** — the credentials were not accepted: they are invalid or expired, or the request was unsigned or malformed. Refresh them (for example `aws sso login`, or whatever feeds your `credential_process`) and check that `BEDROCK_MANTLE_AWS_PROFILE` names the profile you expect. Credentials are resolved on every request, so the next prompt picks up new ones without restarting pi.

**HTTP 403 or `AccessDenied`** — the credentials are valid, but the identity lacks permission: its policy does not allow `bedrock-mantle:CreateInference` (the AWS managed policy `AmazonBedrockMantleInferenceAccess` grants it), or the account has no access to that model. Use a role whose policy grants Bedrock Mantle inference.

**HTTP 500 with `"type":"proxy_error"`** — the request never reached Bedrock Mantle. The proxy could not sign or send it, usually because no credentials could be resolved (for example `Could not resolve credentials using profile`, or an expired SSO session). The message names the cause, and the log line is `level=error kind=request_failed`.

**Proxy port conflict** — by default, each pi process binds its own ephemeral ports, so port conflicts are impossible. If you've explicitly pinned `BEDROCK_MANTLE_PROXY_PORT_CMH` or `BEDROCK_MANTLE_PROXY_PORT_IAD` to a fixed value (e.g. for an external consumer that needs a stable URL), and that port is taken, change the value or unset the env var to fall back to ephemeral.

## Logging

The extension logs to stderr with a leveled, key=value format:

```
[bedrock-mantle] level=info kind=ready cmh_port=54321 iad_port=54322 profile=bedrock-mantle
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

### Durable log file (`BEDROCK_MANTLE_LOG_FILE`)

Stderr is ephemeral when pi runs over RPC (e.g. under pi-dashboard, where a
parent process consumes the child's stderr and it never reaches disk). To
capture log lines durably, set `BEDROCK_MANTLE_LOG_FILE` to a path:

```
BEDROCK_MANTLE_LOG_FILE=~/.pi/logs/bedrock-mantle.log
```

Every line that passes the `BEDROCK_MANTLE_LOG` level filter is appended to the
file in addition to stderr (parent directories are created automatically).
This is the reliable way to audit `kind=empty_completion` and
`kind=empty_completion_retry` events after the fact:

```
grep empty_completion ~/.pi/logs/bedrock-mantle.log
```

If the file can't be written, the sink disables itself after one warning and
stderr logging continues unaffected.

### Empty-completion detection

GPT-5.x via the OpenAI Responses API has a measured ~10–20% stochastic
failure rate on tool-using requests — the model returns zero output items
with `output_tokens: 0` and `stop_reason: "completed"`. The same exact
request succeeds 80–90% of the time and produces nothing the rest. To pi
(and any agent loop) this looks like a clean "done" with nothing to
render, and the slot exits silently mid-turn. Forensics:
[`forensics-2026-06-07/findings.md`](https://github.com/samfoy/pi-bedrock-mantle/blob/main/forensics-2026-06-07/findings.md).

The proxy detects this pattern on `/openai/v1/responses` SSE streams without
modifying the response. When detected, it emits a warn-level log line
correlated to the request id:

```
[bedrock-mantle] level=warn kind=empty_completion id=Az3kP9 region=us-east-2
  model=openai.gpt-5.5 output_tokens=0 reasoning_tokens=0
  output_item_types= stop_reason=completed
  hint="model returned no message content after tool use; lower reasoning effort or raise max_output_tokens"
```

The upstream bytes are passed to the client unchanged — detection is
observability only, never a transformation. Pi (or operators reading the
log) can decide whether to retry, surface the error to the user, or adjust
the reasoning-effort knob.

### Empty-completion retry (streaming-preserving, on by default)

The proxy retries a `/openai/v1/responses` request once when the first attempt
is an empty completion (or a transient `response.failed`). Empirically takes the
user-visible empty rate from ~10–20% to ~1–2%. One retry max — no infinite loop.

Three modes, via `BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY`:

| Value | Mode | Streaming? | Retry? |
|-------|------|-----------|--------|
| unset / `stream` / `1` / `on` | **stream (default)** | ✅ live | ✅ empty + transient-fail, *before* any content |
| `buffer` / `full` | buffer | ❌ one burst | ✅ empty + transient-fail, even after a complete function_call |
| `0` / `false` / `off` | off | ✅ live | ❌ |

**stream mode (default)** holds back only the head events (`response.created`,
`response.in_progress`, and any leading `reasoning` item — a few hundred bytes).
The instant the turn commits to actionable output (a `message` item, any
`*_call`, or a text/argument delta), it flushes the head and streams the rest
live. An empty completion never emits an actionable event, so it's caught with
nothing sent to the client and retried. Measured on gpt-5.5: first-byte ~2s with
tokens streaming over wall-clock, vs. buffer mode's ~15s stall-then-burst for
the same response.

**buffer mode** buffers the entire SSE end-to-end before forwarding (pi sees a
single burst). Slightly more robust: it can also retry a transient
`response.failed` that arrives *after* a complete function_call, which stream
mode cannot (those bytes are already sent). Use it only if you'd rather have max
reliability than streaming.

**Tradeoff of stream mode:** a transient `response.failed` that surfaces *after*
content has already streamed can't be retried (the client has the bytes). Empty
completions are always recoverable since they emit no content. Switch to
`buffer` if you hit frequent post-content transient failures.

Log lines on retry (both modes):

```
[bedrock-mantle] level=warn kind=empty_completion_retry id=… attempt=1 action=retrying
[bedrock-mantle] level=info kind=empty_completion_retry id=… attempt=2 outcome=recovered
[bedrock-mantle] level=warn kind=empty_completion_retry id=… attempt=2 outcome=still_empty   # rare
```

### Capturing empty-completion variants (`BEDROCK_MANTLE_EMPTY_DUMP_DIR`)

> **Warning:** a dump contains the **full prompt**: the system prompt, every message, tool
> output, and anything a memory or context extension injected. Never point
> `BEDROCK_MANTLE_EMPTY_DUMP_DIR` inside a git repository or any other
> directory that gets shared, synced or committed. Leave it unset unless you
> are actively debugging, and delete the dumps when you are done.

Not every empty manifests as a `response.completed` with empty output. Two
other shapes are passed through (not retried) but **captured** for forensics
when `BEDROCK_MANTLE_EMPTY_DUMP_DIR` is set:

- **`no_terminal`** — a buffered openai-responses SSE stream that closed with
  no parseable `response.completed` event (logged `kind=empty_completion_no_terminal`).
- **`non_sse`** — a 200 reply that wasn't `text/event-stream` at all (logged
  `kind=empty_completion_non_sse`).

```
BEDROCK_MANTLE_EMPTY_DUMP_DIR=~/.pi/logs/empty-dumps
```

The path must be absolute or start with `~/` (a leading `~` expands to your
home directory). A relative path would land under the working directory,
usually a project repository, so it turns dumps off and logs one
`kind=empty_dump_dir_rejected` warning. Each capture writes
`<dir>/<label>-<requestId>.json` with the full request body and raw response
bytes, so the exact shape can be analysed before extending retry to cover it.
Files are created with mode `0600`, and a directory the extension creates gets
`0700`. Detected empties (`kind=empty_completion`) are also dumped here.
Errors (4xx/5xx) are never dumped.

### Transient `response.failed` retry

gpt-5.x on Bedrock intermittently ends an openai-responses stream with a
terminal `response.failed` event carrying a server-side error code (e.g.
`server_error`) — a 5xx surfaced as an SSE event mid-stream, sometimes *after*
emitting a complete `function_call`. pi sees no `response.completed` and
reports "Provider returned an empty stream".

The same buffer-and-retry layer now treats this as retryable: a terminal
`response.failed` whose error code is transient (`server_error`,
`internal_error`, `service_unavailable`, `server_overloaded`,
`overloaded_error`, `gateway_timeout`, `bad_gateway`, `timeout`, or no code)
is re-issued once. So is a client-looking code whose message names a Bedrock
routing failure ("Engine not found", "Engine bad request", "Job registration
failed", seen on gpt-5.4 as `invalid_prompt`). Other client-side failures
(`invalid_request_error`, content filter, …) pass through untouched.
`rate_limit_exceeded` is not retried, because an immediate retry without
backoff rarely helps. Logged as `kind=upstream_failed_retry`:

```
[bedrock-mantle] level=warn kind=upstream_failed_retry id=… error_code=server_error attempt=1 action=retrying
[bedrock-mantle] level=info kind=upstream_failed_retry id=… attempt=2 outcome=recovered
[bedrock-mantle] level=warn kind=upstream_failed_retry id=… attempt=2 outcome=still_failed   # rare
```
