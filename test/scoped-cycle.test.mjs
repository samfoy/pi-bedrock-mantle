import "./hermetic.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const EXTENSION = resolve(".tmp-test/index.js");
// Different APIs and regions: each model routes to its own proxy.
const MODEL_A = "bedrock-mantle/anthropic.claude-haiku-4-5"; // us-east-1, anthropic-messages
const MODEL_B = "bedrock-mantle/openai.gpt-oss-120b"; // us-east-2, openai-completions
const UPSTREAM_HOST = /^bedrock-mantle\.(us-east-[12])\.api\.aws$/;

const CHAT_COMPLETION_SSE = [
  { id: "c1", object: "chat.completion.chunk", created: 0, model: "m",
    choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", created: 0, model: "m",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

const ref = (model) => `${model.provider}/${model.id}`;

/** Loopback stand-in for Bedrock Mantle: records each request, streams one chat completion. */
async function startMockUpstream() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const [, region, ...rest] = req.url.split("/");
    const path = `/${rest.join("/")}`;
    requests.push({ region, method: req.method, path, body: Buffer.concat(chunks).toString("utf8") });
    if (req.method === "POST" && path === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(CHAT_COMPLETION_SSE);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not mocked" } }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  };
}

/** A pi session scoped to MODEL_A and MODEL_B (A selected), with Bedrock replaced by the mock. */
async function withScopedSession(run) {
  const dir = mkdtempSync(join(tmpdir(), "bm-scoped-cycle-"));
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  const upstream = await startMockUpstream();
  // The proxy's signed upstream call goes to the mock instead of AWS.
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const region = UPSTREAM_HOST.exec(url.hostname)?.[1];
    return originalFetch(region ? `${upstream.url}/${region}${url.pathname}${url.search}` : input, init);
  };
  Object.assign(process.env, {
    BEDROCK_MANTLE_MODEL_CACHE: join(dir, "models.json"),
    BEDROCK_MANTLE_LOG: "silent",
  });
  for (const key of ["BEDROCK_MANTLE_PROXY_PORT_CMH", "BEDROCK_MANTLE_PROXY_PORT_IAD"]) delete process.env[key];

  // Mirrors pi's main.js: the extension factory registers its provider, the
  // scope (`enabledModels` / `--models`) is resolved from the registry, and
  // only then does the session start and bind the proxies.
  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.inMemory({
      enabledModels: [MODEL_A, MODEL_B],
      retry: { enabled: false },
    });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: { additionalExtensionPaths: [EXTENSION] },
    });
    const { scopedModels } = await resolveModelScopeWithDiagnostics(
      settingsManager.getEnabledModels(), services.modelRuntime);
    return {
      ...(await createAgentSessionFromServices({
        services, sessionManager, sessionStartEvent, model: scopedModels[0]?.model, scopedModels,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: dir,
    agentDir: dir,
    sessionManager: SessionManager.inMemory(dir),
  });
  try {
    const { session } = runtime;
    const extensionErrors = [];
    // Bound like the TUI, so /reload emits session_start again.
    await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
    assert.deepEqual(session.scopedModels.map(({ model }) => ref(model)), [MODEL_A, MODEL_B]);
    assert.equal(ref(session.model), MODEL_A);
    await run(session, upstream);
    assert.deepEqual(extensionErrors, []);
  } finally {
    await runtime.dispose();
    globalThis.fetch = originalFetch;
    await upstream.close();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Cycle the way Ctrl+P does, send a prompt, and require it to reach the mock upstream as MODEL_B. */
async function cycleToModelBAndPrompt(session, upstream) {
  const before = upstream.requests.length;
  const cycled = await session.cycleModel("forward");
  assert.equal(cycled && ref(cycled.model), MODEL_B);

  await session.prompt("ping");
  const reply = session.messages.filter((message) => message.role === "assistant").at(-1);
  const posts = upstream.requests.slice(before).filter((request) => request.method === "POST");
  assert.deepEqual(posts.map(({ region, path }) => `${region} ${path}`), ["us-east-2 /v1/chat/completions"],
    `the prompt reaches the upstream; pi reported: ${reply?.errorMessage}`);
  assert.equal(JSON.parse(posts[0].body).model, "openai.gpt-oss-120b");
  assert.equal(reply.errorMessage, undefined);
  assert.deepEqual(reply.content.filter((part) => part.type === "text").map((part) => part.text), ["pong"]);
}

test("Ctrl+P cycling to a scoped mantle model reaches the live proxy", { timeout: 30_000 }, () =>
  withScopedSession(cycleToModelBAndPrompt));

test("after /reload, a scoped model naming the closed proxy's port reaches the new proxy", { timeout: 30_000 }, () =>
  withScopedSession(async (session, upstream) => {
    // What /scoped-models stores: the registry's models, with this session's ports.
    session.setScopedModels(session.scopedModels.map(({ model }) => ({
      model: session.modelRuntime.getModel(model.provider, model.id),
    })));
    const stalePort = Number(new URL(session.scopedModels[1].model.baseUrl).port);
    assert.notEqual(stalePort, 0);

    await session.reload();
    const livePort = Number(new URL(session.modelRuntime.getModel("bedrock-mantle", "openai.gpt-oss-120b").baseUrl).port);
    assert.notEqual(livePort, stalePort, "reload bound a new proxy");
    assert.equal(Number(new URL(session.scopedModels[1].model.baseUrl).port), stalePort, "pi kept the stale copy");

    await cycleToModelBAndPrompt(session, upstream);
  }));
