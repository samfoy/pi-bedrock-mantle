import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { describe, test } from "node:test";

import { parsePortEnv, startProxy } from "../.tmp-test/proxy.js";

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

function installDummyAwsEnv() {
  const savedEnv = {
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
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function waitFor(predicate, timeoutMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition not met before timeout");
}

describe("parsePortEnv", () => {
  test("returns the default port when the env var is unset", () => {
    delete process.env.BEDROCK_MANTLE_TEST_PORT;
    assert.equal(parsePortEnv("BEDROCK_MANTLE_TEST_PORT", 12345), 12345);
  });

  test("accepts integer ports in range", () => {
    process.env.BEDROCK_MANTLE_TEST_PORT = "54321";
    assert.equal(parsePortEnv("BEDROCK_MANTLE_TEST_PORT", 12345), 54321);
  });

  test("rejects invalid ports with a clear config error", () => {
    for (const value of ["", "abc", "1.5", "0", "65536", "70000"]) {
      process.env.BEDROCK_MANTLE_TEST_PORT = value;
      assert.throws(
        () => parsePortEnv("BEDROCK_MANTLE_TEST_PORT", 12345),
        /Invalid BEDROCK_MANTLE_TEST_PORT=.*expected an integer port from 1 to 65535/
      );
    }
  });
});

describe("startProxy", () => {
  test("streams upstream SSE chunks without waiting for the full response", async () => {
    const port = await getFreePort();
    const originalFetch = globalThis.fetch;
    const restoreEnv = installDummyAwsEnv();
    const encoder = new TextEncoder();

    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
        setTimeout(() => {
          controller.enqueue(encoder.encode("data: two\n\n"));
          controller.close();
        }, 200);
      },
    }), {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "content-encoding": "gzip",
        "content-length": "999",
        "transfer-encoding": "chunked",
      },
    });

    try {
      await startProxy(port, "us-east-2");
      const res = await originalFetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("cache-control") ?? "", /no-transform/);
      assert.equal(res.headers.get("content-encoding"), null);
      assert.equal(res.headers.get("content-length"), null);

      const reader = res.body.getReader();
      const started = Date.now();
      const first = await reader.read();
      const firstAt = Date.now() - started;
      assert.equal(new TextDecoder().decode(first.value), "data: one\n\n");
      assert.ok(firstAt < 250, `first chunk arrived too late: ${firstAt}ms`);

      const second = await reader.read();
      const secondAt = Date.now() - started;
      assert.equal(new TextDecoder().decode(second.value), "data: two\n\n");
      assert.ok(secondAt >= 100, `second chunk arrived before delayed upstream chunk: ${secondAt}ms`);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  test("cancels the upstream reader when the downstream client disconnects mid-stream", async () => {
    const port = await getFreePort();
    const originalFetch = globalThis.fetch;
    const restoreEnv = installDummyAwsEnv();
    const encoder = new TextEncoder();
    let upstreamCancelled = false;

    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: one\n\n"));
      },
      cancel() {
        upstreamCancelled = true;
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    try {
      await startProxy(port, "us-east-2");
      const ac = new AbortController();
      const res = await originalFetch(`http://127.0.0.1:${port}/openai/v1/responses`, {
        method: "POST",
        signal: ac.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stream: true }),
      });
      const reader = res.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), "data: one\n\n");

      ac.abort();
      await waitFor(() => upstreamCancelled);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});
