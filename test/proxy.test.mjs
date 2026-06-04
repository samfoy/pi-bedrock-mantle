import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parsePortEnv } from "../.tmp-test/proxy.js";

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
