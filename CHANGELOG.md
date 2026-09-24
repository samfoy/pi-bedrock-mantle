# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-09-24

Everything since 1.0.2, the last version on npm (2026-06-04). GitHub `main`
had moved well past it without a release.

**Breaking:** the minimum pi is now 0.81.0. On older pi the extension
registers no models and prints one line naming the running pi version; stay
on `pi install npm:pi-bedrock-mantle@1.0.2` there.

### Added

- GPT-5.6 model metadata: `openai.gpt-5.6-luna`, `openai.gpt-5.6-sol` and
  `openai.gpt-5.6-terra` route through the Responses API with a 1M context
  window (#1).
- Empty-completion retry for `/openai/v1/responses`, on by default.
  `BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY` picks the mode:
  - `stream` (default): holds back only the head events and streams live as
    soon as the turn commits to actionable output. An empty completion is
    caught before anything reaches the client and retried once.
  - `buffer` / `full`: buffers the whole SSE response, which can also retry a
    transient failure that arrives after a complete `function_call`.
  - `0` / `false` / `off`: pass-through, no retry.
- One retry of a terminal `response.failed` with a transient error code
  (`server_error`, `internal_error`, `service_unavailable`, `server_overloaded`,
  `overloaded_error`, `gateway_timeout`, `bad_gateway`, `timeout`, or no code),
  and of `invalid_prompt` failures whose message names a Bedrock routing error
  ("Engine not found", "Engine bad request", "Job registration failed").
- Empty-completion detection on openai-responses SSE streams, logged as
  `kind=empty_completion`. A turn counts as empty when it has no visible
  message text and no tool call, whatever its token count.
- Leveled structured logging to stderr (`BEDROCK_MANTLE_LOG`), with an
  `x-bedrock-mantle-request-id` response header that matches each log line,
  and an optional durable log file (`BEDROCK_MANTLE_LOG_FILE`).
- Forensic capture (`BEDROCK_MANTLE_EMPTY_DUMP_DIR`) of empty completions,
  streams with no terminal event, non-SSE 200 replies, and requests a retry
  did not recover.

### Changed

- Faster startup: the provider registers at once from a cached or curated
  model list, and live `/v1/models` discovery refreshes it in the background.
  The cache lives in `${XDG_CACHE_HOME:-~/.cache}/pi-bedrock-mantle/models.json`
  (`BEDROCK_MANTLE_MODEL_CACHE` overrides it).
- Each pi session now binds its own loopback proxies on ephemeral ports instead
  of sharing a singleton on fixed ports 57893/57891, so stale credentials no
  longer survive across long-lived consumers. The proxies are bound on
  `session_start` and closed on `session_shutdown`, as pi's extension
  lifecycle requires; the provider is registered from the factory with a
  placeholder port and re-registered with the bound ports. Every request
  re-resolves the live port, so a model object pi captured earlier still
  reaches the current proxies.
  `BEDROCK_MANTLE_PROXY_PORT_CMH` and `BEDROCK_MANTLE_PROXY_PORT_IAD` still pin
  a port.
- README: one Credentials section. The extension does not vend credentials;
  it documents `BEDROCK_MANTLE_AWS_PROFILE` (static keys, `credential_process`,
  SSO), the Node default chain in its real order, and that regions are fixed
  per model family (`AWS_REGION` and a profile's `region` are ignored).
- The package ships compiled JavaScript: the pi manifest points at
  `./dist/index.js` (1.0.2 shipped `./index.ts`). `dist/` is committed so
  `pi install git:github.com/samfoy/pi-bedrock-mantle` works without a build.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` are optional
  `>=0.81.0` peer dependencies, supplied by pi when it loads the extension. The
  provider is now a complete pi-ai provider (`createProvider`) that delegates
  to pi's Anthropic Messages, OpenAI Responses and OpenAI Chat Completions
  implementations.
- Package metadata: the `pi-package` keyword (lists the package in the pi
  package gallery), `engines.node >=22.19.0`, `homepage`, `bugs`, and the
  author and LICENSE holder corrected to Sam Painter.
- The repository commits `package-lock.json` and runs CI plus npm trusted
  publishing from GitHub Actions.

### Fixed

- Images sent by pi's openai-responses driver as `image_url` data URLs are
  rewritten to Bedrock's `source` blocks. Bedrock rejected them with HTTP 400
  before.
- A model discovered only in us-east-1 that is not Anthropic (for example a
  GPT-OSS model) keeps its us-east-1 route after the model cache is read back.
  The startup cache, new in this release, used to send it to us-east-2.
- The test suite no longer writes to a `BEDROCK_MANTLE_LOG_FILE` or
  `BEDROCK_MANTLE_EMPTY_DUMP_DIR` exported in the caller's shell.
- The tests no longer depend on ambient AWS credentials. Only some tests set
  fake keys, so the rest failed in CI with `CredentialsProviderError` and passed
  locally only against a developer's `~/.aws` profile. Every test now runs with
  fake static keys, nonexistent shared config files and IMDS off, and fails if
  it dials a non-loopback host.

Found in review before release:

- The per-process proxies leaked two listening sockets on every `/new`,
  `/resume`, `/fork` and `/reload`, because they were bound in the extension
  factory and never closed. They now follow the session lifecycle, and a
  regression test drives pi's session runtime through four sessions and checks
  that the listener count returns to its baseline.
- `BEDROCK_MANTLE_EMPTY_DUMP_DIR` expands a leading `~`. It used to be taken
  literally, so the README's own example wrote dumps into a `./~` directory
  inside the current project.
- `SigningProxy.close()` also drops open connections, so a keep-alive socket
  cannot stall pi's awaited `session_shutdown`.
- Cycling to a mantle model with Ctrl+P (the scoped models from
  `enabledModels` or `--models`) always failed with "Connection error". pi
  refreshes only the selected model when a provider re-registers, so the
  scoped copies kept the placeholder port 0, and a copy captured before a
  `/reload` kept the closed proxy's port. The provider's request path now
  moves a baseUrl on the extension's own proxy (the placeholder port 0, or a
  port one of its proxies bound in this process) to the live proxy of the
  model's region, and fails with a clear error when no proxy is running. Any
  other URL, such as a `models.json` model on another local server, is sent
  as configured. Regression tests drive
  pi's SDK through the cycle, and through `/reload`, against a loopback mock
  of Bedrock Mantle.
- When pi ran as an SDK embed, every request with a body failed with "fetch
  failed". Importing pi's SDK installs its undici 8 dispatcher, which rejects
  the second `Content-Length` Node's built-in fetch adds next to the proxy's
  own. The proxy still signs `Content-Length` but leaves the header to fetch;
  the pi CLI was not affected.
- The proxy signed the request body decoded as UTF-8 but sent the raw bytes,
  so a body holding bytes that are not valid UTF-8 was sent with a signature
  over different bytes. It now signs the exact Buffer it sends.
- README troubleshooting described HTTP 401 as a missing permission and HTTP
  403 as an allowlist problem. 401 means the credentials were not accepted
  (invalid, expired, unsigned or malformed), 403 or `AccessDenied` means valid
  credentials without the permission, and a `proxy_error` 500 means the proxy
  could not sign or send the request, usually because no credentials could be
  resolved.

### Security

- Forensic dumps hold the full prompt (system prompt, messages, tool output,
  injected memory). Dump files are now written `0600` and a dump directory
  the extension creates is `0700`, and the README warns never to point
  `BEDROCK_MANTLE_EMPTY_DUMP_DIR` inside a git repository.
- A relative `BEDROCK_MANTLE_EMPTY_DUMP_DIR` is rejected: it would resolve
  against the working directory, usually a project repository. Dumps stay off
  and one `kind=empty_dump_dir_rejected` warning is logged. An absolute path
  or one starting with `~/` works as before.
- The model cache only accepts a `baseUrl` on the extension's own loopback
  proxy (`http://127.0.0.1:` plus a port placeholder and a known route). Any
  other value rejects the cache and the curated list is used, so a tampered
  cache cannot send prompts to another host. The cache schema moves to version
  3, which discards caches written before this check existed.
- With neither `HOME` nor `XDG_CACHE_HOME` set (and no
  `BEDROCK_MANTLE_MODEL_CACHE`), the model cache is skipped instead of being
  kept in a shared `tmpdir()/.cache`.

### Removed

- The root-level `scripts-bm-*.mjs` debug probes. They defaulted to a personal
  AWS profile and read dump files that no longer exist; they never shipped in
  the npm package.
- Private session ids and workspace names from the forensics notes, and another
  extension's profile name from a source comment.

### Known issues

- Stream-mode retry ignores client cancel. The managed `ReadableStream` in
  `fetchWithStreamingRetry` has no `cancel` handler, so when pi aborts a turn
  the proxy keeps reading the upstream response, and can still issue the
  retry, until upstream finishes.
- The held-back head scan is O(n²). Until a turn commits to actionable
  output, every chunk rescans the whole held buffer from the start. That is
  cheap for the usual few-hundred-byte head, but quadratic when a long
  reasoning prefix is held back.
- Credentials resolve through a new `fromIni` (or default-chain) provider on
  every request, with no memoisation across requests. A `credential_process`
  helper therefore runs once per model call, and discovery runs it once per
  region.

## [1.0.2] - 2026-06-04

- Full `thinkingLevelMap` for Claude and GPT-5 models.
- Claude Opus 4.7 and 4.8 advertise a 1M context window.
- Credentials resolve per request, from `BEDROCK_MANTLE_AWS_PROFILE` via
  `fromIni` when it is set, so another extension changing `AWS_PROFILE` no
  longer redirects signing.
- Tests that lock model routing.

## [1.0.1] - 2026-06-04

- Repository URL and README fixes.

## [1.0.0] - 2026-06-04

- Initial release: a `bedrock-mantle` provider with SigV4 signing, dynamic
  model discovery in us-east-1 and us-east-2, and Anthropic models via
  us-east-1. GPT-5.x uses the openai-responses API, everything else
  openai-completions. Proxy ports are configurable.
