import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  fetchWithStreamingRetry,
  retryMode,
  setRetryMode,
} from "../.tmp-test/retry.js";
import { setLogLevel } from "../.tmp-test/log.js";

// ── env / mode plumbing ──────────────────────────────────────────────────────

function installDummyAwsEnv() {
  const saved = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    AWS_PROFILE: process.env.AWS_PROFILE,
    BEDROCK_MANTLE_AWS_PROFILE: process.env.BEDROCK_MANTLE_AWS_PROFILE,
  };
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  delete process.env.BEDROCK_MANTLE_AWS_PROFILE;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

const SSE_HEADERS = { "content-type": "text/event-stream" };

function sseResponse(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  }), { status: 200, headers: SSE_HEADERS });
}

function withMockedFetch(sequence, fn) {
  const restoreEnv = installDummyAwsEnv();
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async () => {
    const item = sequence[Math.min(i, sequence.length - 1)];
    i++;
    return typeof item === "function" ? item() : item;
  };
  return Promise.resolve(fn()).then(
    (v) => { globalThis.fetch = original; restoreEnv(); return { result: v, callCount: i }; },
    (err) => { globalThis.fetch = original; restoreEnv(); throw err; },
  );
}

const SAMPLE_INPUT = {
  method: "POST",
  path: "/openai/v1/responses",
  headers: { "content-type": "application/json" },
  body: '{"model":"openai.gpt-5.5","input":[]}',
  region: "us-east-2",
};
const SAMPLE_CTX = { requestId: "ctx-id", region: "us-east-2", path: "/openai/v1/responses" };

// Text turn: head, then an actionable output_item.added(message) + a text
// delta, then completion. Must stream (no retry).
function textStreamEvents() {
  return [
    "event: response.created\ndata: {\"foo\":1}\n\n",
    "event: response.in_progress\ndata: {\"foo\":1}\n\n",
    'event: response.output_item.added\ndata: {"item":{"type":"message"}}\n\n',
    'event: response.output_text.delta\ndata: {"delta":"pong"}\n\n',
    'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"pong"}]}]}}\n\n',
  ];
}

// Tool turn: head, then output_item.added(function_call) + arg deltas.
function toolStreamEvents() {
  return [
    "event: response.created\ndata: {\"foo\":1}\n\n",
    'event: response.output_item.added\ndata: {"item":{"type":"function_call","name":"bash"}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"delta":"{\\"cmd\\":"}\n\n',
    'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"function_call"}]}}\n\n',
  ];
}

// Empty turn: head + reasoning item (NOT actionable) + empty completion.
function emptyStreamEvents() {
  return [
    "event: response.created\ndata: {\"foo\":1}\n\n",
    'event: response.output_item.added\ndata: {"item":{"type":"reasoning"}}\n\n',
    'event: response.completed\ndata: {"response":{"model":"openai.gpt-5.5","status":"completed","output":[],"usage":{"output_tokens":0}}}\n\n',
  ];
}

function failedStreamEvents(code = "server_error") {
  return [
    "event: response.created\ndata: {\"foo\":1}\n\n",
    `event: response.failed\ndata: {"response":{"model":"openai.gpt-5.5","status":"failed","error":{"code":"${code}","message":"boom"}}}\n\n`,
  ];
}

describe("retryMode tri-state parsing", () => {
  const cases = [
    [undefined, "stream"],
    ["", "stream"],
    ["1", "stream"],
    ["on", "stream"],
    ["stream", "stream"],
    ["buffer", "buffer"],
    ["full", "buffer"],
    ["0", "off"],
    ["off", "off"],
    ["false", "off"],
  ];
  test("env → mode", () => {
    const saved = process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY;
    setRetryMode(undefined);
    for (const [val, expected] of cases) {
      if (val === undefined) delete process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY;
      else process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY = val;
      assert.equal(retryMode(), expected, `env=${JSON.stringify(val)}`);
    }
    if (saved === undefined) delete process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY;
    else process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY = saved;
  });

  test("legacy boolean override maps to buffer/off", () => {
    setRetryMode(true);
    assert.equal(retryMode(), "buffer");
    setRetryMode(false);
    assert.equal(retryMode(), "off");
    setRetryMode(undefined);
  });
});

describe("fetchWithStreamingRetry — happy path streams, no retry", () => {
  test("text turn: single fetch, body preserved byte-for-byte", async () => {
    setLogLevel("silent");
    const events = textStreamEvents();
    const { result, callCount } = await withMockedFetch(
      [() => sseResponse(events)],
      () => fetchWithStreamingRetry(SAMPLE_INPUT, SAMPLE_CTX),
    );
    assert.equal(callCount, 1, "actionable output must NOT trigger a retry");
    const body = await result.response.text();
    assert.equal(body, events.join(""), "streamed body must equal upstream bytes");
    setLogLevel("info");
  });

  test("tool turn: single fetch, function_call streams through", async () => {
    setLogLevel("silent");
    const events = toolStreamEvents();
    const { result, callCount } = await withMockedFetch(
      [() => sseResponse(events)],
      () => fetchWithStreamingRetry(SAMPLE_INPUT, SAMPLE_CTX),
    );
    assert.equal(callCount, 1, "a function_call is actionable — no retry");
    assert.equal(await result.response.text(), events.join(""));
    setLogLevel("info");
  });
});

describe("fetchWithStreamingRetry — empty / transient retries once", () => {
  test("empty first, text second: retries once, forwards recovered stream", async () => {
    setLogLevel("silent");
    const good = textStreamEvents();
    // Drain the body INSIDE the mocked-fetch scope: the retry fires lazily
    // inside the stream's start() when the body is read, so we must consume it
    // before the mock is restored and callCount is captured.
    const { result: body, callCount } = await withMockedFetch(
      [() => sseResponse(emptyStreamEvents()), () => sseResponse(good)],
      async () => {
        const r = await fetchWithStreamingRetry(SAMPLE_INPUT, SAMPLE_CTX);
        return await r.response.text();
      },
    );
    assert.equal(callCount, 2, "empty completion must trigger exactly one retry");
    assert.equal(body, good.join(""), "recovered second attempt must be forwarded");
    setLogLevel("info");
  });

  test("transient response.failed first, text second: retries once", async () => {
    setLogLevel("silent");
    const good = textStreamEvents();
    const { result: body, callCount } = await withMockedFetch(
      [() => sseResponse(failedStreamEvents("server_error")), () => sseResponse(good)],
      async () => {
        const r = await fetchWithStreamingRetry(SAMPLE_INPUT, SAMPLE_CTX);
        return await r.response.text();
      },
    );
    assert.equal(callCount, 2);
    assert.equal(body, good.join(""));
    setLogLevel("info");
  });

  test("both empty: single retry only, forwards second (still empty)", async () => {
    setLogLevel("silent");
    const empties = emptyStreamEvents();
    const { result: body, callCount } = await withMockedFetch(
      [
        () => sseResponse(empties),
        () => sseResponse(empties),
        () => sseResponse(textStreamEvents()), // would-be third — must NOT run
      ],
      async () => {
        const r = await fetchWithStreamingRetry(SAMPLE_INPUT, SAMPLE_CTX);
        return await r.response.text();
      },
    );
    assert.equal(callCount, 2, "no third attempt");
    assert.equal(body, empties.join(""));
    setLogLevel("info");
  });

  test("client-error response.failed: NOT retried", async () => {
    setLogLevel("silent");
    const { callCount } = await withMockedFetch(
      [() => sseResponse(failedStreamEvents("invalid_request_error")), () => sseResponse(textStreamEvents())],
      async () => {
        const r = await fetchWithStreamingRetry(SAMPLE_INPUT, SAMPLE_CTX);
        return await r.response.text();
      },
    );
    assert.equal(callCount, 1, "client errors must not be retried");
    setLogLevel("info");
  });
});

describe("fetchWithStreamingRetry — pass-through cases", () => {
  test("non-openai-responses path: straight pass-through, no buffering", async () => {
    const { result, callCount } = await withMockedFetch(
      [() => sseResponse(emptyStreamEvents())],
      () => fetchWithStreamingRetry(
        { ...SAMPLE_INPUT, path: "/v1/chat/completions" },
        { ...SAMPLE_CTX, path: "/v1/chat/completions" },
      ),
    );
    assert.equal(callCount, 1);
    assert.equal(result.response.status, 200);
  });

  test("non-SSE response: forwarded live, no retry", async () => {
    const { result, callCount } = await withMockedFetch(
      [() => new Response('{"error":"x"}', { status: 500, headers: { "content-type": "application/json" } })],
      () => fetchWithStreamingRetry(SAMPLE_INPUT, SAMPLE_CTX),
    );
    assert.equal(callCount, 1);
    assert.equal(result.response.status, 500);
  });
});
