// Imported first by every test file. Before each test it pins fake static AWS
// credentials and hides every other credential source, and it fails any test
// that opens a TCP connection to a non-loopback host, so the suite never uses a
// developer's profile or reaches AWS, whatever the caller's environment holds.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach } from "node:test";

// AWS's documented example key pair: well-formed, never valid.
export const FAKE_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
export const FAKE_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const missingDir = join(tmpdir(), `bedrock-mantle-no-aws-${randomUUID()}`); // never created

const HERMETIC_AWS_ENV = {
  AWS_ACCESS_KEY_ID: FAKE_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: FAKE_SECRET_ACCESS_KEY,
  AWS_CONFIG_FILE: join(missingDir, "config"),
  AWS_SHARED_CREDENTIALS_FILE: join(missingDir, "credentials"),
  AWS_EC2_METADATA_DISABLED: "true",
};

// The other inputs of the Node default provider chain and of fromIni.
const UNSET_AWS_ENV = [
  "AWS_SESSION_TOKEN", "AWS_CREDENTIAL_EXPIRATION",
  "AWS_PROFILE", "BEDROCK_MANTLE_AWS_PROFILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
];

export function applyHermeticAwsEnv() {
  for (const key of UNSET_AWS_ENV) delete process.env[key];
  Object.assign(process.env, HERMETIC_AWS_ENV);
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|::ffff:127(\.\d{1,3}){3})$/i;
const violations = [];

/** The host a `Socket#connect` call dials, or null for an IPC path. */
function connectHost(args) {
  // net.connect() passes Socket#connect its already-normalised [options, cb].
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === "object") return first.path ? null : (first.host ?? "localhost");
  if (typeof first === "string" && Number.isNaN(Number(first))) return null;
  return typeof args[1] === "string" ? args[1] : "localhost";
}

// fetch (undici), node:http(s), tls and the AWS SDK all dial through here.
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function hermeticConnect(...args) {
  const host = connectHost(args);
  if (host === null || LOOPBACK.test(host.replace(/^\[|\]$/g, ""))) return realConnect.apply(this, args);
  violations.push(host);
  const error = new Error(`hermetic test: blocked a connection to non-loopback host ${host}`);
  process.nextTick(() => this.destroy(error));
  return this;
};

/** Return and clear the non-loopback hosts dialled since the last call. */
export function takeEgressViolations() {
  return violations.splice(0);
}

function assertNoEgress() {
  const hosts = takeEgressViolations();
  assert.deepEqual(hosts, [], `test dialled non-loopback hosts: ${hosts.join(", ")}`);
}

applyHermeticAwsEnv();
beforeEach(applyHermeticAwsEnv);
afterEach(assertNoEgress);
after(assertNoEgress);
