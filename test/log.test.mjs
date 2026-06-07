import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getLogLevel, log, newRequestId, setLogLevel } from "../.tmp-test/log.js";

function captureStderr(fn) {
  const captured = [];
  const original = process.stderr.write;
  // @ts-ignore — node's stderr.write has overloads we don't need to model here.
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  try {
    fn();
    return captured.join("");
  } finally {
    process.stderr.write = original;
  }
}

describe("log levels", () => {
  test("default level is info — debug suppressed, info/warn/error emitted", () => {
    setLogLevel("info");
    const out = captureStderr(() => {
      log.debug("debug_kind", { a: 1 });
      log.info("info_kind", { a: 1 });
      log.warn("warn_kind", { a: 1 });
      log.error("error_kind", { a: 1 });
    });
    assert.doesNotMatch(out, /debug_kind/);
    assert.match(out, /info_kind/);
    assert.match(out, /warn_kind/);
    assert.match(out, /error_kind/);
  });

  test("silent suppresses every level", () => {
    setLogLevel("silent");
    const out = captureStderr(() => {
      log.error("anything");
      log.info("anything");
    });
    assert.equal(out, "");
  });

  test("debug level emits all four", () => {
    setLogLevel("debug");
    const out = captureStderr(() => {
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    assert.match(out, /level=debug kind=d/);
    assert.match(out, /level=info kind=i/);
    assert.match(out, /level=warn kind=w/);
    assert.match(out, /level=error kind=e/);
  });

  test("setLogLevel/getLogLevel round-trip", () => {
    setLogLevel("warn");
    assert.equal(getLogLevel(), "warn");
    setLogLevel("info");
  });
});

describe("log formatting", () => {
  test("emits one [bedrock-mantle] prefixed line per call with key=value pairs", () => {
    setLogLevel("debug");
    const out = captureStderr(() => {
      log.info("request", { id: "abc", status: 200, latency_ms: 42 });
    });
    assert.equal(out.split("\n").filter(Boolean).length, 1);
    assert.match(out, /^\[bedrock-mantle\] /);
    assert.match(out, /level=info/);
    assert.match(out, /kind=request/);
    assert.match(out, /id=abc/);
    assert.match(out, /status=200/);
    assert.match(out, /latency_ms=42/);
  });

  test("quotes string values that contain whitespace, equals, or quotes", () => {
    setLogLevel("debug");
    const out = captureStderr(() => {
      log.info("test", { plain: "no-spaces", spaced: "has spaces", quoted: 'has "quotes"' });
    });
    assert.match(out, /plain=no-spaces/);
    assert.match(out, /spaced="has spaces"/);
    assert.match(out, /quoted="has \\"quotes\\""/);
  });

  test("Error values include code prefix when present", () => {
    setLogLevel("debug");
    const err = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const out = captureStderr(() => log.warn("upstream_failed", { error: err }));
    assert.match(out, /error="ECONNREFUSED: connection refused"/);
  });

  test("undefined fields are omitted entirely (not 'undefined')", () => {
    setLogLevel("debug");
    const out = captureStderr(() => log.info("test", { defined: 1, missing: undefined }));
    assert.match(out, /defined=1/);
    assert.doesNotMatch(out, /missing/);
    assert.doesNotMatch(out, /undefined/);
  });
});

describe("newRequestId", () => {
  test("returns a non-empty url-safe string", () => {
    const id = newRequestId();
    assert.ok(typeof id === "string" && id.length > 0);
    assert.match(id, /^[A-Za-z0-9_-]+$/);
  });

  test("returns distinct ids on successive calls", () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(newRequestId());
    // 100 random 9-byte ids — collision probability is astronomical.
    assert.equal(ids.size, 100);
  });
});
