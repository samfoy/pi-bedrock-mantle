import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createSigningProxy,
  parsePortEnv,
  signAndForward,
  startProxy,
} from "../.tmp-test/proxy.js";
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

  test("accepts 0 as the ephemeral-port sentinel", () => {
    process.env.BEDROCK_MANTLE_TEST_PORT = "0";
    assert.equal(parsePortEnv("BEDROCK_MANTLE_TEST_PORT", 12345), 0);
  });

  test("rejects invalid ports with a clear config error", () => {
    for (const value of ["", "abc", "1.5", "-1", "65536", "70000"]) {
      process.env.BEDROCK_MANTLE_TEST_PORT = value;
      assert.throws(
        () => parsePortEnv("BEDROCK_MANTLE_TEST_PORT", 12345),
        /Invalid BEDROCK_MANTLE_TEST_PORT=.*expected an integer port from 0 to 65535/
      );
    }
  });
});

describe("signAndForward", () => {
  test("signs the request, forwards to the regional bedrock-mantle host, and returns the upstream Response unchanged", async () => {
    const restoreEnv = installDummyAwsEnv();
    const originalFetch = globalThis.fetch;
    let capturedUrl;
    let capturedHeaders;
    let capturedMethod;
    let capturedBody;

    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      capturedMethod = init?.method;
      capturedBody = init?.body;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const res = await signAndForward({
        method: "POST",
        path: "/openai/v1/responses",
        headers: { "content-type": "application/json", "x-passthrough": "yes" },
        body: JSON.stringify({ stream: true }),
        region: "us-east-2",
      });
      assert.equal(res.status, 200);
      assert.equal(capturedUrl, "https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses");
      assert.equal(capturedMethod, "POST");
      // SigV4 must have populated authorization on the forwarded request.
      assert.match(capturedHeaders?.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=test\//);
      // x-* headers must pass through verbatim.
      assert.equal(capturedHeaders?.["x-passthrough"], "yes");
      // Body bytes must reach upstream.
      assert.ok(capturedBody, "expected a body on the forwarded request");
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  test("drops hop-by-hop and incoming-auth headers before signing", async () => {
    const restoreEnv = installDummyAwsEnv();
    const originalFetch = globalThis.fetch;
    let captured;

    globalThis.fetch = async (_url, init) => {
      captured = init?.headers;
      return new Response("ok", { status: 200 });
    };

    try {
      await signAndForward({
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer should-be-removed",
          "x-api-key": "should-be-removed",
          connection: "keep-alive",
        },
        body: JSON.stringify({ ok: true }),
        region: "us-east-1",
      });
      assert.equal(captured?.["x-api-key"], undefined);
      // The signed authorization replaces the inbound one.
      assert.match(captured?.authorization ?? "", /^AWS4-HMAC-SHA256/);
      assert.equal(captured?.connection, undefined);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe("createSigningProxy", () => {
  test("returns the bound ephemeral port via the resolved SigningProxy", async () => {
    const proxy = await createSigningProxy("us-east-2", 0);
    try {
      assert.ok(proxy.port > 0, `expected an ephemeral port, got ${proxy.port}`);
      assert.equal(typeof proxy.close, "function");
    } finally {
      await proxy.close();
    }
  });

  test("two concurrent proxies bind distinct ephemeral ports — no singleton conflict", async () => {
    const a = await createSigningProxy("us-east-2", 0);
    const b = await createSigningProxy("us-east-2", 0);
    try {
      assert.notEqual(a.port, b.port, "expected distinct ephemeral ports across proxies");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});

describe("proxy logging", () => {
  test("emits a structured request line at debug level on success and surfaces the request id in response headers", async () => {
    const restoreEnv = installDummyAwsEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", {
      status: 200,
      headers: { "content-type": "application/json", "x-amzn-requestid": "upstream-abc-123" },
    });

    setLogLevel("debug");
    const proxy = await createSigningProxy("us-east-2", 0);
    try {
      const { result, stderr } = await captureStderr(async () => {
        return await originalFetch(`http://127.0.0.1:${proxy.port}/openai/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true }),
        });
      });
      const reqId = result.headers.get("x-bedrock-mantle-request-id");
      assert.ok(reqId, "expected x-bedrock-mantle-request-id header on the response");
      assert.match(stderr, /level=debug kind=request/);
      assert.match(stderr, new RegExp(`id=${reqId}`));
      assert.match(stderr, /status=200/);
      assert.match(stderr, /region=us-east-2/);
      assert.match(stderr, /latency_ms=\d+/);
      assert.match(stderr, /upstream_request_id=upstream-abc-123/);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
      setLogLevel("info");
      await proxy.close();
    }
  });

  test("emits a warn line for upstream non-2xx responses (visible at default info level)", async () => {
    const restoreEnv = installDummyAwsEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"error":"forbidden"}', {
      status: 403,
      headers: { "content-type": "application/json" },
    });

    setLogLevel("info");
    const proxy = await createSigningProxy("us-east-1", 0);
    try {
      const { result, stderr } = await captureStderr(async () =>
        originalFetch(`http://127.0.0.1:${proxy.port}/anthropic/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      );
      assert.equal(result.status, 403);
      assert.match(stderr, /level=warn kind=request/);
      assert.match(stderr, /status=403/);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
      await proxy.close();
    }
  });

  test("emits an error line and a structured 500 body when the upstream fetch throws", async () => {
    const restoreEnv = installDummyAwsEnv();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network down"); };

    setLogLevel("error");
    const proxy = await createSigningProxy("us-east-2", 0);
    try {
      const { result, stderr } = await captureStderr(async () =>
        originalFetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      );
      assert.equal(result.status, 500);
      const body = await result.json();
      assert.equal(body.error.type, "proxy_error");
      assert.ok(typeof body.error.request_id === "string" && body.error.request_id.length > 0);
      assert.equal(result.headers.get("x-bedrock-mantle-request-id"), body.error.request_id);
      assert.match(stderr, /level=error kind=request_failed/);
      assert.match(stderr, /error="network down"/);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
      setLogLevel("info");
      await proxy.close();
    }
  });
});

describe("startProxy (legacy)", () => {
  test("streams upstream SSE chunks without waiting for the full response", async () => {
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

    const proxy = await createSigningProxy("us-east-2", 0);
    try {
      await startProxy; // satisfy import for backward-compat surface
      const res = await originalFetch(`http://127.0.0.1:${proxy.port}/openai/v1/responses`, {
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
      await proxy.close();
    }
  });

  test("cancels the upstream reader when the downstream client disconnects mid-stream", async () => {
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

    const proxy = await createSigningProxy("us-east-2", 0);
    try {
      const ac = new AbortController();
      const res = await originalFetch(`http://127.0.0.1:${proxy.port}/openai/v1/responses`, {
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
      await proxy.close();
    }
  });
});
