# Empty-completion forensics — 2026-06-07

## Question
Why does pi sometimes get an empty assistant turn from `bedrock-mantle/openai.gpt-5.5`
(via the OpenAI Responses API), with `output_tokens=0`, `reasoning_tokens=0`,
`output: []`, `status="completed"`, `error=null`, `incomplete_details=null`?

## TL;DR
**It's a stochastic gpt-5.5 model bug specific to tool-using turns on the
OpenAI Responses API.** The same exact request (same bytes, same SigV4
signature) produces a normal `function_call` 80–90% of the time and zero
output 10–20% of the time. The bug is not in pi, not in bedrock-mantle, not
in the request shape, not in credentials. **gpt-5.4 is unaffected.** The
practical mitigations are model swap or a retry-on-empty wrapper.

## Evidence

### 1. Direct minimal call works fine
A hand-crafted minimal request to `bedrock-mantle.us-east-2.api.aws/openai/v1/responses`
with no system prompt and no tools, asking gpt-5.5 to "Reply with the single
word: pong":

```
status=200 latency_ms=1111 output_tokens=16 reasoning_tokens=9
output items: [reasoning, message{ text: "pong" }]
```

Same request to gpt-5.4: `output_tokens=5, reasoning_tokens=0, text: "pong"`.

Conclusion: model + adapter + signing all work on minimal inputs.

### 2. Pi's actual request, replayed verbatim 10×
Captured pi's exact body (107,905 bytes, `model=openai.gpt-5.5`,
`reasoning.effort=medium`, 57 tools, 5 input messages: developer + 4 user
messages where the user question is at position 4 and a meta "knowledge
search overview" message is at position 5). Replayed it directly via SigV4,
non-streaming, 10 times:

```
attempt=1  output_items=2 types=reasoning,function_call  EMPTY=false
attempt=2  output_items=2 types=reasoning,function_call  EMPTY=false
attempt=3  output_items=2 types=reasoning,function_call  EMPTY=false
attempt=4  output_items=2 types=reasoning,function_call  EMPTY=false
attempt=5  output_items=0 types=<none>                    EMPTY=true   ← THE BUG
attempt=6  output_items=2 types=reasoning,function_call  EMPTY=false
attempt=7  output_items=2 types=reasoning,function_call  EMPTY=false
attempt=8  output_items=2 types=reasoning,function_call  EMPTY=false
attempt=9  output_items=2 types=reasoning,function_call  EMPTY=false
attempt=10 output_items=2 types=reasoning,function_call  EMPTY=false

→ 1/10 empty, 9/10 produced output
```

The same bytes, signed the same way, sometimes succeed, sometimes fail.

### 3. Variant sweep (10 attempts each)

| Variant                          | Empty rate |
|---------------------------------|------------|
| gpt-5.5 `effort=medium` (pi default) | 2/10 (20%) |
| gpt-5.5 `effort=minimal`             | **10/10 (100%)** |
| gpt-5.5 `effort=low`                 | 2/10 (20%) |
| gpt-5.5 `effort=high`                | 1/10 (10%) |
| **gpt-5.4 `effort=medium`**          | **0/10 (0%)** |
| gpt-5.5 no tools                     | killed (very slow without tools, no empty in first 1 attempt) |

Two findings:
- **`effort=minimal` is the worst possible setting for tool-using gpt-5.5.**
  The model lacks the reasoning headroom to plan a tool call and just gives up.
- **gpt-5.4 has 0% empty-completion rate** on the same prompt. The bug is
  specific to gpt-5.5.

## What this rules out

- ❌ Bedrock-mantle adapter — minimal requests work fine, replay reproduces stochasticity
- ❌ Pi's request shape — well-formed, accepted as 200, just 10–20% of the time gpt-5.5 emits nothing
- ❌ Singleton/stale state — fresh per-process proxy each run, still happens
- ❌ Credentials / signing — same request that empties also succeeds on retry
- ❌ Reasoning budget exhaustion — `reasoning_tokens=0` on the failing call, not "ran out", just "didn't try"
- ❌ Trailing user-role meta context being interpreted as "no answer needed" — was my
  initial hypothesis after eyeballing the request shape; replay disproves it
  because the same shape works 80–90% of the time
- ❌ Safety filter — `error=null`, `incomplete_details=null`

## What this leaves

A genuine stochastic failure in gpt-5.5's tool-call path on the OpenAI
Responses API surface, as exposed via Bedrock Mantle. Likely the same
behavior on first-party OpenAI; not tested. The model intends to emit a
tool call, the request goes through, and ~10–20% of the time it emits zero
items instead of the planned `function_call`.

## Recommended mitigations

1. **Default away from gpt-5.5 for tool-using flows.** Use gpt-5.4 (0% rate),
   Claude Sonnet/Opus, or anything else not in the 5.5 family. This is the
   highest-leverage change for users today.

2. **In bedrock-mantle: optional retry-on-empty for openai-responses paths.**
   The detector already fires; promote it from "log" to "retry once with
   the same request" when `BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY=1`. Single
   retry should bring the empty rate from ~10% to ~1%. Off by default
   because some legitimate flows might want empty completions.

3. **Never use `reasoning.effort=minimal` with gpt-5.5 + tools.** 100%
   failure rate. If pi or any consumer ever sets minimal, surface a warn.

4. **In pi (out of scope here): treat zero-output-item assistant turns as
   transient errors, not "agent done".** Currently pi exits the slot
   silently when this happens. A simple "retry once if last turn produced
   no message and no tool call" loop in pi's openai-responses driver would
   make this invisible to users.

## Followup: "first call seems worse" hypothesis (2026-06-07 evening)

User observation: empty completions feel concentrated on the first call of
a pi session. Tested five mutations of pi's captured first-call request,
30 attempts each, against `bedrock-mantle/openai.gpt-5.5`:

| Variant                                         | Empty rate | Wilson 95% CI |
|-------------------------------------------------|------------|---------------|
| V0 baseline (pi first-call shape)               | 3/30 = 10% | [3%, 26%]     |
| V1 user question moved to last input position   | 6/30 = 20% | [9%, 38%]     |
| V2 fake prior assistant turn (simulate 2nd call)| 2/30 = 7%  | [2%, 22%]     |
| V3 no `prompt_cache_key`                        | 4/30 = 13% | [5%, 30%]     |
| V4 drop trailing "knowledge-search overview" msg| 5/30 = 17% | [7%, 33%]     |

All CIs overlap heavily. **No structural mutation we can apply at the
request level eliminates or meaningfully reduces the bug.** Specifically
rejected as fixes:

- Reordering messages so the user question is last (V1 actually hurts on
  point estimate, though within noise)
- Adding a synthetic prior assistant turn to simulate continuity (V2 a
  weak hint of improvement, not significant)
- Cache-key state (V3 indistinguishable from baseline)
- Trailing meta-info messages (V4 indistinguishable)

**What's left for the "first call" perception:**

1. The 10–20% per-request rate is uniform across all calls. First-call
   empties just *look* worse — mid-session empties may retry naturally
   or look like agent thinking; a first-call empty leaves a dead slot.
2. Session-server state on Bedrock's side (KV cache / routing warmup
   *within* a single connection) could give a real first-call effect, but
   our independent-HTTP replays can't test that hypothesis. All our
   samples are first-call shaped.

Bottom line: there's no clever request-shape fix. Mitigation #2
(retry-on-empty in bedrock-mantle) is the right ship.

## Forensic artifacts
- `empty-Dq2O4ioeXlTD.json`, `empty-SgX04t2zwY3s.json` — captured request +
  response payloads from production pi runs that hit the bug
- `scripts-bm-direct.mjs` — sign + POST a hand-crafted body, no pi
- `scripts-bm-replay.mjs` — replay a captured request N times
- `scripts-bm-variants.mjs` — sweep model/effort variants of a captured request

## Followup: second empty variant — reasoning-burn with output_tokens > 0 (2026-06-08)

Confirmed live in session `019ea873` (Rosie workspace, gpt-5.5 on
openai-responses): gpt-5.5 made a tool call at 18:17:20, then the next turn
went idle (no message, no tool call). Sam manually swapped to
claude-opus-4-8 at 18:17:44 and re-prompted; Claude ran clean to completion.

**The first detector missed it.** The original verdict gated `empty` on
`usage.output_tokens === 0`. This variant burns reasoning tokens
(`output_tokens > 0`) while emitting zero *actionable* output items, so the
token gate said "not empty" and neither the passive detector nor the retry
fired — no `empty_completion` / `empty_completion_retry` line in the file
sink, despite the turn being dead to the agent loop.

Fix (commit `996dd16`): redefine empty as **status completed/absent AND no
message-with-visible-text (output_text/text/refusal) AND no tool call (any
`*_call` item, plus `mcp_approval_request`)** — token count dropped from the
test. With retry on by default, the idle variant now auto-retries instead of
dead-ending. `status="incomplete"` reasoning exhaustion (max_output_tokens)
is intentionally excluded — that's a budget signal, not the stochastic bug.

Note: we fixed this from the symptom + timeline, not a captured payload. To
confirm the exact shape (and rule out a "stream ends with no
response.completed" third variant — now logged at debug as
`empty_completion_no_terminal`), set `BEDROCK_MANTLE_EMPTY_DUMP_DIR` and
`BEDROCK_MANTLE_LOG=debug` and keep using gpt-5.5 until it idles again.

## Followup: the "empty stream" is actually `response.failed` (server_error) (2026-06-08)

Captured the real payload after wiring up `BEDROCK_MANTLE_EMPTY_DUMP_DIR` on
the dashboard slots. Four `no_terminal` dumps from session `019ea8f2`
(oncall-triage, gpt-5.5) are all the **same shape**, and it is **not** the
empty-completion bug:

```
response.created
response.in_progress
response.output_item.added        (reasoning)
response.function_call_arguments.delta ×25   (building: read SKILL.md)
response.function_call_arguments.done
response.output_item.done         (function_call complete)
response.failed   error={"code":"server_error","message":"The server had an error while processing your request. Sorry about that!"}
```

The model emits a **complete, valid function_call**, then the stream ends with
`response.failed` carrying `server_error` instead of `response.completed`.
This is a **transient upstream 5xx delivered as an SSE event mid-stream**, not
an idle/empty model turn. pi sees no `response.completed`, can't use the
function_call, and surfaces "Provider returned an empty stream (0 chars, 0
tools)".

Why our retry didn't catch it: the detector only looked for `response.completed`
with empty output. A terminal `response.failed` is a different event.

Fix: the retry layer now treats a terminal `response.failed` with a transient
error code (`server_error`, `internal_error`, `rate_limit_exceeded`,
`service_unavailable`, `server_overloaded`, `overloaded_error`, `timeout`, or
no code) as retryable — re-issues the identical request once. Client-side
failures (e.g. `invalid_request_error`) pass through without a wasted retry.
Logged as `kind=upstream_failed_retry`. This is distinct from, and in addition
to, the empty-completion retry.

## Root cause isolated: gpt-5.5 errors when it emits a function_call (2026-06-08)

Variant sweep (`scripts-bm-55-diagnose.mjs`, 6 samples each, us-east-2,
minimal hand-crafted requests — no pi involved) pins the trigger precisely:

| Variant | Result |
|---|---|
| 5.5 + tools, model **calls the tool** | 6/6 `server_error` |
| 5.5 + tools, model **answers in text** | 6/6 ok |
| 5.5 **no tools** | 6/6 ok |
| 5.5 reason=low / high / none | 6/6 fail (effort irrelevant) |
| 5.5 reason=minimal | HTTP 400 (param unsupported on this model) |
| 5.5 **non-stream** | 6/6 **HTTP 500** (same failure, different surface) |
| 5.5 max_output_tokens=4096 | 6/6 fail (not a budget issue) |
| 5.5 dated snapshot `2026-04-23` | 6/6 fail (not snapshot-specific) |
| **5.4 + tools, calls tool** | 6/6 ok |

**The trigger is producing a `function_call` output — nothing else.** Tools in
the request are fine; a text answer is fine; no tools is fine. The moment
gpt-5.5 generates a tool call, the request fails.

**Where it breaks:** the dumps show every `function_call_arguments.delta`
streams through and the call is fully built (`...done`, complete args), *then*
`response.failed`. So generation succeeds and **finalization fails** — the
server errors at the step that serializes the completed function_call and emits
`response.completed`. Streaming surfaces it as a `response.failed` SSE event;
non-streaming as an HTTP 500. **gpt-5.4 does the identical tool call 6/6.**

Conclusion: a **server-side defect in gpt-5.5's tool-call finalization path on
Bedrock (us-east-2)** — gpt-5.5-specific, deterministic on tool calls,
independent of effort / token budget / stream mode / snapshot. Not fixable in
the proxy or pi (the model produces a correct tool call; Bedrock can't finalize
it). Rate varies over time (intermittent AM, 100% by 21:43); the trigger is
always a function_call.

**Region availability** (`scripts-bm-region-probe.mjs`, 16 regions): gpt-5.5
exists **only in us-east-2** (no failover region). gpt-5.4 is in us-east-2 +
us-west-2 (both healthy on tool calls). No gpt-5.x anywhere else.

**Mitigation:** use gpt-5.4 for tool-using flows; gpt-5.5 is text-only-usable
right now. Minimal 100% repro lives in `scripts-bm-55-diagnose.mjs`.
