// One-off forensic helper: sign + POST a hand-crafted request to bedrock-mantle
// directly, bypassing pi entirely. Used to isolate whether empty-completion is
// caused by gpt-5.5 itself or by the way pi shapes its requests.
//
// Usage: node scripts-bm-direct.mjs '<json-body>'
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

const [, , bodyStr] = process.argv;
const region = "us-east-2";
const host = `bedrock-mantle.${region}.api.aws`;
const path = "/openai/v1/responses";

const credentials = fromIni({
  profile: process.env.BEDROCK_MANTLE_AWS_PROFILE || "openclaw-bedrock",
});
const signer = new SignatureV4({
  credentials,
  service: "bedrock",
  region,
  sha256: Sha256,
});

const headers = {
  host,
  "content-type": "application/json",
  "content-length": String(Buffer.byteLength(bodyStr, "utf-8")),
};
const signed = await signer.sign({
  method: "POST",
  protocol: "https:",
  hostname: host,
  path,
  headers,
  body: bodyStr,
});

const t0 = Date.now();
const res = await fetch(`https://${host}${path}`, {
  method: "POST",
  headers: signed.headers,
  body: bodyStr,
});
const text = await res.text();
const dt = Date.now() - t0;
console.error(`status=${res.status} latency_ms=${dt}`);
console.log(text);
