// Diagnose gpt-5.5 server_error: sweep one variable at a time, N samples each.
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

const region = "us-east-2";
const creds = fromIni({ profile: process.env.BEDROCK_MANTLE_AWS_PROFILE || "personal-dev" });
const host = `bedrock-mantle.${region}.api.aws`;
const N = Number(process.argv[2] || 6);

const TOOL = {
  type: "function", name: "get_time", description: "Get current time",
  parameters: { type: "object", properties: {}, required: [] },
};
const callPrompt = "Use the get_time tool to tell me the time. Call the tool.";
const textPrompt = "Reply with exactly the word: pong. Do not call any tool.";

// each variant returns a request body object
const variants = {
  "5.5 baseline (tools, reason=med, stream)": { model: "openai.gpt-5.5", stream: true, tools: [TOOL], reasoning: { effort: "medium" }, input: [{ role: "user", content: callPrompt }] },
  "5.5 NO tools (reason=med, stream)":        { model: "openai.gpt-5.5", stream: true, reasoning: { effort: "medium" }, input: [{ role: "user", content: "Reply with the word pong." }] },
  "5.5 tools present, TEXT answer asked":     { model: "openai.gpt-5.5", stream: true, tools: [TOOL], reasoning: { effort: "medium" }, input: [{ role: "user", content: textPrompt }] },
  "5.5 reason=minimal":                       { model: "openai.gpt-5.5", stream: true, tools: [TOOL], reasoning: { effort: "minimal" }, input: [{ role: "user", content: callPrompt }] },
  "5.5 reason=low":                           { model: "openai.gpt-5.5", stream: true, tools: [TOOL], reasoning: { effort: "low" }, input: [{ role: "user", content: callPrompt }] },
  "5.5 reason=high":                          { model: "openai.gpt-5.5", stream: true, tools: [TOOL], reasoning: { effort: "high" }, input: [{ role: "user", content: callPrompt }] },
  "5.5 NO reasoning field":                   { model: "openai.gpt-5.5", stream: true, tools: [TOOL], input: [{ role: "user", content: callPrompt }] },
  "5.5 NON-stream":                           { model: "openai.gpt-5.5", stream: false, tools: [TOOL], reasoning: { effort: "medium" }, input: [{ role: "user", content: callPrompt }] },
  "5.5 max_output_tokens=4096":               { model: "openai.gpt-5.5", stream: true, tools: [TOOL], reasoning: { effort: "medium" }, max_output_tokens: 4096, input: [{ role: "user", content: callPrompt }] },
  "5.5 dated 2026-04-23":                     { model: "openai.gpt-5.5-2026-04-23", stream: true, tools: [TOOL], reasoning: { effort: "medium" }, input: [{ role: "user", content: callPrompt }] },
  "5.4 baseline (control)":                   { model: "openai.gpt-5.4", stream: true, tools: [TOOL], reasoning: { effort: "medium" }, input: [{ role: "user", content: callPrompt }] },
};

async function one(bodyObj) {
  const body = JSON.stringify(bodyObj);
  const signed = await new SignatureV4({ credentials: creds, service: "bedrock", region, sha256: Sha256 }).sign({
    method: "POST", protocol: "https:", hostname: host, path: "/openai/v1/responses",
    headers: { host, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, body,
  });
  try {
    const res = await fetch(`https://${host}/openai/v1/responses`, { method: "POST", headers: signed.headers, body, signal: AbortSignal.timeout(90000) });
    const txt = await res.text();
    if (res.status !== 200) { const j = txt.match(/"message":"([^"]+)"/); return `http${res.status}${j ? ":" + j[1].slice(0,40) : ""}`; }
    const completed = /"type":"response.completed"|event: response\.completed/.test(txt);
    const failed = /event: response\.failed|"type":"response.failed"/.test(txt);
    const fc = /"type":"function_call"/.test(txt);
    if (failed) { const e = txt.match(/"code":"([^"]+)"/); return `FAILED(${e ? e[1] : "?"})`; }
    if (completed) return fc ? "ok(func)" : "ok(text)";
    return "no-terminal";
  } catch (e) { return `EXC:${(e.cause?.code || e.name || "").slice(0,20)}`; }
}

for (const [name, bodyObj] of Object.entries(variants)) {
  const results = [];
  for (let i = 0; i < N; i++) results.push(await one(bodyObj));
  const tally = {};
  for (const r of results) tally[r] = (tally[r] || 0) + 1;
  console.log(name.padEnd(42), JSON.stringify(tally));
}
