// Mutation sweep specifically focused on the "first-call concentration"
// hypothesis: does the empty-completion rate drop when the captured
// first-call request is mutated to LOOK like a later turn (e.g. with prior
// assistant content in the input)?
//
// Larger N (30 per variant) for statistical power on a 10–20% baseline rate.
// Usage: node scripts-bm-firstcall.mjs <dump-file> [N]
import { readFileSync } from "node:fs";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

const [, , dumpPath, nStr] = process.argv;
if (!dumpPath) {
  console.error("usage: node scripts-bm-firstcall.mjs <dump-file> [N]");
  process.exit(2);
}
const N = parseInt(nStr || "30", 10);

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
    latency: Date.now() - t0,
    types,
    empty,
    cached_input_tokens: r.usage?.input_tokens_details?.cached_tokens ?? 0,
    input_tokens: r.usage?.input_tokens ?? 0,
  };
}

async function trial(label, mutator) {
  const body = mutator(structuredClone(baseRequest));
  let empties = 0;
  let totalCached = 0;
  for (let i = 0; i < N; i++) {
    const r = await runOnce(body);
    if (r.empty) empties++;
    totalCached += r.cached_input_tokens;
    process.stderr.write(r.empty ? "X" : ".");
  }
  process.stderr.write("\n");
  const avgCached = Math.round(totalCached / N);
  console.log(`${label}: ${empties}/${N} empty (${((empties / N) * 100).toFixed(0)}%) avg_cached=${avgCached}`);
}

// Helpers
function lastUserText(input) {
  // Find the last user message and return its text.
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i].role === "user") {
      const c = input[i].content;
      if (Array.isArray(c)) return c[0]?.text ?? "";
      return typeof c === "string" ? c : "";
    }
  }
  return "";
}

console.log(`Baseline first-call shape from ${dumpPath}, ${N} attempts/variant\n`);

// ── Baseline: pi's exact captured first-call request, unmodified ────────────
await trial("V0 baseline (pi first-call shape)         ", (b) => b);

// ── Move the user question to the absolute last input position ──────────────
// Tests Sam's "first-call shape with trailing meta context" hypothesis.
await trial("V1 user question last (drop trailing meta)", (b) => {
  // Find the user question (position 4 in our captured request) and the
  // trailing meta message; reorder so the user question is last.
  const userQuestionIdx = b.input.findIndex((m) =>
    m.role === "user" && Array.isArray(m.content) &&
    m.content[0]?.text?.startsWith("List the .ts files")
  );
  if (userQuestionIdx === -1) return b;
  const userMsg = b.input[userQuestionIdx];
  const rest = b.input.filter((_, i) => i !== userQuestionIdx);
  return { ...b, input: [...rest, userMsg] };
});

// ── Add a fake prior assistant message + tool result so this looks like a
//    "second turn" rather than a fresh first-call to the model.
await trial("V2 fake prior assistant turn (simulate 2nd call)", (b) => {
  const userQ = lastUserText(b.input) || "List the .ts files in this directory and tell me how many there are.";
  const fakeAssistant = {
    role: "assistant",
    content: [{
      type: "output_text",
      text: "I'll check the directory now.",
    }],
  };
  return { ...b, input: [...b.input, fakeAssistant, b.input[b.input.length - 1]] };
});

// ── Drop the prompt_cache_key so cache state is identical to a brand-new turn
await trial("V3 no prompt_cache_key                       ", (b) => {
  const c = { ...b };
  delete c.prompt_cache_key;
  return c;
});

// ── Drop the meta-info trailing message entirely
await trial("V4 drop trailing 'knowledge-search overview'  ", (b) => {
  // Drop the last input if it's a "knowledge-search" overview message.
  const last = b.input[b.input.length - 1];
  if (last?.role === "user" && Array.isArray(last.content) &&
      typeof last.content[0]?.text === "string" &&
      last.content[0].text.startsWith("## Knowledge-search")) {
    return { ...b, input: b.input.slice(0, -1) };
  }
  return b;
});
