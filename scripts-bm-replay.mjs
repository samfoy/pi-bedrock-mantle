// Replay a captured empty-completion request directly. Reads
// /tmp/bedrock-mantle-dumps/empty-*.json, extracts .request, signs with SigV4,
// posts to bedrock-mantle. Used to verify whether the request shape alone
// reliably triggers the empty-completion bug (vs. a transient stochastic
// model behavior).
//
// Usage: node scripts-bm-replay.mjs <dump-file> [N]
//   N: how many times to replay (default 5)
import { readFileSync } from "node:fs";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

const [, , dumpPath, nStr] = process.argv;
if (!dumpPath) {
  console.error("usage: node scripts-bm-replay.mjs <dump-file> [N]");
  process.exit(2);
}
const N = parseInt(nStr || "5", 10);

const dump = JSON.parse(readFileSync(dumpPath, "utf-8"));
const requestBody = dump.request;
if (!requestBody) {
  console.error("dump has no .request field — re-capture with the latest detector.");
  process.exit(1);
}

// Force non-streaming so we can parse the JSON response cleanly.
const body = { ...requestBody, stream: false };
const bodyStr = JSON.stringify(body);

const region = "us-east-2";
const host = `bedrock-mantle.${region}.api.aws`;
const path = "/openai/v1/responses";
const credentials = fromIni({
  profile: process.env.BEDROCK_MANTLE_AWS_PROFILE || "openclaw-bedrock",
});
const signer = new SignatureV4({ credentials, service: "bedrock", region, sha256: Sha256 });

let empties = 0;
let successes = 0;
console.error(`replaying ${dumpPath} (${bodyStr.length} bytes) ${N} times`);

for (let i = 1; i <= N; i++) {
  const headers = {
    host,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(bodyStr, "utf-8")),
  };
  const signed = await signer.sign({
    method: "POST", protocol: "https:", hostname: host, path, headers, body: bodyStr,
  });
  const t0 = Date.now();
  const res = await fetch(`https://${host}${path}`, {
    method: "POST", headers: signed.headers, body: bodyStr,
  });
  const json = await res.json();
  const dt = Date.now() - t0;

  const r = json.response ?? json;
  const itemTypes = (r.output ?? []).map((it) => it.type);
  const visible = (r.output ?? []).some((it) =>
    it.type === "message" && (it.content ?? []).some((b) =>
      (b.type === "output_text" || b.type === "text") && b.text?.length > 0
    )
  );
  const empty = !visible && (r.usage?.output_tokens ?? 0) === 0;
  if (empty) empties++; else successes++;

  console.error(
    `attempt=${i} status=${res.status} latency_ms=${dt} ` +
    `output_items=${itemTypes.length} types=${itemTypes.join(",") || "<none>"} ` +
    `output_tokens=${r.usage?.output_tokens ?? "?"} ` +
    `reasoning_tokens=${r.usage?.output_tokens_details?.reasoning_tokens ?? "?"} ` +
    `visible=${visible} EMPTY=${empty}`
  );
}

console.error(`\nSUMMARY: ${empties}/${N} empty, ${successes}/${N} produced output`);
