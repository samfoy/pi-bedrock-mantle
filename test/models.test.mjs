import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  FALLBACK_MODELS_RAW,
  fastModels,
  fetchModels,
  writeCachedModels,
} from "../.tmp-test/models.js";
import { setLogLevel } from "../.tmp-test/log.js";

// Test ports — fixed so URL assertions are stable; nothing actually binds in
// these unit tests since fetch is mocked or model construction is pure.
const TEST_PORTS = { cmh: 57893, iad: 57891 };

function fallbackById(id) {
  // FALLBACK_MODELS_RAW carries placeholder baseUrls. For the routing-only
  // assertions in these tests, we apply TEST_PORTS to materialize URLs.
  const raw = FALLBACK_MODELS_RAW.find((candidate) => candidate.id === id);
  assert.ok(raw, `expected fallback model ${id}`);
  if (!raw.baseUrl) return raw;
  return {
    ...raw,
    baseUrl: raw.baseUrl
      .replace("{{CMH_PORT}}", String(TEST_PORTS.cmh))
      .replace("{{IAD_PORT}}", String(TEST_PORTS.iad)),
  };
}

function withFakeAwsCredentials() {
  process.env.AWS_ACCESS_KEY_ID = "test-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.AWS_SESSION_TOKEN = "test-session-token";
  process.env.BEDROCK_MANTLE_MODEL_CACHE = ".tmp-test/model-cache.json";
  rmSync(process.env.BEDROCK_MANTLE_MODEL_CACHE, { force: true });
  delete process.env.AWS_PROFILE;
  delete process.env.BEDROCK_MANTLE_AWS_PROFILE;
  // Reset port pins so the cache key is consistent across tests.
  delete process.env.BEDROCK_MANTLE_PROXY_PORT_CMH;
  delete process.env.BEDROCK_MANTLE_PROXY_PORT_IAD;
}

const CURATED_IDS = FALLBACK_MODELS_RAW.map((model) => model.id).sort();

/** Write a current-schema cache to `path`, with `overrides` on top. */
function writeCacheFile(path, overrides = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    version: 3,
    generatedAt: Date.now(),
    proxyPorts: { cmh: 0, iad: 0 },
    models: [FALLBACK_MODELS_RAW.find((model) => model.id === "openai.gpt-oss-20b")],
    ...overrides,
  }));
}

async function withMockedFetch(resolver, fn) {
  withFakeAwsCredentials();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => resolver(String(url));
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withMutedWarnings(fn) {
  const warn = console.warn;
  console.warn = () => {};
  // Our logger bypasses console.warn (writes directly to process.stderr) so
  // mute it explicitly too.
  setLogLevel("silent");
  try {
    return await fn();
  } finally {
    console.warn = warn;
    setLogLevel("info");
  }
}

test("GPT-5 models route through OpenAI Responses with image input and GPT-5 thinking map", () => {
  for (const id of [
    "openai.gpt-5.5",
    "openai.gpt-5.5-2026-04-23",
    "openai.gpt-5.4",
    "openai.gpt-5.6-luna",
    "openai.gpt-5.6-sol",
    "openai.gpt-5.6-terra",
  ]) {
    const model = fallbackById(id);
    assert.equal(model.api, "openai-responses");
    assert.match(model.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/openai\/v1$/);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.thinkingLevelMap, { off: null, xhigh: "xhigh" });
    assert.equal(model.contextWindow, id.includes("gpt-5.6-") ? 1000000 : 272000);
    assert.equal(model.maxTokens, 128000);
  }
});

test("GPT OSS models route through OpenAI Chat Completions without image input", () => {
  for (const id of ["openai.gpt-oss-120b", "openai.gpt-oss-20b"]) {
    const model = fallbackById(id);
    assert.equal(model.api, "openai-completions");
    assert.match(model.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.deepEqual(model.input, ["text"]);
    assert.equal(model.reasoning, false);
    assert.equal(model.thinkingLevelMap, undefined);
  }
});

test("Anthropic models route through Anthropic Messages in IAD with required version header", () => {
  const model = fallbackById("anthropic.claude-opus-4-7");

  assert.equal(model.api, "anthropic-messages");
  assert.match(model.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/anthropic$/);
  assert.deepEqual(model.headers, { "anthropic-version": "2023-06-01" });
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.contextWindow, 1_000_000);
});

test("region selection prefers CMH for OpenAI-compatible models and falls back to IAD", async () => {
  await withMockedFetch((url) => {
    if (url.includes("us-east-1")) {
      return new Response(JSON.stringify({ data: [{ id: "openai.gpt-oss-120b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: [{ id: "openai.gpt-oss-20b" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }, async () => {
    const models = await fetchModels(TEST_PORTS);
    const cmh = models.find((model) => model.id === "openai.gpt-oss-20b");
    const iad = models.find((model) => model.id === "openai.gpt-oss-120b");

    assert.equal(cmh?.api, "openai-completions");
    assert.equal(iad?.api, "openai-completions");
    assert.match(cmh?.baseUrl ?? "", new RegExp(`:${TEST_PORTS.cmh}/v1$`));
    assert.match(iad?.baseUrl ?? "", new RegExp(`:${TEST_PORTS.iad}/v1$`));
  });
});

test("only the OpenAI GPT-5 family uses Responses routing", () => {
  assert.equal(fallbackById("openai.gpt-5.5").api, "openai-responses");
  assert.equal(fallbackById("openai.gpt-5.5-2026-04-23").api, "openai-responses");
  assert.equal(fallbackById("openai.gpt-oss-120b").api, "openai-completions");
  assert.equal(fallbackById("qwen.qwen3-vl-235b-a22b-instruct").api, "openai-completions");
});

test("unknown model inference keeps vision and reasoning heuristics explicit", async () => {
  await withMockedFetch((url) => {
    if (url.includes("us-east-1")) throw new Error("IAD unavailable");
    return new Response(JSON.stringify({ data: [
      { id: "qwen.future-vl-model" },
      { id: "moonshotai.future-thinking" },
      { id: "openai.gpt-5.6" },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  }, async () => {
    const models = await fetchModels(TEST_PORTS);
    assert.deepEqual(models.find((model) => model.id === "qwen.future-vl-model")?.input, ["text", "image"]);
    assert.equal(models.find((model) => model.id === "moonshotai.future-thinking")?.reasoning, true);
    assert.deepEqual(models.find((model) => model.id === "openai.gpt-5.6")?.thinkingLevelMap, { off: null, xhigh: "xhigh" });
  });
});

test("fetchModels merges successful regional discovery and ignores a partial regional failure", async () => {
  await withMockedFetch((url) => {
    if (url.includes("us-east-1")) throw new Error("IAD unavailable");
    assert.match(url, /bedrock-mantle\.us-east-2\.api\.aws\/v1\/models$/);
    return new Response(JSON.stringify({ data: [
      { id: "openai.gpt-5.5" },
      { id: "openai.gpt-oss-120b" },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  }, async () => {
    const models = await fetchModels(TEST_PORTS);
    assert.deepEqual(models.map((model) => model.id).sort(), ["openai.gpt-5.5", "openai.gpt-oss-120b"]);
    assert.equal(models.find((model) => model.id === "openai.gpt-5.5")?.api, "openai-responses");
    assert.equal(models.find((model) => model.id === "openai.gpt-oss-120b")?.api, "openai-completions");
  });
});

test("fetchModels honors BEDROCK_MANTLE_AWS_PROFILE instead of AWS_PROFILE", async () => {
  mkdirSync(".tmp-test", { recursive: true });
  writeFileSync(".tmp-test/aws-credentials", [
    "[mantle-test]",
    "aws_access_key_id = profile-access-key",
    "aws_secret_access_key = profile-secret-key",
    "aws_session_token = profile-session-token",
    "",
  ].join("\n"));

  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  process.env.AWS_SHARED_CREDENTIALS_FILE = ".tmp-test/aws-credentials";
  process.env.BEDROCK_MANTLE_AWS_PROFILE = "mantle-test";
  process.env.BEDROCK_MANTLE_MODEL_CACHE = ".tmp-test/model-cache-profile.json";
  rmSync(process.env.BEDROCK_MANTLE_MODEL_CACHE, { force: true });
  process.env.AWS_PROFILE = "missing-profile-that-should-be-ignored";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "openai.gpt-oss-120b" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  try {
    const models = await fetchModels(TEST_PORTS);
    assert.deepEqual(models.map((model) => model.id), ["openai.gpt-oss-120b"]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    delete process.env.BEDROCK_MANTLE_AWS_PROFILE;
    delete process.env.BEDROCK_MANTLE_MODEL_CACHE;
    delete process.env.AWS_PROFILE;
  }
});

test("fetchModels falls back to curated models when all regional discovery fails", async () => {
  await withMockedFetch(() => new Response("nope", { status: 503 }), async () => {
    const models = await withMutedWarnings(() => fetchModels(TEST_PORTS));
    assert.deepEqual(
      models.map((model) => model.id).sort(),
      FALLBACK_MODELS_RAW.map((model) => model.id).sort(),
    );
  });
});

test("fastModels uses cached live discovery without performing network discovery", () => {
  withFakeAwsCredentials();
  const cached = [{
    ...FALLBACK_MODELS_RAW.find((model) => model.id === "openai.gpt-oss-20b"),
  }];
  assert.ok(cached[0]);
  writeCachedModels(cached, TEST_PORTS);

  const models = fastModels(TEST_PORTS);
  assert.deepEqual(models.map((model) => model.id), ["openai.gpt-oss-20b"]);
  // Cached baseUrl should have been rehydrated with TEST_PORTS.cmh.
  assert.match(models[0].baseUrl ?? "", new RegExp(`:${TEST_PORTS.cmh}/`));
});

test("fastModels rejects caches written under a different port pin", () => {
  withFakeAwsCredentials();
  // Write a cache that claims it was generated when CMH was pinned to 99999
  // (impossible at runtime — we override only the recorded proxyPorts to test
  // the cache-key invalidation).
  writeCacheFile(process.env.BEDROCK_MANTLE_MODEL_CACHE, { proxyPorts: { cmh: 99999, iad: 99998 } });

  // Default port-pin is 0/0, so cache should be rejected and we should fall
  // back to the curated list.
  const models = fastModels(TEST_PORTS);
  assert.deepEqual(
    models.map((model) => model.id).sort(),
    FALLBACK_MODELS_RAW.map((model) => model.id).sort(),
  );
});

test("fastModels rejects caches with a stale schema version", () => {
  withFakeAwsCredentials();
  // Control: the same cache at the current version is read.
  writeCacheFile(process.env.BEDROCK_MANTLE_MODEL_CACHE);
  assert.deepEqual(fastModels(TEST_PORTS).map((model) => model.id), ["openai.gpt-oss-20b"]);

  // Version 2 caches predate baseUrl validation and must be discarded.
  for (const version of [1, 2]) {
    writeCacheFile(process.env.BEDROCK_MANTLE_MODEL_CACHE, { version });
    assert.deepEqual(fastModels(TEST_PORTS).map((model) => model.id).sort(), CURATED_IDS, `version ${version}`);
  }
});

test("fastModels rejects a cache whose baseUrl leaves the loopback proxy", () => {
  withFakeAwsCredentials();
  const model = FALLBACK_MODELS_RAW.find((candidate) => candidate.id === "openai.gpt-oss-20b");
  const hostile = [
    "https://attacker.example/v1",
    "http://attacker.example:{{CMH_PORT}}/v1",
    "http://localhost:{{CMH_PORT}}/v1",
    "http://127.0.0.1:{{CMH_PORT}}@attacker.example/v1",
    "http://127.0.0.1.attacker.example:{{CMH_PORT}}/v1",
    "http://127.0.0.1:8080/v1",
    "http://127.0.0.1:{{CMH_PORT}}/v1/../../elsewhere",
    undefined,
  ];
  for (const baseUrl of hostile) {
    writeCacheFile(process.env.BEDROCK_MANTLE_MODEL_CACHE, { models: [{ ...model, baseUrl }] });
    const models = fastModels(TEST_PORTS);
    assert.deepEqual(models.map((m) => m.id).sort(), CURATED_IDS, `fell back to curated for ${baseUrl}`);
    assert.ok(models.every((m) => m.baseUrl.startsWith("http://127.0.0.1:")), `${baseUrl}: loopback only`);
  }
});

test("without HOME the cache is skipped, never placed in a shared tmpdir", () => {
  withFakeAwsCredentials();
  const shared = mkdtempSync(join(tmpdir(), "bm-shared-tmp-"));
  const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, XDG: process.env.XDG_CACHE_HOME };
  delete process.env.BEDROCK_MANTLE_MODEL_CACHE;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.HOME;
  process.env.TMPDIR = shared;
  try {
    // Another local user plants a cache where the old code would have looked.
    const planted = join(tmpdir(), ".cache", "pi-bedrock-mantle", "models.json");
    assert.ok(planted.startsWith(shared));
    writeCacheFile(planted);
    assert.deepEqual(fastModels(TEST_PORTS).map((model) => model.id).sort(), CURATED_IDS);

    rmSync(join(shared, ".cache"), { recursive: true, force: true });
    writeCachedModels([FALLBACK_MODELS_RAW[0]], TEST_PORTS);
    assert.deepEqual(readdirSync(shared), [], "nothing written to the shared tmpdir");
  } finally {
    for (const [key, value] of Object.entries({ HOME: saved.HOME, TMPDIR: saved.TMPDIR, XDG_CACHE_HOME: saved.XDG })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(shared, { recursive: true, force: true });
  }
});

test("writeCachedModels strips bound ports so the cache survives ephemeral restarts", () => {
  withFakeAwsCredentials();
  // Simulate live discovery output: real bound ports baked into baseUrls.
  const live = [{
    ...FALLBACK_MODELS_RAW.find((model) => model.id === "openai.gpt-oss-20b"),
    baseUrl: "http://127.0.0.1:54321/v1",
  }];
  writeCachedModels(live, { cmh: 54321, iad: 54322 });

  // Re-read with different ports — should rehydrate to the new ports, not 54321.
  const models = fastModels({ cmh: 11111, iad: 22222 });
  assert.equal(models.length, 1);
  assert.equal(models[0].baseUrl, "http://127.0.0.1:11111/v1");
});

test("cache round trip keeps each model on the region proxy discovery chose", async () => {
  // gpt-oss-120b only in us-east-1 routes to IAD even though it is not Anthropic.
  // The two control rows must survive too, so a change can't pass by breaking both.
  await withMockedFetch((url) => new Response(JSON.stringify({ data: url.includes("us-east-1")
    ? [{ id: "openai.gpt-oss-120b" }, { id: "anthropic.claude-opus-4-7" }]
    : [{ id: "openai.gpt-oss-20b" }] }), { status: 200, headers: { "content-type": "application/json" } }),
  async () => {
    const live = await fetchModels(TEST_PORTS);
    const restarted = { cmh: 11111, iad: 22222 };
    const fromCache = fastModels(restarted);
    const baseUrl = (models, id) => models.find((model) => model.id === id)?.baseUrl;

    assert.equal(baseUrl(live, "openai.gpt-oss-120b"), `http://127.0.0.1:${TEST_PORTS.iad}/v1`);
    assert.equal(baseUrl(fromCache, "openai.gpt-oss-120b"), `http://127.0.0.1:${restarted.iad}/v1`);
    assert.equal(baseUrl(fromCache, "openai.gpt-oss-20b"), `http://127.0.0.1:${restarted.cmh}/v1`);
    assert.equal(baseUrl(fromCache, "anthropic.claude-opus-4-7"), `http://127.0.0.1:${restarted.iad}/anthropic`);
  });
});
