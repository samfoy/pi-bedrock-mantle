import "./hermetic.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

import { VERSION } from "@earendil-works/pi-coding-agent";
import bedrockMantleExtension, { piVersionError } from "../.tmp-test/index.js";

const tooOld = (version) =>
  `pi-bedrock-mantle 1.1 needs pi 0.81.0 or newer (this is pi ${version}). Upgrade pi, or install npm:pi-bedrock-mantle@1.0.2.`;

/** An ExtensionAPI stand-in that records every member the extension touches. */
function recordingPi(members = {}) {
  const touched = [];
  const pi = new Proxy(members, {
    get(target, key) {
      touched.push(String(key));
      return target[key];
    },
  });
  return { pi, touched };
}

async function withEmptyModelCache(run) {
  const dir = mkdtempSync(join(tmpdir(), "bm-pi-version-"));
  process.env.BEDROCK_MANTLE_MODEL_CACHE = join(dir, "models.json");
  try {
    return await run();
  } finally {
    delete process.env.BEDROCK_MANTLE_MODEL_CACHE;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("piVersionError accepts pi 0.81.0 and newer, and the pi these tests run against", () => {
  for (const version of ["0.81.0", "0.81.1", "0.87.1", "0.100.0", "1.0.0", VERSION]) {
    assert.equal(piVersionError(version), undefined, version);
  }
});

test("piVersionError names the running pi when it is older than 0.81.0 or unknown", () => {
  for (const version of ["0.80.10", "0.79.10", "0.8.100"]) assert.equal(piVersionError(version), tooOld(version));
  assert.equal(piVersionError(undefined), tooOld("unknown"));
  assert.equal(piVersionError("next"), tooOld("next"));
});

test("on pi older than 0.81.0 the factory touches no pi API and reports one line", async () => {
  for (const version of ["0.80.10", "0.79.10"]) {
    const { pi, touched } = recordingPi();
    const reported = mock.method(console, "error", () => {});
    try {
      await bedrockMantleExtension(pi, version);
      assert.deepEqual(touched, [], `pi ${version}: no pi API use`);
      assert.deepEqual(reported.mock.calls.map((call) => call.arguments), [[tooOld(version)]]);
    } finally {
      reported.mock.restore();
    }
  }
});

test("on the current pi the factory registers the provider and reports nothing", () =>
  withEmptyModelCache(async () => {
    const providers = [];
    const events = [];
    const { pi } = recordingPi({
      registerProvider: (provider) => providers.push(provider),
      on: (event) => events.push(event),
    });
    const reported = mock.method(console, "error", () => {});
    try {
      await bedrockMantleExtension(pi, VERSION);
    } finally {
      reported.mock.restore();
    }
    assert.equal(reported.mock.callCount(), 0);
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, "bedrock-mantle");
    assert.ok(providers[0].getModels().length > 0, "the curated models are registered");
    assert.deepEqual(events.sort(), ["session_shutdown", "session_start"]);
  }));
