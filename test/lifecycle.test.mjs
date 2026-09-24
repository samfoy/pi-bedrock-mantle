import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const EXTENSION = resolve(".tmp-test/index.js");
const PROC_TCP = "/proc/self/net/tcp";

// Ports of the TCP sockets this process holds in LISTEN state (0A), read from
// /proc so the count covers every listener, not only the handles we know about.
function listeningPorts() {
  const inodes = new Set(readdirSync("/proc/self/fd")
    .map((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return ""; } })
    .filter((link) => link.startsWith("socket:["))
    .map((link) => link.slice(8, -1)));
  return readFileSync(PROC_TCP, "utf8").trim().split("\n").slice(1)
    .map((row) => row.trim().split(/\s+/))
    .filter((cols) => cols[3] === "0A" && inodes.has(cols[9]))
    .map((cols) => parseInt(cols[1].split(":")[1], 16))
    .sort((a, b) => a - b);
}

function providerBaseUrls(session) {
  return session.modelRuntime.getModels("bedrock-mantle").map((model) => model.baseUrl);
}

test("session replacement closes the proxies it opened (no listener leak)", {
  skip: !existsSync(PROC_TCP) && "needs /proc/self/net/tcp (Linux)",
  timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "bm-lifecycle-"));
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  const blocked = [];
  // Discovery must never leave the machine: fail every non-loopback fetch.
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url instanceof Request ? url.url : url));
    if (target.hostname === "127.0.0.1") return originalFetch(url, init);
    blocked.push(target.hostname);
    throw new Error(`network disabled in tests: ${target.hostname}`);
  };
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    BEDROCK_MANTLE_MODEL_CACHE: join(dir, "models.json"),
    BEDROCK_MANTLE_LOG: "silent",
  });
  for (const key of ["AWS_SESSION_TOKEN", "AWS_PROFILE", "BEDROCK_MANTLE_AWS_PROFILE",
    "BEDROCK_MANTLE_PROXY_PORT_CMH", "BEDROCK_MANTLE_PROXY_PORT_IAD"]) delete process.env[key];

  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: dir,
      resourceLoaderOptions: { additionalExtensionPaths: [EXTENSION] },
    });
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const baseline = listeningPorts();
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: dir,
    agentDir: dir,
    sessionManager: SessionManager.inMemory(dir),
  });
  try {
    const sessions = 4;
    for (let i = 0; i < sessions; i++) {
      if (i > 0) await runtime.newSession();
      const { session } = runtime;
      await session.bindExtensions({});

      const bound = listeningPorts().filter((port) => !baseline.includes(port));
      assert.equal(bound.length, 2, `session ${i}: expected the two region proxies, got ${bound}`);
      const urls = providerBaseUrls(session);
      assert.ok(urls.length > 0, "bedrock-mantle models are registered");
      for (const url of urls) {
        const port = Number(new URL(url).port);
        assert.ok(bound.includes(port), `session ${i}: ${url} points at a live proxy (${bound})`);
      }
    }
  } finally {
    await runtime.dispose();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(listeningPorts(), baseline, "every proxy closed on session_shutdown");
  assert.ok(blocked.every((host) => host.endsWith(".api.aws")), `only discovery tried the network: ${blocked}`);
});
