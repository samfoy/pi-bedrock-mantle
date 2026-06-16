import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fetchWithEmptyRetry,
  setRetryMode,
} from "../.tmp-test/retry.js";
import { setLogLevel } from "../.tmp-test/log.js";

function captureStderr(fn) {
  const captured = [];
  const original = process.stderr.write;
  // @ts-ignore
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  return Promise.resolve(fn()).then(
    (result) => { process.stderr.write = original; return { result, stderr: captured.join("") }; },
    (err) => { process.stderr.write = original; throw err; },
  );
}

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

function emptyCompletionEvents() {
  return [
    "event: response.created\ndata: {\"foo\":1}\n\n",
    'event: response.completed\ndata: {"response":{"model":"openai.gpt-5.5","status":"completed","output":[],"usage":{"output_tokens":0,"output_tokens_details":{"reasoning_tokens":0}}}}\n\n',
  ];
}

function nonEmptyCompletionEvents() {
  return [
    "event: response.created\ndata: {\"foo\":1}\n\n",
    'event: response.completed\ndata: {"response":{"model":"openai.gpt-5.5","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"pong"}]}],"usage":{"output_tokens":4}}}\n\n',
  ];
}

function sseResponse(events) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e));
      controller.close();
    },
  }), { status: 200, headers: SSE_HEADERS });
}

/** Stub global fetch to return a sequence of canned responses, then restore. */
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

describe("fetchWithEmptyRetry — retry mode OFF", () => {
  test("pass-through: does not buffer, returns the live Response, attempts=1", async () => {
    setRetryMode(false);
    const { result } = await withMockedFetch(
      [() => sseResponse(emptyCompletionEvents())],
      () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
    );
    assert.equal(result.attempts, 1);
    assert.equal(result.response.status, 200);
    // Live stream — body still readable as a stream.
    assert.ok(result.response.body, "expected a body");
    setRetryMode(undefined);
  });
});

describe("fetchWithEmptyRetry — retry mode ON", () => {
  test("non-openai-responses path: skipped entirely, no buffering, attempts=1", async () => {
    setRetryMode(true);
    const { result, callCount } = await withMockedFetch(
      [() => sseResponse(emptyCompletionEvents())],
      () => fetchWithEmptyRetry(
        { ...SAMPLE_INPUT, path: "/v1/chat/completions" },
        { ...SAMPLE_CTX, path: "/v1/chat/completions" },
      ),
    );
    assert.equal(result.attempts, 1);
    assert.equal(callCount, 1);
    setRetryMode(undefined);
  });

  test("non-SSE response: pass-through, attempts=1", async () => {
    setRetryMode(true);
    const { result, callCount } = await withMockedFetch(
      [() => new Response('{"error":"x"}', { status: 500, headers: { "content-type": "application/json" } })],
      () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
    );
    assert.equal(result.attempts, 1);
    assert.equal(callCount, 1);
    assert.equal(result.response.status, 500);
    setRetryMode(undefined);
  });

  test("first attempt non-empty: buffered + reconstructed, attempts=1, body bytes preserved", async () => {
    setRetryMode(true);
    setLogLevel("silent");
    const events = nonEmptyCompletionEvents();
    const { result, callCount } = await withMockedFetch(
      [() => sseResponse(events)],
      () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
    );
    assert.equal(result.attempts, 1);
    assert.equal(callCount, 1);
    const body = await result.response.text();
    assert.equal(body, events.join(""));
    setRetryMode(undefined);
    setLogLevel("info");
  });

  test("first empty, second non-empty: retries once, returns second response, logs recovered", async () => {
    setRetryMode(true);
    setLogLevel("info");
    const successEvents = nonEmptyCompletionEvents();

    const { result, callCount, ...rest } = await captureStderr(async () => {
      return await withMockedFetch(
        [
          () => sseResponse(emptyCompletionEvents()),
          () => sseResponse(successEvents),
        ],
        () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
      );
    }).then((wrapped) => ({ ...wrapped.result, stderr: wrapped.stderr }));

    assert.equal(result.attempts, 2);
    assert.equal(callCount, 2);
    const body = await result.response.text();
    assert.equal(body, successEvents.join(""), "expected second-attempt body to be forwarded");
    assert.match(rest.stderr, /level=warn kind=empty_completion_retry.*attempt=1.*action=retrying/);
    assert.match(rest.stderr, /level=info kind=empty_completion_retry.*attempt=2.*outcome=recovered/);
    setRetryMode(undefined);
  });

  test("both attempts empty: forwards second response, logs still_empty, no third attempt", async () => {
    setRetryMode(true);
    setLogLevel("warn");
    const empties = emptyCompletionEvents();

    const { result, callCount, stderr } = await captureStderr(async () => {
      return await withMockedFetch(
        [
          () => sseResponse(empties),
          () => sseResponse(empties),
          () => sseResponse(nonEmptyCompletionEvents()), // would-be third — must NOT be called
        ],
        () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
      );
    }).then((wrapped) => ({ ...wrapped.result, stderr: wrapped.stderr }));

    assert.equal(result.attempts, 2);
    assert.equal(callCount, 2, "must not attempt a third call");
    assert.match(stderr, /level=warn kind=empty_completion_retry.*attempt=1.*action=retrying/);
    assert.match(stderr, /level=warn kind=empty_completion_retry.*attempt=2.*outcome=still_empty/);
    setRetryMode(undefined);
    setLogLevel("info");
  });

  test("retry returns non-SSE error response: forwarded as-is without further inspection", async () => {
    setRetryMode(true);
    setLogLevel("silent");
    const { result, callCount } = await withMockedFetch(
      [
        () => sseResponse(emptyCompletionEvents()),
        () => new Response('{"error":"throttled"}', { status: 429, headers: { "content-type": "application/json" } }),
      ],
      () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
    );
    assert.equal(result.attempts, 2);
    assert.equal(callCount, 2);
    assert.equal(result.response.status, 429);
    setRetryMode(undefined);
    setLogLevel("info");
  });
});

describe("retry mode env parsing", () => {
  test("env override is tri-state: on / off / default-on", async () => {
    const saved = process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY;
    setRetryMode(undefined); // clear test override so env is consulted
    setLogLevel("silent");

    // Default (unset/empty) is ON; explicit 0/false/off forces OFF.
    const cases = [
      ["1", true],
      ["true", true],
      ["TRUE", true],
      ["yes", true],
      ["on", true],
      ["0", false],
      ["false", false],
      ["off", false],
      ["", true],        // empty → no override → default on
      [undefined, true], // unset → default on
    ];

    for (const [val, expected] of cases) {
      if (val === undefined) delete process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY;
      else process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY = val;

      const { result, callCount } = await withMockedFetch(
        [
          () => sseResponse(emptyCompletionEvents()),
          () => sseResponse(nonEmptyCompletionEvents()),
        ],
        () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
      );
      assert.equal(
        result.attempts,
        expected ? 2 : 1,
        `expected attempts=${expected ? 2 : 1} for env=${JSON.stringify(val)}`,
      );
      assert.equal(callCount, expected ? 2 : 1);
    }

    setLogLevel("info");
    if (saved === undefined) delete process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY;
    else process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY = saved;
  });

  test("retry is on by default regardless of model (gpt-5.4 retried too)", async () => {
    const saved = process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY;
    delete process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY;
    setRetryMode(undefined);
    setLogLevel("silent");
    const gpt54Input = { ...SAMPLE_INPUT, body: '{"model":"openai.gpt-5.4","input":[]}' };
    const gpt54Empty = [
      'event: response.completed\ndata: {"response":{"model":"openai.gpt-5.4","status":"completed","output":[],"usage":{"output_tokens":0}}}\n\n',
    ];
    const { result, callCount } = await withMockedFetch(
      [
        () => sseResponse(gpt54Empty),
        () => sseResponse(nonEmptyCompletionEvents()),
      ],
      () => fetchWithEmptyRetry(gpt54Input, SAMPLE_CTX),
    );
    assert.equal(result.attempts, 2, "default-on retry applies to all openai-responses models");
    assert.equal(callCount, 2);
    setLogLevel("info");
    if (saved === undefined) delete process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY;
    else process.env.BEDROCK_MANTLE_EMPTY_COMPLETION_RETRY = saved;
  });
});

describe("empty-completion capture (no terminal / non-SSE)", () => {
  // SSE that opens and closes with no response.completed event — the
  // "empty stream" variant pi's dashboard reports as 0 chars / 0 tools.
  function noTerminalEvents() {
    return ["event: response.created\ndata: {\"foo\":1}\n\n"];
  }
  function nonSse200() {
    return new Response("", { status: 200, headers: { "content-type": "application/json" } });
  }

  function withDumpDir(fn) {
    const dir = mkdtempSync(join(tmpdir(), "bm-dump-"));
    const saved = process.env.BEDROCK_MANTLE_EMPTY_DUMP_DIR;
    process.env.BEDROCK_MANTLE_EMPTY_DUMP_DIR = dir;
    return Promise.resolve(fn(dir)).finally(() => {
      if (saved === undefined) delete process.env.BEDROCK_MANTLE_EMPTY_DUMP_DIR;
      else process.env.BEDROCK_MANTLE_EMPTY_DUMP_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    });
  }

  test("no-terminal SSE: warns, does NOT retry, attempts=1, body preserved", async () => {
    setRetryMode(true);
    setLogLevel("warn");
    const events = noTerminalEvents();
    const { result, callCount, stderr } = await captureStderr(async () =>
      withMockedFetch(
        [() => sseResponse(events), () => sseResponse(nonEmptyCompletionEvents())],
        () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
      ),
    ).then((w) => ({ ...w.result, stderr: w.stderr }));
    assert.equal(result.attempts, 1, "no-terminal is captured, not retried");
    assert.equal(callCount, 1);
    assert.match(stderr, /kind=empty_completion_no_terminal/);
    assert.equal(await result.response.text(), events.join(""));
    setRetryMode(undefined);
    setLogLevel("info");
  });

  test("no-terminal SSE: dumps buffered bytes + request when EMPTY_DUMP_DIR set", async () => {
    await withDumpDir(async (dir) => {
      setRetryMode(true);
      setLogLevel("silent");
      const events = noTerminalEvents();
      await withMockedFetch(
        [() => sseResponse(events)],
        () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
      );
      const files = readdirSync(dir).filter((f) => f.startsWith("no_terminal-"));
      assert.equal(files.length, 1, "expected one no_terminal dump");
      const dump = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
      assert.equal(dump.label, "no_terminal");
      assert.equal(dump.responseText, events.join(""));
      assert.deepEqual(dump.request, { model: "openai.gpt-5.5", input: [] });
      setRetryMode(undefined);
      setLogLevel("info");
    });
  });

  test("non-SSE 200: warns + dumps when EMPTY_DUMP_DIR set, passes through", async () => {
    await withDumpDir(async (dir) => {
      setRetryMode(true);
      setLogLevel("silent");
      const { result, callCount } = await withMockedFetch(
        [() => nonSse200()],
        () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
      );
      assert.equal(result.attempts, 1);
      assert.equal(callCount, 1);
      assert.equal(result.response.status, 200);
      const files = readdirSync(dir).filter((f) => f.startsWith("non_sse-"));
      assert.equal(files.length, 1, "expected one non_sse dump");
      setRetryMode(undefined);
      setLogLevel("info");
    });
  });

  test("non-SSE error (500): passes through, no dump", async () => {
    await withDumpDir(async (dir) => {
      setRetryMode(true);
      setLogLevel("silent");
      const { result } = await withMockedFetch(
        [() => new Response('{"error":"x"}', { status: 500, headers: { "content-type": "application/json" } })],
        () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
      );
      assert.equal(result.response.status, 500);
      assert.equal(readdirSync(dir).length, 0, "errors must not be dumped");
      setRetryMode(undefined);
      setLogLevel("info");
    });
  });
});

describe("transient response.failed retry", () => {
  function failedEvents(code = "server_error") {
    return [
      "event: response.created\ndata: {\"foo\":1}\n\n",
      `event: response.failed\ndata: {"response":{"model":"openai.gpt-5.5","status":"failed","error":{"code":"${code}","message":"boom"}}}\n\n`,
    ];
  }

  test("server_error response.failed: retries once, recovers, attempts=2, logs upstream_failed_retry", async () => {
    setRetryMode(true);
    setLogLevel("info");
    const { result, callCount, stderr } = await captureStderr(async () =>
      withMockedFetch(
        [() => sseResponse(failedEvents()), () => sseResponse(nonEmptyCompletionEvents())],
        () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
      ),
    ).then((w) => ({ ...w.result, stderr: w.stderr }));
    assert.equal(result.attempts, 2);
    assert.equal(callCount, 2);
    assert.equal(await result.response.text(), nonEmptyCompletionEvents().join(""));
    assert.match(stderr, /kind=upstream_failed_retry.*error_code=server_error.*attempt=1.*action=retrying/);
    assert.match(stderr, /kind=upstream_failed_retry.*attempt=2.*outcome=recovered/);
    setRetryMode(undefined);
  });

  test("both attempts response.failed: forwards second, logs still_failed, no third call", async () => {
    setRetryMode(true);
    setLogLevel("warn");
    const { result, callCount, stderr } = await captureStderr(async () =>
      withMockedFetch(
        [
          () => sseResponse(failedEvents()),
          () => sseResponse(failedEvents()),
          () => sseResponse(nonEmptyCompletionEvents()), // must NOT be called
        ],
        () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
      ),
    ).then((w) => ({ ...w.result, stderr: w.stderr }));
    assert.equal(result.attempts, 2);
    assert.equal(callCount, 2, "single retry only");
    assert.match(stderr, /kind=upstream_failed_retry.*attempt=2.*outcome=still_failed/);
    setRetryMode(undefined);
    setLogLevel("info");
  });

  test("both attempts failed: dumps the failing request + response when EMPTY_DUMP_DIR set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-dump-"));
    const saved = process.env.BEDROCK_MANTLE_EMPTY_DUMP_DIR;
    process.env.BEDROCK_MANTLE_EMPTY_DUMP_DIR = dir;
    try {
      setRetryMode(true);
      setLogLevel("silent");
      await withMockedFetch(
        [() => sseResponse(failedEvents()), () => sseResponse(failedEvents())],
        () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
      );
      const files = readdirSync(dir).filter((f) => f.startsWith("failed_retried-"));
      assert.equal(files.length, 1, "expected one failed_retried dump");
      const dump = JSON.parse(readFileSync(join(dir, files[0]), "utf-8"));
      assert.deepEqual(dump.request, { model: "openai.gpt-5.5", input: [] });
      assert.match(dump.responseText, /response\.failed/);
    } finally {
      if (saved === undefined) delete process.env.BEDROCK_MANTLE_EMPTY_DUMP_DIR;
      else process.env.BEDROCK_MANTLE_EMPTY_DUMP_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
      setRetryMode(undefined);
      setLogLevel("info");
    }
  });

  test("non-transient failure (invalid_request_error): NOT retried, passes through", async () => {
    setRetryMode(true);
    setLogLevel("silent");
    const { result, callCount } = await withMockedFetch(
      [() => sseResponse(failedEvents("invalid_request_error")), () => sseResponse(nonEmptyCompletionEvents())],
      () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
    );
    assert.equal(result.attempts, 1, "client errors must not be retried");
    assert.equal(callCount, 1);
    setRetryMode(undefined);
    setLogLevel("info");
  });

  test("invalid_prompt + 'Engine not found' message: treated as infra failure, retried once", async () => {
    setRetryMode(true);
    setLogLevel("silent");
    const engineNotFound = [
      "event: response.created\ndata: {\"foo\":1}\n\n",
      `event: response.failed\ndata: {"response":{"model":"openai.gpt-5.4","status":"failed","error":{"code":"invalid_prompt","message":"JSON-RPC error -32602: Job registration failed: Engine bad request: Task submission failed with status 404 Not Found: Engine not found"}}}\n\n`,
    ];
    const { result, callCount } = await withMockedFetch(
      [() => sseResponse(engineNotFound), () => sseResponse(nonEmptyCompletionEvents())],
      () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
    );
    assert.equal(result.attempts, 2, "infra failures surfaced as invalid_prompt must be retried");
    assert.equal(callCount, 2);
    setRetryMode(undefined);
    setLogLevel("info");
  });

  test("invalid_prompt WITHOUT infra message: NOT retried", async () => {
    setRetryMode(true);
    setLogLevel("silent");
    const realClientError = [
      "event: response.created\ndata: {\"foo\":1}\n\n",
      `event: response.failed\ndata: {"response":{"model":"openai.gpt-5.4","status":"failed","error":{"code":"invalid_prompt","message":"Your request contains an invalid prompt."}}}\n\n`,
    ];
    const { result, callCount } = await withMockedFetch(
      [() => sseResponse(realClientError), () => sseResponse(nonEmptyCompletionEvents())],
      () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
    );
    assert.equal(result.attempts, 1, "plain invalid_prompt without infra message must not be retried");
    assert.equal(callCount, 1);
    setRetryMode(undefined);
    setLogLevel("info");
  });

  test("response.failed with no error code: treated as transient, retried once", async () => {
    setRetryMode(true);
    setLogLevel("silent");
    const noCode = [
      "event: response.created\ndata: {\"foo\":1}\n\n",
      'event: response.failed\ndata: {"response":{"model":"openai.gpt-5.5","status":"failed","error":{}}}\n\n',
    ];
    const { result, callCount } = await withMockedFetch(
      [() => sseResponse(noCode), () => sseResponse(nonEmptyCompletionEvents())],
      () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
    );
    assert.equal(result.attempts, 2);
    assert.equal(callCount, 2);
    setRetryMode(undefined);
    setLogLevel("info");
  });

  test("first transient-failed, retry returns non-retryable failure: NOT logged as recovered", async () => {
    setRetryMode(true);
    setLogLevel("warn");
    const { result, stderr } = await captureStderr(async () =>
      withMockedFetch(
        [() => sseResponse(failedEvents("server_error")), () => sseResponse(failedEvents("invalid_request_error"))],
        () => fetchWithEmptyRetry(SAMPLE_INPUT, SAMPLE_CTX),
      ),
    ).then((w) => ({ ...w.result, stderr: w.stderr }));
    assert.equal(result.attempts, 2);
    assert.doesNotMatch(stderr, /outcome=recovered/, "a second-attempt failure is not a recovery");
    assert.match(stderr, /outcome=still_failed/);
    setRetryMode(undefined);
    setLogLevel("info");
  });
});
