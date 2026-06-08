// Probe bedrock-mantle /v1/models across regions for OpenAI gpt models.
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni } from "@aws-sdk/credential-providers";
import { SignatureV4 } from "@smithy/signature-v4";

const REGIONS = [
  "us-east-1", "us-east-2", "us-west-2", "us-west-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1",
  "ap-northeast-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2",
  "ap-south-1", "ca-central-1", "sa-east-1",
];

const creds = fromIni({ profile: process.env.BEDROCK_MANTLE_AWS_PROFILE || "personal-dev" });

async function probe(region) {
  const host = `bedrock-mantle.${region}.api.aws`;
  const signer = new SignatureV4({ credentials: creds, service: "bedrock", region, sha256: Sha256 });
  try {
    const signed = await signer.sign({
      method: "GET", protocol: "https:", hostname: host, path: "/v1/models",
      headers: { host },
    });
    const ctrl = AbortSignal.timeout(8000);
    const res = await fetch(`https://${host}/v1/models`, { headers: signed.headers, signal: ctrl });
    if (!res.ok) return { region, status: res.status, gpt5: [], total: 0, err: `HTTP ${res.status}` };
    const body = await res.json();
    const ids = (body.data || body.models || []).map((m) => m.id || m.model || m.name).filter(Boolean);
    const gpt5 = ids.filter((id) => /gpt-5/.test(id));
    const gptAny = ids.filter((id) => /gpt|openai/i.test(id));
    return { region, status: 200, total: ids.length, gpt5, gptAny };
  } catch (e) {
    return { region, status: "ERR", gpt5: [], total: 0, err: (e.cause?.code || e.name || String(e)).slice(0, 60) };
  }
}

const results = await Promise.all(REGIONS.map(probe));
for (const r of results) {
  if (r.status === 200) {
    console.log(`${r.region.padEnd(16)} OK  total=${String(r.total).padStart(3)}  gpt-5=[${r.gpt5.join(", ")}]  gptAny=${r.gptAny.length}`);
  } else {
    console.log(`${r.region.padEnd(16)} ${String(r.status).padEnd(4)} ${r.err}`);
  }
}
