// Probe whether bedrock-mantle exposes gpt-5.x on the OpenAI Chat Completions
// path, and if so whether the empty-completion bug also affects that path.
//
// Tests:
//   A. gpt-5.5 minimal chat-completions (no tools, no system) — does the
//      endpoint accept this model id at all?
//   B. gpt-5.5 with tools — does tool calling work via chat-completions?
//   C. If A+B work, do N replays exhibit empty-completion behavior?
//
// Usage: node scripts-bm-chatcompletions.mjs
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

const region = "us-east-2";
const host = `bedrock-mantle.${region}.api.aws`;
const credentials = fromIni({
  profile: process.env.BEDROCK_MANTLE_AWS_PROFILE || "openclaw-bedrock",
});
const signer = new SignatureV4({ credentials, service: "bedrock", region, sha256: Sha256 });

async function call(path, body) {
  const bodyStr = JSON.stringify(body);
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
  const text = await res.text();
  const dt = Date.now() - t0;
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, latency: dt, body: json };
}

console.log("=== A. gpt-5.5 minimal chat-completions (no tools) ===");
const a = await call("/v1/chat/completions", {
  model: "openai.gpt-5.5",
  messages: [{ role: "user", content: "Reply with the single word: pong. Nothing else." }],
  stream: false,
});
console.log(`status=${a.status} latency_ms=${a.latency}`);
if (a.status === 200) {
  const choice = a.body?.choices?.[0];
  console.log(`finish_reason=${choice?.finish_reason}`);
  console.log(`message=${JSON.stringify(choice?.message)?.slice(0, 200)}`);
  console.log(`usage=${JSON.stringify(a.body?.usage)}`);
} else {
  console.log("error body:", JSON.stringify(a.body).slice(0, 400));
}

console.log("\n=== B. gpt-5.5 chat-completions WITH tools ===");
const tools = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List the files in a directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];
const b = await call("/v1/chat/completions", {
  model: "openai.gpt-5.5",
  messages: [
    { role: "system", content: "You are a helpful assistant. Use tools when appropriate." },
    { role: "user", content: "List the files in /tmp." },
  ],
  tools,
  tool_choice: "auto",
  stream: false,
});
console.log(`status=${b.status} latency_ms=${b.latency}`);
if (b.status === 200) {
  const choice = b.body?.choices?.[0];
  console.log(`finish_reason=${choice?.finish_reason}`);
  console.log(`message.role=${choice?.message?.role}`);
  console.log(`message.content=${JSON.stringify(choice?.message?.content)?.slice(0, 200)}`);
  console.log(`tool_calls=${JSON.stringify(choice?.message?.tool_calls)?.slice(0, 300)}`);
  console.log(`usage=${JSON.stringify(b.body?.usage)}`);
} else {
  console.log("error body:", JSON.stringify(b.body).slice(0, 400));
}

if (a.status === 200 && b.status === 200) {
  console.log("\n=== C. Replay test: 20 chat-completions calls with tools, count empties ===");
  const N = 20;
  let empties = 0;
  for (let i = 1; i <= N; i++) {
    const r = await call("/v1/chat/completions", {
      model: "openai.gpt-5.5",
      messages: [
        { role: "system", content: "You are a helpful assistant. Use tools when appropriate." },
        { role: "user", content: "List the files in /tmp." },
      ],
      tools,
      tool_choice: "auto",
      stream: false,
    });
    const choice = r.body?.choices?.[0];
    const hasContent = (choice?.message?.content?.length ?? 0) > 0
      || (choice?.message?.tool_calls?.length ?? 0) > 0;
    const empty = !hasContent;
    if (empty) empties++;
    process.stderr.write(empty ? "X" : ".");
  }
  process.stderr.write("\n");
  console.log(`Empty rate: ${empties}/${N} (${((empties / N) * 100).toFixed(0)}%)`);
}
