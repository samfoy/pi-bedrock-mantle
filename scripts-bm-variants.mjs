// Variant of the replay: take a captured request, mutate parameters, run N
// times, summarize empty rate. Used to test whether reasoning.effort or
// model swap (5.5 → 5.4) changes the failure rate.
//
// Usage: node scripts-bm-variants.mjs <dump-file> <attempts-per-variant>
import { readFileSync } from "node:fs";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

const [, , dumpPath, nStr] = process.argv;
if (!dumpPath) {
  console.error("usage: node scripts-bm-variants.mjs <dump-file> [N]");
  process.exit(2);
}
const N = parseInt(nStr || "10", 10);

const dump = JSON.parse(readFileSync(dumpPath, "utf-8"));
const baseRequest = dump.request;
if (!baseRequest) {
  console.error("dump has no .request field");
  process.exit(1);
}

const region = "us-east-2";
const host = `bedrock-mantle.${region}.api.aws`;
const path = "/openai/v1/responses";
const credentials = fromIni({
  profile: process.env.BEDROCK_MANTLE_AWS_PROFILE || "openclaw-bedrock",
});
const signer = new SignatureV4({ credentials, service: "bedrock", region, sha256: Sha256 });

async function runOnce(body) {
  const bodyStr = JSON.stringify({ ...body, stream: false });
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
  const r = json.response ?? json;
  const types = (r.output ?? []).map((it) => it.type);
  const empty = types.length === 0 && (r.usage?.output_tokens ?? 0) === 0;
  return {
    status: res.status,
    latency: Date.now() - t0,
    types,
    output_tokens: r.usage?.output_tokens ?? 0,
    reasoning_tokens: r.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    empty,
  };
}

async function trial(label, mutator) {
  const body = mutator(structuredClone(baseRequest));
  let empties = 0;
  for (let i = 0; i < N; i++) {
    const r = await runOnce(body);
    if (r.empty) empties++;
    process.stderr.write(r.empty ? "X" : ".");
  }
  process.stderr.write("\n");
  console.log(`${label}: ${empties}/${N} empty (${((empties / N) * 100).toFixed(0)}%)`);
}

console.log(`Running ${N} attempts per variant against ${dumpPath}`);
console.log("legend: . = produced output, X = empty completion\n");

await trial("gpt-5.5 effort=medium (baseline)", (b) => b);
await trial("gpt-5.5 effort=minimal       ", (b) => ({ ...b, reasoning: { ...b.reasoning, effort: "minimal" } }));
await trial("gpt-5.5 effort=low           ", (b) => ({ ...b, reasoning: { ...b.reasoning, effort: "low" } }));
await trial("gpt-5.5 effort=high          ", (b) => ({ ...b, reasoning: { ...b.reasoning, effort: "high" } }));
await trial("gpt-5.4 effort=medium        ", (b) => ({ ...b, model: "openai.gpt-5.4", reasoning: { ...b.reasoning, effort: "medium" } }));
await trial("gpt-5.5 no tools             ", (b) => { const c = { ...b }; delete c.tools; return c; });
