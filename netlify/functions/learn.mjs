import { connectLambda, getStore } from "@netlify/blobs";
import { createHash, randomUUID } from "node:crypto";

const STORE_NAME = "risk-ai-learning";
const ENVIRONMENTS = new Set(["나대지","전주","강관주","철탑","건물안","터널","옥상","옥탑"]);

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function clean(v, max = 300) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeImage(v) {
  const s = String(v || "");
  if (!/^data:image\/jpeg;base64,/i.test(s)) return "";
  if (s.length > 1_100_000) return "";
  return s;
}

function compactItem(x) {
  if (!x || typeof x !== "object") return null;
  const value = clean(x.value, 120);
  if (!value) return null;
  return {
    value,
    label: clean(x.label, 180),
    category: clean(x.category, 120),
    role: clean(x.role, 80)
  };
}

async function updateProfile(store, env, compactExample) {
  if (!env || !ENVIRONMENTS.has(env)) return;

  const key = `profiles/${env}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await store.getWithMetadata(key, { type: "json", consistency: "strong" }).catch(() => null);
    const prev = Array.isArray(current?.data?.examples) ? current.data.examples : [];

    const fingerprint = JSON.stringify([
      compactExample.selected_values,
      compactExample.additional_risk,
      compactExample.countermeasure
    ]);

    const next = prev.filter(x =>
      JSON.stringify([x.selected_values, x.additional_risk, x.countermeasure]) !== fingerprint
    );
    next.push(compactExample);

    const options = current?.etag
      ? { onlyIfMatch: current.etag }
      : { onlyIfNew: true };

    const result = await store.setJSON(
      key,
      {
        environment: env,
        examples: next.slice(-24),
        updated_at: new Date().toISOString()
      },
      options
    );

    if (result.modified) return;
  }
}

export const handler = async (event) => {
  connectLambda(event);
  const store = getStore(STORE_NAME);

  if (event.httpMethod === "GET") {
    const { blobs } = await store.list({ prefix: "examples/" });
    const counts = {};

    for (const b of blobs || []) {
      const parts = String(b.key || "").split("/");
      const env = parts[1] || "미분류";
      counts[env] = (counts[env] || 0) + 1;
    }

    return reply(200, {
      ok: true,
      total: (blobs || []).length,
      counts
    });
  }

  if (event.httpMethod !== "POST") {
    return reply(405, { ok: false, error: "Method not allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { ok: false, error: "요청 JSON 형식이 올바르지 않습니다." });
  }

  const environmentRaw = clean(body.environment, 20);
  const environment = ENVIRONMENTS.has(environmentRaw) ? environmentRaw : "미분류";

  const images = Array.isArray(body.images)
    ? body.images.map(safeImage).filter(Boolean).slice(0, 3)
    : [];

  if (!images.length) {
    return reply(400, { ok: false, error: "학습할 현장 사진이 없습니다." });
  }

  const selected_items = Array.isArray(body.selected_items)
    ? body.selected_items.map(compactItem).filter(Boolean).slice(0, 80)
    : [];

  const facts = Array.isArray(body.facts)
    ? body.facts.map(x => clean(x, 220)).filter(Boolean).slice(0, 8)
    : [];

  const example = {
    schema_version: 2,
    environment,
    images,
    facts,
    selected_items,
    additional_risk: clean(body.additional_risk, 80),
    countermeasure: clean(body.countermeasure, 100),
    weather: {
      temperature: clean(body?.weather?.temperature, 20),
      apparent_temperature: clean(body?.weather?.apparent_temperature, 20)
    },
    saved_at: clean(body.saved_at, 40) || new Date().toISOString()
  };

  // 동일 사진 + 동일 최종 수정값 중복 저장 방지
  const hash = createHash("sha256")
    .update(JSON.stringify({
      environment: example.environment,
      image: example.images[0],
      selected: example.selected_items.map(x => x.value).sort(),
      risk: example.additional_risk,
      todo: example.countermeasure
    }))
    .digest("hex");

  const dedupe = await store.set(
    `dedupe/${hash}`,
    example.saved_at,
    { onlyIfNew: true }
  );

  if (!dedupe.modified) {
    return reply(200, { ok: true, duplicate: true });
  }

  const key = `examples/${environment}/${Date.now()}-${randomUUID()}`;

  await store.setJSON(key, example, {
    metadata: {
      environment,
      saved_at: example.saved_at
    }
  });

  if (ENVIRONMENTS.has(environment)) {
    // 각 작업환경의 최신 확정 사진 사례 1건
    await store.setJSON(`latest/${environment}`, example);

    // 사진 없이 최종 사람이 수정한 패턴을 최근 24건까지 누적
    const compactExample = {
      selected_values: example.selected_items.map(x => x.value),
      selected_labels: example.selected_items.map(x => x.label).filter(Boolean),
      additional_risk: example.additional_risk,
      countermeasure: example.countermeasure,
      saved_at: example.saved_at
    };

    await updateProfile(store, environment, compactExample);
  }

  return reply(200, {
    ok: true,
    duplicate: false,
    key,
    environment
  });
};
