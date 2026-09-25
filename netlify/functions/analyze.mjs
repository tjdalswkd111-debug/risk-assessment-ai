import { connectLambda, getStore } from "@netlify/blobs";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const STORE_NAME = "risk-ai-learning";

const ENVIRONMENTS = ["나대지","전주","강관주","철탑","건물안","터널","옥상","옥탑"];
const ENV_SET = new Set(ENVIRONMENTS);

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

function clean(v, max = 500) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function limitTen(v) {
  return Array.from(clean(v, 100)).slice(0, 10).join("").trim();
}

function isBannedMetaSentence(v) {
  const s = clean(v, 600);
  if (!s) return false;

  return [
    /사진\s*만으로/i,
    /사진\s*상.*판단/i,
    /판단(?:이|하기)?\s*어렵/i,
    /판단(?:할)?\s*수\s*없/i,
    /판단\s*불가/i,
    /보호구\s*착용\s*여부/i,
    /개인보호구\s*착용\s*여부/i,
    /구체적(?:인)?\s*작업\s*방법/i,
    /작업\s*방법.*판단/i,
    /작업자\s*행동.*판단/i,
    /실제\s*작업\s*진행\s*여부/i,
    /안전대\s*체결\s*상태.*판단/i,
    /체결\s*상태.*확인/i,
    /현장\s*재확인/i,
    /재확인\s*필요/i,
    /현장\s*확인\s*필요/i,
    /최종\s*확인\s*필요/i,
    /확인되지\s*않/i,
    /확인이\s*어렵/i
  ].some(rx => rx.test(s));
}

function sanitizeOutputSentence(v, max = 500) {
  const s = clean(v, max);
  if (!s || isBannedMetaSentence(s)) return "";
  return s;
}

function parseImage(dataUrl) {
  const m = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

function normalizeAllowed(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();

  for (const x of items) {
    if (!x || typeof x !== "object") continue;

    const value = clean(x.value, 120);
    if (!value || seen.has(value)) continue;
    seen.add(value);

    out.push({
      value,
      label: clean(x.label, 180),
      category: clean(x.category, 140),
      role: clean(x.role, 80)
    });
  }

  return out.slice(0, 180);
}

function parseModelJson(text) {
  let t = String(text || "").trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) t = fenced[1].trim();

  try {
    return JSON.parse(t);
  } catch {}

  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");

  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {}
  }

  throw new Error("Gemini JSON 응답을 해석할 수 없습니다.");
}

function uncertain(s) {
  return isBannedMetaSentence(s) ||
    /(가능성|추정|의심|일\s*수|수\s*있|보일\s*수|어려움|판단\s*불가|확인\s*필요|재확인|확인되지\s*않)/i.test(
      clean(s, 500)
    );
}

function strongReason(reason) {
  const s = clean(reason, 500);
  if (s.length < 12 || uncertain(s)) return false;

  return /사진\s*\d+|보임|확인|노출|근접|가장자리|개구부|전선|차량|사다리|물기|적치|장비|불꽃|난간|높이|케이블|분전반|파손|미고정/i.test(s);
}

function sanitizeSummary(v) {
  let s = clean(v, 80)
    .replace(/^(추가\s*위험\s*요인|추가\s*위험요인|위험\s*요인|위험요인)\s*[:：-]?\s*/i, "");

  if (!s) return "";

  const neutral = /(맑은\s*날씨|보호구.*착용|안전모.*착용|안전조끼.*착용|안전화.*착용|작업\s*전\s*상태|통신\s*설비\s*구역)/i;
  const hazard = /(감전|누전|활선|추락|떨어짐|낙하|비래|충돌|교통사고|끼임|협착|화재|폭발|미끄럼|넘어짐|전도|붕괴|질식|중독|화상|베임|찔림|감김|익사|낙뢰|온열|저체온|결빙|개구부|단차|고소|가장자리|노출\s*전선|파손|불안정|장애물|적치물|물기|불꽃|인화물|미착용|미체결|미고정|통행\s*차량|주행\s*차량|장비\s*접근|낙석|산소\s*결핍|유해\s*가스)/i;

  if (neutral.test(s) && !hazard.test(s)) return "";
  if (!hazard.test(s)) return "";

  return limitTen(s);
}

function deterministicCountermeasure(risk, modelGuidance) {
  const r = clean(risk, 80);
  if (!r) return "";

  if (/감전|전기|누전|활선|전선/i.test(r)) return "누전검진기 확인";
  if (/차량|교통|주행|충돌/i.test(r)) return "신호수 배치";
  if (/사다리/i.test(r)) return "사다리 고정";
  if (/추락|떨어짐|고소|가장자리/i.test(r)) return "안전대 체결";
  if (/낙하|비래/i.test(r)) return "공구 결속";
  if (/화재|폭발|불꽃|인화/i.test(r)) return "소화기 비치";
  if (/끼임|협착/i.test(r)) return "접근 통제";
  if (/전도|넘어짐|미끄럼/i.test(r)) return "통로 정리";
  if (/건설장비|중장비|굴삭기|크레인/i.test(r)) return "작업반경 통제";
  if (/질식|산소|유해\s*가스/i.test(r)) return "환기 확인";
  if (/낙석|붕괴/i.test(r)) return "낙석구간 통제";
  if (/낙뢰/i.test(r)) return "기상 확인";

  let g = clean(modelGuidance, 80)
    .replace(/^(대책|안전\s*조치|안전조치)\s*[:：-]?\s*/i, "");

  if (uncertain(g)) g = "";

  return limitTen(g || "안전조치");
}

function sanitizeResult(raw, allowed) {
  const allowedMap = new Map(allowed.map(x => [x.value, x]));

  const normalizeEntries = arr => {
    if (!Array.isArray(arr)) return [];

    const out = [];
    const seen = new Set();

    for (const x of arr) {
      if (!x || typeof x !== "object") continue;

      const value = clean(x.value, 120);
      if (!allowedMap.has(value) || seen.has(value)) continue;
      seen.add(value);

      const reason = sanitizeOutputSentence(x.reason, 500);
      if (!reason) continue;

      out.push({
        value,
        confidence: Math.max(0, Math.min(100, Number(x.confidence) || 0)),
        reason
      });
    }

    return out;
  };

  const selectedRaw = normalizeEntries(raw?.selected_values);
  const reviewRaw = normalizeEntries(raw?.review_values);

  const selected_values = [];
  const review_values = [];

  for (const x of selectedRaw) {
    if (x.confidence >= 80 && strongReason(x.reason)) {
      selected_values.push(x);
    } else if (x.confidence >= 50) {
      review_values.push({
        ...x,
        confidence: Math.min(79, x.confidence)
      });
    }
  }

  for (const x of reviewRaw) {
    if (x.confidence >= 50 && x.confidence <= 79) {
      review_values.push(x);
    }
  }

  const selectedSet = new Set(selected_values.map(x => x.value));
  const seenReview = new Set();
  const finalReview = [];

  for (const x of review_values) {
    if (selectedSet.has(x.value) || seenReview.has(x.value)) continue;
    seenReview.add(x.value);
    finalReview.push(x);
  }

  const facts = Array.isArray(raw?.facts)
    ? raw.facts
        .map((x, i) => ({
          photo: Math.max(1, Number(x?.photo) || i + 1),
          fact: sanitizeOutputSentence(x?.fact, 240)
        }))
        .filter(x => x.fact)
        .slice(0, 12)
    : [];

  const environmentRaw = clean(raw?.environment, 20);
  const environment = ENV_SET.has(environmentRaw) ? environmentRaw : "";

  const summary = sanitizeSummary(sanitizeOutputSentence(raw?.summary, 80));
  const guidance = deterministicCountermeasure(
    summary,
    sanitizeOutputSentence(raw?.guidance, 80)
  );

  return {
    ok: true,
    environment,
    facts,
    selected_values,
    review_values: finalReview,
    excluded_values: [],
    summary: limitTen(summary),
    guidance: limitTen(guidance),
    overall_confidence: Math.max(0, Math.min(100, Number(raw?.overall_confidence) || 0))
  };
}

async function loadLearningReferences() {
  const store = getStore(STORE_NAME);

  const profiles = await Promise.all(
    ENVIRONMENTS.map(async env => {
      const p = await store.get(`profiles/${env}`, { type: "json", consistency: "strong" }).catch(() => null);
      return p
        ? {
            env,
            examples: Array.isArray(p.examples) ? p.examples.slice(-6) : []
          }
        : null;
    })
  );

  const latest = await Promise.all(
    ENVIRONMENTS.map(async env => {
      const x = await store.get(`latest/${env}`, { type: "json", consistency: "strong" }).catch(() => null);
      return x ? { env, ...x } : null;
    })
  );

  return {
    profiles: profiles.filter(Boolean),
    latest: latest.filter(Boolean)
  };
}

function learningProfileText(profiles) {
  if (!profiles.length) return "공유 학습사례 없음";

  const out = [];

  for (const p of profiles) {
    for (const x of p.examples || []) {
      out.push({
        environment: p.env,
        selected_values: Array.isArray(x.selected_values) ? x.selected_values : [],
        selected_labels: Array.isArray(x.selected_labels) ? x.selected_labels : [],
        additional_risk: Array.from(clean(x.additional_risk, 80)).slice(0,10).join(''),
        countermeasure: Array.from(clean(x.countermeasure, 100)).slice(0,10).join('')
      });
    }
  }

  return JSON.stringify(out.slice(-36));
}

export const handler = async (event) => {
  connectLambda(event);
  if (event.httpMethod === "GET") {
    return reply(200, {
      ok: true,
      service: "risk-ai-gemini-shared-learning",
      model: GEMINI_MODEL,
      apiKeyConfigured: !!GEMINI_API_KEY
    });
  }

  if (event.httpMethod !== "POST") {
    return reply(405, { ok: false, error: "Method not allowed" });
  }

  if (!GEMINI_API_KEY) {
    return reply(500, {
      ok: false,
      error: "GEMINI_API_KEY가 설정되어 있지 않습니다."
    });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, {
      ok: false,
      error: "요청 JSON 형식이 올바르지 않습니다."
    });
  }

  const allowed = normalizeAllowed(body.allowed_items);

  if (!allowed.length) {
    return reply(400, {
      ok: false,
      error: "allowed_items가 없습니다."
    });
  }

  const currentImages = Array.isArray(body.images)
    ? body.images.map(parseImage).filter(Boolean).slice(0, 5)
    : [];

  if (!currentImages.length) {
    return reply(400, {
      ok: false,
      error: "분석할 사진이 없습니다."
    });
  }

  const context = body.context && typeof body.context === "object"
    ? {
        assessment_datetime: clean(body.context.assessment_datetime, 40),
        what_do: clean(body.context.what_do, 100),
        temperature: clean(body?.context?.weather?.temperature, 20),
        apparent_temperature: clean(body?.context?.weather?.apparent_temperature, 20)
      }
    : {};

  const learning = await loadLearningReferences()
    .catch(() => ({ profiles: [], latest: [] }));

  const prompt = `
당신은 통신설비 현장의 사진 기반 위험성평가 AI입니다.

[작업환경]
현재 현장은 다음 8종 중 사진에서 가장 가까운 하나로 분류합니다.
나대지 / 전주 / 강관주 / 철탑 / 건물안 / 터널 / 옥상 / 옥탑

[정확도 최우선 원칙]
1. 작업환경 자체는 위험이 아닙니다. 옥상·옥탑·철탑이라는 이유만으로 추락을 자동 선택하지 마세요.
2. 사진에서 직접 보이는 객관적 사실을 먼저 판단하세요.
3. 정상적인 보호구 착용, 맑은 날씨, 통신설비가 있다는 사실은 추가 위험요인이 아닙니다.
4. 감전·추락·낙하물·차량충돌·끼임/협착·화재/폭발·넘어짐·장비충돌 등 실제 위험이 사진에서 확인될 때만 위험항목을 선택하세요.
5. selected_values는 직접적이고 명확한 사진근거가 있는 경우에만 confidence 80~100으로 반환하세요.
6. 추정/가능성 수준이면 review_values에 confidence 50~79로 반환하세요.
7. reason에는 반드시 "사진 N"과 구체적으로 보이는 근거를 적으세요.
8. 사진에 없는 전원차단, 접지, 장비고정, 신호수, 안전조치 시행 여부는 단정하지 마세요.
9. summary는 실제 '추가 위험요인'만 10자 이내로 작성하세요.
10. summary에 날씨, 현장 설명, PPE 정상착용 사실을 넣지 마세요. 실제 추가위험이 없으면 빈 문자열입니다.
11. guidance는 summary 위험에 직접 대응하는 대책만 10자 이내로 작성하세요.
12. special_note는 출력 JSON 키 자체를 만들지 마세요. 현장 특이사항은 AI 분석 대상이 아닙니다.
13. 사진으로 확인할 수 없는 보호구 착용 여부, 구체적인 작업 방법, 실제 작업 진행 여부를 설명하는 문장은 어떤 필드에도 작성하지 마세요.
14. 판단 근거가 부족하면 "판단 어려움", "현장 재확인 필요", "확인되지 않음" 같은 문장을 만들지 말고 해당 항목 자체를 생략하세요.
15. allowed_items 밖의 value는 절대 만들지 마세요.

[공유 학습사례의 의미]
아래 학습사례는 현장 작업자가 사진을 등록한 뒤 실제 현장에 맞게 체크항목/추가위험/대책을 직접 수정하고 "이미지 저장"을 눌러 확정한 최종 정답 사례입니다.
학습사례는 환경 분류, 위험명, 체크항목 매핑, 대책 표현의 참고자료입니다.
현재 사진의 직접적인 시각근거가 과거 학습사례보다 항상 우선합니다.
같은 작업환경이라는 이유만으로 과거 위험을 복사하지 마세요.

[현재 작업정보]
${JSON.stringify(context)}

[사람이 확정한 누적 학습 프로필]
${learningProfileText(learning.profiles)}

[허용 평가항목]
${JSON.stringify(allowed)}

[출력 JSON]
{
  "environment":"나대지|전주|강관주|철탑|건물안|터널|옥상|옥탑",
  "facts":[
    {"photo":1,"fact":"객관적으로 보이는 사실"}
  ],
  "selected_values":[
    {"value":"허용 value","confidence":90,"reason":"사진 1 ...에서 ...가 명확히 보임"}
  ],
  "review_values":[
    {"value":"허용 value","confidence":65,"reason":"사진 1 ...은 보이나 핵심 조건은 명확하지 않음"}
  ],
  "summary":"실제 추가 위험요인 10자 이내 또는 빈 문자열",
  "guidance":"summary에 직접 대응하는 대책 10자 이내 또는 빈 문자열",
  "overall_confidence":85
}
반드시 JSON 객체 하나만 반환하세요.
`.trim();

  const parts = [{ text: prompt }];

  // 사람이 최종 확정한 최신 사진사례: 환경별 1건
  let exampleImageCount = 0;

  for (const ex of learning.latest) {
    if (exampleImageCount >= 8) break;

    const image = Array.isArray(ex.images)
      ? parseImage(ex.images[0])
      : null;

    if (!image) continue;

    const labels = Array.isArray(ex.selected_items)
      ? ex.selected_items
          .map(x => clean(x.label || x.value, 120))
          .filter(Boolean)
          .slice(0, 20)
      : [];

    parts.push({
      text:
        `\n[사람이 확정한 참고사진 사례]\n` +
        `환경=${ex.env}\n` +
        `최종 체크=${JSON.stringify(labels)}\n` +
        `추가 위험=${Array.from(clean(ex.additional_risk, 80)).slice(0,10).join('') || "(없음)"}\n` +
        `대책=${Array.from(clean(ex.countermeasure, 100)).slice(0,10).join('') || "(없음)"}\n` +
        `아래 이미지는 위 최종값과 연결된 과거 참고사진입니다. 현재 사진 판단의 보조자료로만 사용하세요.`
    });

    parts.push({
      inline_data: {
        mime_type: image.mimeType,
        data: image.data
      }
    });

    exampleImageCount++;
  }

  parts.push({
    text: "\n[현재 분석 대상 사진] 아래부터는 이번에 새로 분석할 사진입니다."
  });

  currentImages.forEach((img, i) => {
    parts.push({ text: `현재 사진 ${i + 1}` });
    parts.push({
      inline_data: {
        mime_type: img.mimeType,
        data: img.data
      }
    });
  });

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent`;

  let response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts
          }
        ],
        generationConfig: {
          temperature: 0.1,
          topP: 0.8,
          maxOutputTokens: 4096,
          responseMimeType: "application/json"
        }
      })
    });
  } catch (e) {
    return reply(502, {
      ok: false,
      error: `Gemini 연결 실패: ${e.message}`
    });
  }

  const gemini = await response.json().catch(() => ({}));

  if (!response.ok) {
    return reply(response.status || 502, {
      ok: false,
      error: gemini?.error?.message || "Gemini API 오류"
    });
  }

  const outputText = (gemini?.candidates?.[0]?.content?.parts || [])
    .map(x => typeof x?.text === "string" ? x.text : "")
    .join("\n")
    .trim();

  try {
    const raw = parseModelJson(outputText);
    const result = sanitizeResult(raw, allowed);

    result.learning_examples_used = exampleImageCount;
    result.learning_profile_groups = learning.profiles.length;

    return reply(200, result);
  } catch (e) {
    return reply(502, {
      ok: false,
      error: e.message,
      raw: outputText.slice(0, 1500)
    });
  }
};
