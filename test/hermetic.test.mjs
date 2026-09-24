import { FAKE_ACCESS_KEY_ID, FAKE_SECRET_ACCESS_KEY, takeEgressViolations } from "./hermetic.mjs";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, get } from "node:http";
import { test } from "node:test";

test("pins fake static credentials and hides every ambient AWS credential source", () => {
  assert.equal(process.env.AWS_ACCESS_KEY_ID, FAKE_ACCESS_KEY_ID);
  assert.equal(process.env.AWS_SECRET_ACCESS_KEY, FAKE_SECRET_ACCESS_KEY);
  assert.equal(process.env.AWS_EC2_METADATA_DISABLED, "true");
  for (const key of ["AWS_SESSION_TOKEN", "AWS_PROFILE", "BEDROCK_MANTLE_AWS_PROFILE"]) {
    assert.equal(process.env[key], undefined, key);
  }
  for (const key of ["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"]) {
    assert.ok(process.env[key], `${key} is set`);
    assert.equal(existsSync(process.env[key]), false, `${key} must not exist`);
  }
});

test("a test that changes the AWS env ...", () => {
  process.env.AWS_PROFILE = "developer-profile";
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SHARED_CREDENTIALS_FILE;
});

test("... does not leak it into the next test", () => {
  assert.equal(process.env.AWS_PROFILE, undefined);
  assert.equal(process.env.AWS_ACCESS_KEY_ID, FAKE_ACCESS_KEY_ID);
  assert.ok(process.env.AWS_SHARED_CREDENTIALS_FILE);
});

// 192.0.2.1 (TEST-NET-1) and .invalid never reach a real service, even if the
// guard regressed; the timeout bounds a regressed guard's connect attempt.
test("blocks fetch and node:http connections to non-loopback hosts", { timeout: 5000 }, async () => {
  await assert.rejects(fetch("https://192.0.2.1/"), (err) => {
    assert.match(String(err.cause?.message), /non-loopback host 192\.0\.2\.1/);
    return true;
  });
  const httpError = await new Promise((resolve) => {
    get("http://example.invalid/").on("error", resolve).on("response", () => resolve(null));
  });
  assert.match(String(httpError?.message), /non-loopback host example\.invalid/);
  assert.deepEqual(takeEgressViolations(), ["192.0.2.1", "example.invalid"]);
});

test("allows loopback connections", { timeout: 5000 }, async () => {
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(takeEgressViolations(), []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
