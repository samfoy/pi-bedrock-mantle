// Quick probe: which models accept /v1/chat/completions on bedrock-mantle?
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

const region = "us-east-2";
const host = `bedrock-mantle.${region}.api.aws`;
const credentials = fromIni({
  profile: process.env.BEDROCK_MANTLE_AWS_PROFILE || "openclaw-bedrock",
});
const signer = new SignatureV4({ credentials, service: "bedrock", region, sha256: Sha256 });

async function probe(model) {
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "ping" }],
    stream: false,
  });
  const headers = {
    host,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  };
  const signed = await signer.sign({
    method: "POST",
    protocol: "https:",
    hostname: host,
    path: "/v1/chat/completions",
    headers,
    body,
  });
  const res = await fetch(`https://${host}/v1/chat/completions`, {
    method: "POST",
    headers: signed.headers,
    body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _raw: text };
  }
  return { status: res.status, error: parsed.error?.message, ok: res.ok };
}

for (const m of [
  "openai.gpt-5.5",
  "openai.gpt-5.4",
  "openai.gpt-oss-120b",
  "openai.gpt-oss-20b",
  "deepseek.v3.2",
  "qwen.qwen3-32b",
]) {
  const r = await probe(m);
  console.log(`${m.padEnd(28)} status=${r.status} ${r.ok ? "OK" : `error="${r.error}"`}`);
}
