// Functional health check: minimal tool-using responses call to a region+model.
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

const region = process.argv[2] || "us-west-2";
const model = process.argv[3] || "openai.gpt-5.4";
const N = Number(process.argv[4] || 5);

const creds = fromIni({ profile: process.env.BEDROCK_MANTLE_AWS_PROFILE || "personal-dev" });
const host = `bedrock-mantle.${region}.api.aws`;
const signer = new SignatureV4({ credentials: creds, service: "bedrock", region, sha256: Sha256 });

const body = JSON.stringify({
  model,
  stream: true,
  input: [{ role: "user", content: "Use the get_time tool to tell me the time. Call the tool." }],
  tools: [{
    type: "function", name: "get_time", description: "Get current time",
    parameters: { type: "object", properties: {}, required: [] },
  }],
  reasoning: { effort: "medium" },
});

async function one(i) {
  const signed = await signer.sign({
    method: "POST", protocol: "https:", hostname: host, path: "/openai/v1/responses",
    headers: { host, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
    body,
  });
  try {
    const res = await fetch(`https://${host}/openai/v1/responses`, {
      method: "POST", headers: signed.headers, body, signal: AbortSignal.timeout(60000),
    });
    const txt = await res.text();
    const hasCompleted = /event: response\.completed/.test(txt);
    const hasFailed = /event: response\.failed/.test(txt);
    const errMatch = txt.match(/"code":"([^"]+)"/);
    const fc = /\"type\":\"function_call\"/.test(txt);
    console.log(`#${i} http=${res.status} completed=${hasCompleted} failed=${hasFailed} func_call=${fc} ${errMatch ? "err=" + errMatch[1] : ""} bytes=${txt.length}`);
  } catch (e) {
    console.log(`#${i} EXC ${(e.cause?.code || e.name || String(e)).slice(0, 50)}`);
  }
}

console.log(`probing ${region} / ${model} x${N}`);
for (let i = 1; i <= N; i++) await one(i);
