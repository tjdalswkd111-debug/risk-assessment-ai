// netlify/functions/analyze.mjs

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}

function cleanJsonText(text = "") {
  return String(text)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function normalizeAllowedItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => {
      if (typeof item === "string") {
        return {
          value: item.trim(),
          label: item.trim()
        };
      }

      return {
        value: String(item?.value || "").trim(),
        label: String(
          item?.label ||
          item?.text ||
          item?.value ||
          ""
        ).trim()
      };
    })
    .filter((item) => item.value);
}

function normalizeImages(body) {
  const source =
    body?.images ||
    body?.photos ||
    body?.imageData ||
    [];

  if (!Array.isArray(source)) return [];

  return source
    .map((img) => {
      if (typeof img === "string") {
        const match = img.match(
          /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/
        );

        if (match) {
          return {
            mimeType: match[1],
            data: match[2]
          };
        }

        return {
          mimeType: "image/jpeg",
          data: img
        };
      }

      let data =
        img?.data ||
        img?.base64 ||
        img?.image ||
        "";

      let mimeType =
        img?.mimeType ||
        img?.mime_type ||
        img?.type ||
        "image/jpeg";

      if (typeof data === "string") {
        const match = data.match(
          /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/
        );

        if (match) {
          mimeType = match[1];
          data = match[2];
        }
      }

      return {
        mimeType,
        data
      };
    })
    .filter((img) => img.data);
}

function clampConfidence(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.max(0, Math.min(100, Math.round(n)));
}

function sanitizeEntries(entries, allowedSet) {
  if (!Array.isArray(entries)) return [];

  const seen = new Set();
  const result = [];

  for (const item of entries) {
    const value = String(item?.value || "").trim();

    if (!value) continue;
    if (!allowedSet.has(value)) continue;
    if (seen.has(value)) continue;

    seen.add(value);

    result.push({
      value,
      confidence: clampConfidence(item?.confidence),
      reason: String(item?.reason || "").trim()
    });
  }

  return result;
}

function sanitizeResult(data, allowedItems) {
  const allowedSet = new Set(
    allowedItems.map((item) => item.value)
  );

  let selected = sanitizeEntries(
    data?.selected_values,
    allowedSet
  );

  let review = sanitizeEntries(
    data?.review_values,
    allowedSet
  );

  let excluded = sanitizeEntries(
    data?.excluded_values,
    allowedSet
  );

  // 서버에서도 신뢰도 기준을 강제로 적용
  // 80 이상만 selected
  const movedToReview = [];

  selected = selected.filter((item) => {
    if (item.confidence >= 80 && item.reason.length >= 4) {
      return true;
    }

    if (item.confidence >= 50) {
      movedToReview.push(item);
    }

    return false;
  });

  review = [...review, ...movedToReview]
    .filter(
      (item) =>
        item.confidence >= 50 &&
        item.confidence < 80
    );

  const selectedValues = new Set(
    selected.map((item) => item.value)
  );

  review = review.filter(
    (item) => !selectedValues.has(item.value)
  );

  const reviewValues = new Set(
    review.map((item) => item.value)
  );

  excluded = excluded.filter(
    (item) =>
      !selectedValues.has(item.value) &&
      !reviewValues.has(item.value)
  );

  return {
    facts: Array.isArray(data?.facts)
      ? data.facts
          .map((f) => ({
            photo: Number(f?.photo) || 1,
            fact: String(f?.fact || "").trim()
          }))
          .filter((f) => f.fact)
      : [],

    selected_values: selected,
    review_values: review,
    excluded_values: excluded,

    summary: String(data?.summary || "").trim(),
    guidance: String(data?.guidance || "").trim(),
    special_note: String(data?.special_note || "").trim(),

    overall_confidence: clampConfidence(
      data?.overall_confidence
    )
  };
}

export async function handler(event) {
  // 브라우저 사전 요청
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: jsonHeaders,
      body: ""
    };
  }

  // 설치 확인용
  if (event.httpMethod === "GET") {
    return response(200, {
      ok: true,
      service: "risk-ai-gemini",
      apiKeyConfigured: Boolean(GEMINI_API_KEY),
      model: GEMINI_MODEL
    });
  }

  if (event.httpMethod !== "POST") {
    return response(405, {
      error: "POST 요청만 지원합니다."
    });
  }

  if (!GEMINI_API_KEY) {
    return response(500, {
      error:
        "Netlify 환경변수 GEMINI_API_KEY가 설정되지 않았습니다."
    });
  }

  try {
    let body;

    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return response(400, {
        error: "요청 JSON 형식이 올바르지 않습니다."
      });
    }

    const allowedItems = normalizeAllowedItems(
      body.allowed_items ||
      body.allowedItems ||
      []
    );

    const images = normalizeImages(body);

    if (!images.length) {
      return response(400, {
        error: "분석할 현장 사진이 없습니다."
      });
    }

    if (!allowedItems.length) {
      return response(400, {
        error: "allowed_items가 없습니다."
      });
    }

    // 최대 5장
    const selectedImages = images.slice(0, 5);

    const allowedText = allowedItems
      .map(
        (item) =>
          `- value: ${item.value} | 항목: ${item.label}`
      )
      .join("\n");

    const prompt = `
당신은 현장 안전관리 및 위험성평가 보조 AI입니다.

첨부된 현장 사진들을 함께 분석하세요.

이 분석 결과는 기존 HTML 위험성평가표에
자동 반영됩니다.

[최우선 원칙]

1. 먼저 사진에서 실제로 확인되는 객관적 사실만 추출하세요.

예:
- 사다리
- 차량
- 도로
- 전선
- 전기설비
- 작업발판
- 개구부
- 적치물
- 인화물
- 공구
- 인양물
- 물기
- 작업높이
- 중장비

2. 사진에 보이지 않는 사항을 추측하지 마세요.

다음 사항은 사진에서 명확히 확인되지 않으면
사실처럼 단정하지 마세요.

- 작업자의 실제 작업방법
- 보호구 착용 여부
- 전원 차단 여부
- 접지 여부
- 설비 고정상태
- 신호수 배치 여부
- 관리감독자 유무
- 안전조치 실제 시행 여부

3. 사진의 객관적 사실과 직접 연결되는
위험성평가 항목만 선택하세요.

4. 아래 allowed_items에 존재하는 value만
사용할 수 있습니다.

5. allowed_items에 없는 새로운 value를
절대 생성하지 마세요.

6. 동일한 위험을 여러 항목으로 과도하게
중복 선택하지 마세요.

7. 사진만으로 판단하기 어려우면
selected_values에 넣지 말고
review_values에 넣으세요.

[신뢰도 기준]

80~100:
사진 근거가 명확함.
selected_values 후보.

50~79:
가능성은 있으나 사진만으로 확정하기 어려움.
review_values.

0~49:
자동 체크하지 않음.
필요한 경우 excluded_values.

중요:
selected_values는 confidence 80 이상인 경우만
허용합니다.

각 선택 항목에는 사진에서 확인되는
구체적인 근거(reason)를 작성하세요.

[허용된 위험성평가 항목]

${allowedText}

[반환 형식]

설명이나 Markdown을 추가하지 말고
반드시 JSON 객체 하나만 반환하세요.

{
  "facts": [
    {
      "photo": 1,
      "fact": "사진에서 확인되는 객관적 사실"
    }
  ],

  "selected_values": [
    {
      "value": "allowed_items의 정확한 value",
      "confidence": 90,
      "reason": "사진에서 확인되는 구체적인 근거"
    }
  ],

  "review_values": [
    {
      "value": "allowed_items의 정확한 value",
      "confidence": 65,
      "reason": "현장 재확인이 필요한 이유"
    }
  ],

  "excluded_values": [],

  "summary": "사진 기반 위험성평가 요약",

  "guidance":
    "작업자가 현장에서 바로 이해할 수 있는 안전조치 안내",

  "special_note":
    "필요한 특이사항. 사진만으로 판단이 어려운 내용은 현장 재확인 필요라고 명시",

  "overall_confidence": 85
}

정확도를 우선하세요.
확실하지 않은 위험을 억지로 선택하지 마세요.
`;

    const parts = [
      {
        text: prompt
      }
    ];

    for (const img of selectedImages) {
      parts.push({
        inline_data: {
          mime_type: img.mimeType,
          data: img.data
        }
      });
    }

    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(GEMINI_MODEL)}:generateContent`;

    const geminiResponse = await fetch(endpoint, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
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
          responseMimeType: "application/json"
        }
      })
    });

    const geminiData = await geminiResponse.json();

    if (!geminiResponse.ok) {
      console.error(
        "Gemini API error:",
        JSON.stringify(geminiData)
      );

      return response(geminiResponse.status, {
        error:
          geminiData?.error?.message ||
          "Gemini API 호출에 실패했습니다.",

        code:
          geminiData?.error?.code ||
          geminiResponse.status
      });
    }

    const rawText =
      geminiData?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text || "")
        .join("") || "";

    if (!rawText) {
      return response(502, {
        error: "Gemini에서 분석 결과를 받지 못했습니다."
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(cleanJsonText(rawText));
    } catch (err) {
      console.error("JSON parse error:", rawText);

      return response(502, {
        error:
          "Gemini 분석 결과를 JSON으로 변환하지 못했습니다.",

        raw:
          rawText.substring(0, 1000)
      });
    }

    const finalResult = sanitizeResult(
      parsed,
      allowedItems
    );

    return response(200, {
      ok: true,
      ...finalResult
    });

  } catch (error) {
    console.error("Server error:", error);

    return response(500, {
      error:
        error?.message ||
        "AI 분석 서버에서 오류가 발생했습니다."
    });
  }
}
