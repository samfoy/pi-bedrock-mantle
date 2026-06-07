import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  inspectResponseCompleted,
  maybeDetectEmptyCompletion,
} from "../.tmp-test/empty-completion.js";
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

describe("inspectResponseCompleted", () => {
  test("flags empty when output has only reasoning items and zero output tokens", () => {
    const verdict = inspectResponseCompleted({
      response: {
        model: "openai.gpt-5.5",
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "thinking..." }] },
        ],
        usage: { output_tokens: 0, output_tokens_details: { reasoning_tokens: 1280 } },
      },
    });
    assert.equal(verdict.empty, true);
    assert.equal(verdict.outputTokens, 0);
    assert.equal(verdict.reasoningTokens, 1280);
    assert.deepEqual(verdict.outputItemTypes, ["reasoning"]);
    assert.equal(verdict.model, "openai.gpt-5.5");
  });

  test("does NOT flag when output contains a message with non-empty text", () => {
    const verdict = inspectResponseCompleted({
      response: {
        status: "completed",
        output: [
          { type: "reasoning" },
          { type: "message", content: [{ type: "output_text", text: "hi there" }] },
        ],
        usage: { output_tokens: 4 },
      },
    });
    assert.equal(verdict.empty, false);
    assert.equal(verdict.outputTokens, 4);
    assert.deepEqual(verdict.outputItemTypes, ["reasoning", "message"]);
  });

  test("does NOT flag when status is partial / cancelled (legitimate mid-stream end)", () => {
    const verdict = inspectResponseCompleted({
      response: {
        status: "incomplete",
        output: [{ type: "reasoning" }],
        usage: { output_tokens: 0 },
      },
    });
    assert.equal(verdict.empty, false);
  });

  test("flags empty when usage block is missing entirely (some gpt-5.5 failure modes omit it)", () => {
    const verdict = inspectResponseCompleted({
      response: {
        status: "completed",
        output: [{ type: "reasoning" }],
      },
    });
    assert.equal(verdict.empty, true);
    assert.equal(verdict.outputTokens, undefined);
  });

  test("treats an empty message text block as no visible content", () => {
    const verdict = inspectResponseCompleted({
      response: {
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "" }] },
        ],
        usage: { output_tokens: 0 },
      },
    });
    assert.equal(verdict.empty, true);
  });

  test("accepts the bare response payload (no top-level `response` wrapper)", () => {
    // Some SSE encodings put the payload directly at the top level — handle both shapes.
    const verdict = inspectResponseCompleted({
      status: "completed",
      output: [{ type: "reasoning" }],
      usage: { output_tokens: 0 },
    });
    assert.equal(verdict.empty, true);
  });

  test("returns a safe verdict for malformed payloads", () => {
    assert.equal(inspectResponseCompleted(null).empty, false);
    assert.equal(inspectResponseCompleted("not an object").empty, false);
    assert.equal(inspectResponseCompleted(42).empty, false);
    assert.equal(inspectResponseCompleted({}).empty, true);
    // ↑ {} is "completed implicit + no output + no usage", treated as empty by design.
  });
});

describe("maybeDetectEmptyCompletion (wiring)", () => {
  function sseResponse(events) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  test("non-/openai/v1/responses paths pass through unchanged", () => {
    const input = sseResponse(["event: x\ndata: y\n\n"]);
    const wrapped = maybeDetectEmptyCompletion(input, {
      requestId: "req-1",
      region: "us-east-2",
      path: "/v1/chat/completions",
    });
    // Same Response instance — no tee, no wrap.
    assert.strictEqual(wrapped.response, input);
    assert.equal(typeof wrapped.dispose, "function");
  });

  test("non-SSE responses pass through unchanged", () => {
    const input = new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const wrapped = maybeDetectEmptyCompletion(input, {
      requestId: "req-1",
      region: "us-east-2",
      path: "/openai/v1/responses",
    });
    assert.strictEqual(wrapped.response, input);
  });

  test("SSE response on /openai/v1/responses is wrapped, body bytes pass through, empty completion is logged", async () => {
    setLogLevel("warn");
    const events = [
      "event: response.created\ndata: {\"foo\":1}\n\n",
      "event: response.in_progress\ndata: {\"foo\":2}\n\n",
      // Final event with the empty-completion shape.
      'event: response.completed\ndata: {"response":{"model":"openai.gpt-5.5","status":"completed","output":[{"type":"reasoning"}],"usage":{"output_tokens":0,"output_tokens_details":{"reasoning_tokens":850}}}}\n\n',
    ];
    const upstream = sseResponse(events);

    const { stderr } = await captureStderr(async () => {
      const { response } = maybeDetectEmptyCompletion(upstream, {
        requestId: "req-empty-1",
        region: "us-east-2",
        path: "/openai/v1/responses",
      });
      // Drain the wrapped body so the scan completes.
      const reader = response.body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return bytes.toString("utf-8");
    });

    // Wait a tick for the scanner to flush its log line — the scan promise
    // resolves after the upstream stream closes.
    await new Promise((resolve) => setImmediate(resolve));

    assert.match(stderr, /level=warn kind=empty_completion/);
    assert.match(stderr, /id=req-empty-1/);
    assert.match(stderr, /model=openai\.gpt-5\.5/);
    assert.match(stderr, /reasoning_tokens=850/);
    assert.match(stderr, /output_tokens=0/);

    setLogLevel("info");
  });

  test("SSE response with normal completion does NOT log empty_completion", async () => {
    setLogLevel("warn");
    const events = [
      "event: response.created\ndata: {\"foo\":1}\n\n",
      'event: response.completed\ndata: {"response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hi"}]}],"usage":{"output_tokens":2}}}\n\n',
    ];
    const upstream = sseResponse(events);

    const { stderr } = await captureStderr(async () => {
      const { response } = maybeDetectEmptyCompletion(upstream, {
        requestId: "req-good-1",
        region: "us-east-2",
        path: "/openai/v1/responses",
      });
      const reader = response.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.doesNotMatch(stderr, /empty_completion/);
    setLogLevel("info");
  });

  test("body bytes are unmodified — client sees the exact same stream the proxy received", async () => {
    setLogLevel("silent");
    const events = [
      "event: response.created\ndata: {\"a\":1}\n\n",
      'event: response.completed\ndata: {"response":{"status":"completed","output":[],"usage":{"output_tokens":0}}}\n\n',
    ];
    const upstream = sseResponse(events);
    const { response } = maybeDetectEmptyCompletion(upstream, {
      requestId: "req-bytes-1",
      region: "us-east-2",
      path: "/openai/v1/responses",
    });

    const reader = response.body.getReader();
    let assembled = "";
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      assembled += decoder.decode(value, { stream: true });
    }
    assembled += decoder.decode();

    assert.equal(assembled, events.join(""));
    setLogLevel("info");
  });

  test("dispose() cancels the scanner so a teed upstream can propagate cancel back", async () => {
    setLogLevel("silent");
    let upstreamCancelled = false;
    const encoder = new TextEncoder();
    const upstream = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: response.created\ndata: {\"a\":1}\n\n"));
        // Don't close — the upstream stays open until cancelled.
      },
      cancel() { upstreamCancelled = true; },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });

    const { response, dispose } = maybeDetectEmptyCompletion(upstream, {
      requestId: "req-cancel-1",
      region: "us-east-2",
      path: "/openai/v1/responses",
    });

    // Read one chunk on the client branch.
    const reader = response.body.getReader();
    await reader.read();

    // Cancel both branches. tee()'s underlying-source cancel only fires once
    // both branches have cancelled — dispose() supplies the second.
    await Promise.all([
      reader.cancel(),
      // dispose() returns void; wrap in Promise.resolve so the array shape works.
      Promise.resolve(dispose()),
    ]);

    // Poll briefly: cancellation propagation across tee() involves multiple
    // microtasks plus the source's cancel callback. setImmediate alone races.
    const deadline = Date.now() + 1000;
    while (!upstreamCancelled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(upstreamCancelled, true, "expected upstream cancel to propagate after dispose()");
    setLogLevel("info");
  });
});
