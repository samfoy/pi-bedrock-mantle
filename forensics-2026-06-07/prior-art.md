# GPT-5.x empty completions — prior art

Online research conducted 2026-06-07 to find prior reports and authoritative
guidance on the empty-completion behavior we measured (10–20% rate on tool-using
gpt-5.5 requests via OpenAI Responses API on Bedrock Mantle).

## Headline: this is widely reported, and AWS-specific cases exist too

The empty-completion failure mode is not a bedrock-mantle bug. It's a known
problem with gpt-5.x on the OpenAI Responses API, with multiple variants:

| Source | Symptom | Status |
|---|---|---|
| [OpenAI forum #1365210](https://community.openai.com/t/gpt-5-responses-api-hundreds-of-calls-return-empty-completion-content-while-chat-works/1365210) (Nov 2025) | "hundreds of calls return empty completion content" | Solved (community advice: raise `max_output_tokens`) |
| [openai-python #2546](https://github.com/openai/openai-python/issues/2546) | `gpt-5-mini` returns empty `output_text`, output contains only a reasoning item | Open |
| [openai-python #2725](https://github.com/openai/openai-python/issues/2725) | `responses.create()` hangs on gpt-5-nano via SDK; works via curl | Open |
| [openai-python #3009](https://github.com/openai/openai-python/issues/3009) | Reasoning + message item pairing constraint breaks multi-turn; broke OpenClaw | Open |
| [openai-python #3075](https://github.com/openai/openai-python/issues/3075) | server-side compaction not emitted on tool-call-only Responses turns | Open |
| [hermes-agent #5736](https://github.com/NousResearch/hermes-agent/issues/5736) | **agent loop returns empty `response.output` on gpt-5.x; isolated direct call works fine** | Open |
| [vercel/ai #7784](https://github.com/vercel/ai/issues/7784) | `generateText` empty content on Bedrock | Open |
| [openai/codex #26288](https://github.com/openai/codex/issues/26288) | Codex Desktop with Bedrock: turn completes silently with no assistant response | Open |
| [openai/codex #21352](https://github.com/openai/codex/issues/21352), [#23650](https://github.com/openai/codex/issues/23650) | Bedrock Mantle endpoint path confusion (`/openai/v1/responses` vs `/v1/responses`) | Open |
| [Microsoft Q&A](https://learn.microsoft.com/en-au/answers/questions/5590694/ai-foundry-model-gpt-5-nano-returns-empty-response) | Azure AI Foundry gpt-5-nano: long reasoning, empty message | Resolved with `max_output_tokens` + `effort=minimal` |
| [OpenAI forum #1358411](https://community.openai.com/t/all-background-tasks-on-responses-api-producing-completely-empty-output-array-across-all-prompts/1358411) (Sep 2025) | All background-task Responses calls return `output: []` | No public resolution |
| [BerriAI/litellm #23156](https://github.com/BerriAI/litellm/issues/23156) | gpt-5.4 + reasoning_effort + tools fails via Chat Completions; Responses required | Open |
| [DevelopersIO blog (JP)](https://dev.classmethod.jp/articles/bedrock-gpt55-high-effort-duplicate-json-corruption-workaround/) | Bedrock gpt-5.5 with high effort: duplicate / corrupted JSON output | Workaround: switch to streaming + reassemble |

**Hermes-agent #5736 is the closest match to our situation**: agent loop hits
empty `response.output` reliably when the primary model is gpt-5.x on a
"codex"-flavored Responses path; direct minimal calls succeed; their workaround
was switching to a non-codex provider (specifically Minimax via OpenRouter,
or anything not on the codex Responses route).

## Authoritative diagnoses

### 1. `max_output_tokens` budget exhaustion (most-cited cause, doesn't explain ours)

OpenAI's `_j` in forum #1365210 explains:

> The main fault that you have is that you have set the `max_output_tokens`
> value far too low. It needs to be more like 10000, of a possible 128000.
>
> "gpt-5" (along with o4-mini, o3, etc) are reasoning AI models. They produce
> internal tokens of thought that you do not receive, which are also billed
> as output. The maximum token setting is a budget of the maximum expense
> you will spend, seen or unseen, and it will terminate the AI text
> generation if hit.

**This does not explain our case.** Pi sends `max_output_tokens: null`
(unbounded) and we still hit the bug. Verified in our captured request dump.

### 2. `reasoning.effort=minimal` + tools = broken (matches our 100% empty result)

Per OpenAI's official cookbook
([GPT-5 New Params and Tools](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_new_params_and_tools)):

> **4. Minimal Reasoning**
>
> Runs GPT-5 with few or no reasoning tokens to minimize latency and speed
> time-to-first-token. Ideal for deterministic, lightweight tasks
> (extraction, formatting, short rewrites, simple classification) where
> explanations aren't needed. **Avoid for multi-step planning or tool-heavy
> workflows.**

And the migration guide states:

> Starting with GPT-5.4, tool calling is not supported in Chat Completions
> with `reasoning: none`.

Our variant sweep found `reasoning.effort=minimal` + tools = 10/10 empty
(100%). This is consistent with the documented limitation. Don't ever set
minimal with tools.

### 3. Reasoning + message item pairing constraint (related but not our cause)

[openai-python #3009](https://github.com/openai/openai-python/issues/3009)
documents an undocumented Responses API constraint:

> Reasoning + message items must appear as consecutive pairs in `input`,
> but nothing documents this. The most common pattern — filtering
> `response.output` to keep only messages — silently produces orphaned
> items → 400 on the next turn.

This reportedly broke OpenClaw and required a `downgradeOpenAIReasoningBlocks()`
helper. Doesn't directly explain our zero-output case (we get empty on the
first call, no prior reasoning items in input), but it shows the API has
several undocumented brittle behaviors in this family.

### 4. Codex/Mantle path-specific quirks

[openai/codex #21352](https://github.com/openai/codex/issues/21352) and
[#23650](https://github.com/openai/codex/issues/23650) document path-name
confusion between `/openai/v1/responses` (Bedrock Mantle's path for some
models) and `/v1/responses` (used by other paths). We're on the right
path — `/openai/v1/responses` for gpt-5.x — verified by inspecting the
captured request URLs.

[openai/codex #26288](https://github.com/openai/codex/issues/26288) describes
"the user-visible chat shows the thinking indicator briefly, then it
disappears and no assistant response is added" on Bedrock — which is
exactly the dashboard symptom Sam saw yesterday.

## How our findings fit

| Observation | Confirmed by prior art? |
|---|---|
| 10–20% empty rate on gpt-5.5 + Responses + tools | ✅ Multiple reports |
| `effort=minimal` is 100% broken with tools | ✅ Documented officially |
| gpt-5.4 has 0% rate on same prompt | ➖ No direct comparison data, but consistent with reports that some models in family are worse than others |
| Direct minimal calls work, agent calls fail | ✅ Hermes-agent #5736 has the same pattern |
| Bug is stochastic, replay reproduces 1/10 | ➖ Not directly tested elsewhere; most reports show 100% failure on a specific prompt rather than stochastic |
| First-call concentration perceived | ➖ Not specifically reported; our data suggests it's perceptual, not structural |

The stochasticity is the only finding that's not strongly corroborated by
others. The community reports tend to be either "always empty" or "got
it working with X param" — not "10-20% empty intermittently". This may
be because our captured request happens to trigger a particular failure
mode that's stochastic, while others describe more deterministic shapes.

## Authoritative workarounds (community-validated)

1. **Use a different model.** Hermes-agent's escape hatch (Minimax/Claude/etc).
   Our equivalent: gpt-5.4, Claude Sonnet on Bedrock, Anthropic Haiku on
   bedrock-mantle. All have 0% rate.

2. **Raise `max_output_tokens` if you're setting it.** OpenAI's standard
   advice for the budget-exhaustion variant of the bug. Doesn't apply to us
   (pi sends null) but worth knowing for downstream consumers who set it.

3. **Avoid `reasoning.effort=minimal` with tools.** Documented officially.

4. **Retry on empty.** Implicitly recommended in hermes-agent's fallback
   logic and in OpenAI's `Empty completion content (attempt 1/2/3)`
   warning pattern in forum #1365210. **This is what we shipped in commit
   `badf178`.** Empirically takes us from ~10% to ~1% on gpt-5.5.

5. **Switch endpoints from Responses to Chat Completions.** Forum #1365210
   notes that Chat Completions works where Responses fails on first-party
   OpenAI. **This escape hatch does not exist on Bedrock Mantle.** Probed
   2026-06-07: `openai.gpt-5.5` and `openai.gpt-5.4` both reject
   `/v1/chat/completions` with HTTP 400 `validation_error: "The model 'openai.gpt-5.x'
   does not support the '/v1/chat/completions' API"`. AWS gates the entire
   gpt-5.x family to the Responses API. Other models (gpt-oss-*, DeepSeek,
   Qwen, etc.) accept chat-completions normally; this restriction is
   gpt-5.x-specific. Not viable for pi which is already using Responses.

6. **GPT-5.1 reportedly fixed some of these.** Per OpenAI forum
   ["Need reasoning: false option for GPT-5"](https://community.openai.com/t/need-reasoning-false-option-for-gpt-5-update-gpt-5-1-solves-reasoning-issue/1351588),
   GPT-5.1 added `reasoning.effort: "none"` which solves the deterministic-mode
   case. We're on 5.5, not 5.1, but if GPT-5.6+ ships with similar fixes
   the bug may resolve itself.

## Tech-reader.blog has explicit AWS Bedrock guidance

[AWS Bedrock Error: Bedrock Invocation Succeeds but Returns Empty Response](https://www.tech-reader.blog/2026/02/bedrock-invocation-succeeds-but-returns.html) (Feb 2026):

> An AWS Bedrock invocation succeeds, but the response contains no text output.
> - The API call returns HTTP 200
> - No exception or timeout is raised
> - Response payload exists, but output text is empty
> - Logs show a successful invocation
> - The application displays nothing
>
> 📌 This behavior occurs when the model generates no user-visible content.

That blog post documents the symptom as a recognized AWS Bedrock phenomenon,
not just OpenAI's. Recommended diagnostic steps: inspect raw response payload
(we already do via the dump), verify message items are correctly constructed
in inputs, and consider model behavior with the specific prompt shape.

## Bottom line

What we observed is real, well-documented, and not unique to our setup. The
mitigation we shipped (retry-on-empty) is the de-facto community workaround
formalized into the proxy. Sam's options going forward:

- **Recommended default for tool-using agent flows: gpt-5.4 or Claude on Bedrock.**
  0% empty rate measured, much smaller body of bug reports.
- **If gpt-5.5 is required**, leave `BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY=1`
  on. Empirically lowers user-visible failure to ~1%.
- **Watch for GPT-5.6+** — if OpenAI ships a 5.x model with `reasoning.effort:
  none` properly working alongside tools (as 5.1 did for non-tool flows), the
  bug may go away. Models can be re-evaluated then.
- **Don't bother debugging request shapes.** We tested every plausible
  mutation. Nothing eliminates the bug at the prompt level.
