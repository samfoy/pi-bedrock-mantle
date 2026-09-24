# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0] - unreleased

Everything since 1.0.2, the last version on npm (2026-06-04). GitHub `main`
had moved well past it without a release.

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
- Each pi process now binds its own loopback proxies on ephemeral ports instead
  of sharing a singleton on fixed ports 57893/57891, so stale credentials no
  longer survive across long-lived consumers. `BEDROCK_MANTLE_PROXY_PORT_CMH`
  and `BEDROCK_MANTLE_PROXY_PORT_IAD` still pin a port.
- The package ships compiled JavaScript: the pi manifest points at
  `./dist/index.js` (1.0.2 shipped `./index.ts`). `dist/` is committed so
  `pi install git:github.com/samfoy/pi-bedrock-mantle` works without a build.
- `@earendil-works/pi-coding-agent` is an optional `"*"` peer dependency. The
  extension only imports its types.
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
