import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { FALLBACK_MODELS, fetchModels } from "../.tmp-test/models.js";

function byId(id) {
  const model = FALLBACK_MODELS.find((candidate) => candidate.id === id);
  assert.ok(model, `expected fallback model ${id}`);
  return model;
}

function withFakeAwsCredentials() {
  process.env.AWS_ACCESS_KEY_ID = "test-access-key";
  process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.AWS_SESSION_TOKEN = "test-session-token";
  delete process.env.AWS_PROFILE;
  delete process.env.BEDROCK_MANTLE_AWS_PROFILE;
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
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

test("GPT-5 models route through OpenAI Responses with image input and GPT-5 thinking map", () => {
  for (const id of ["openai.gpt-5.5", "openai.gpt-5.5-2026-04-23", "openai.gpt-5.4"]) {
    const model = byId(id);
    assert.equal(model.api, "openai-responses");
    assert.match(model.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/openai\/v1$/);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.thinkingLevelMap, { off: null, xhigh: "xhigh" });
  }
});

test("GPT OSS models route through OpenAI Chat Completions without image input", () => {
  for (const id of ["openai.gpt-oss-120b", "openai.gpt-oss-20b"]) {
    const model = byId(id);
    assert.equal(model.api, "openai-completions");
    assert.match(model.baseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.deepEqual(model.input, ["text"]);
    assert.equal(model.reasoning, false);
    assert.equal(model.thinkingLevelMap, undefined);
  }
});

test("Anthropic models route through Anthropic Messages in IAD with required version header", () => {
  const model = byId("anthropic.claude-opus-4-7");

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
    const models = await fetchModels();
    const cmh = models.find((model) => model.id === "openai.gpt-oss-20b");
    const iad = models.find((model) => model.id === "openai.gpt-oss-120b");

    assert.equal(cmh?.api, "openai-completions");
    assert.equal(iad?.api, "openai-completions");
    assert.match(cmh?.baseUrl ?? "", /:57893\/v1$/);
    assert.match(iad?.baseUrl ?? "", /:57891\/v1$/);
  });
});

test("only the OpenAI GPT-5 family uses Responses routing", () => {
  assert.equal(byId("openai.gpt-5.5").api, "openai-responses");
  assert.equal(byId("openai.gpt-5.5-2026-04-23").api, "openai-responses");
  assert.equal(byId("openai.gpt-oss-120b").api, "openai-completions");
  assert.equal(byId("qwen.qwen3-vl-235b-a22b-instruct").api, "openai-completions");
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
    const models = await fetchModels();
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
    const models = await fetchModels();
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
  process.env.AWS_PROFILE = "missing-profile-that-should-be-ignored";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "openai.gpt-oss-120b" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  try {
    const models = await fetchModels();
    assert.deepEqual(models.map((model) => model.id), ["openai.gpt-oss-120b"]);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    delete process.env.BEDROCK_MANTLE_AWS_PROFILE;
    delete process.env.AWS_PROFILE;
  }
});

test("fetchModels falls back to curated models when all regional discovery fails", async () => {
  await withMockedFetch(() => new Response("nope", { status: 503 }), async () => {
    const models = await withMutedWarnings(() => fetchModels());
    assert.deepEqual(models.map((model) => model.id), FALLBACK_MODELS.map((model) => model.id));
  });
});
