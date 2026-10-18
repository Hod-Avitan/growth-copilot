import OpenAI from "openai";
import { neon } from "@neondatabase/serverless";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

type SupportedLanguage = "he" | "en";
type QuotaType = "trial" | "periodic";

type ConfigRecord = {
  trial_days: number;
  trial_quota: number;
  periodic_quota_days: number;
  periodic_quota: number;
};

type Reservation = {
  allowed: boolean;
  quotaType?: QuotaType;
};

function errorResponse(
  error: string,
  status: number,
  extra: Record<string, unknown> = {}
) {
  return Response.json({ error, ...extra }, { status });
}

async function refundReservedQuota(
  userUid: string,
  quotaType: QuotaType
) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("DATABASE_URL is not configured.");
    return;
  }

  const sql = neon(databaseUrl);

  try {
    if (quotaType === "trial") {
      await sql`
        UPDATE users
        SET trial_usage = GREATEST(trial_usage - 1, 0)
        WHERE user_uid = ${userUid}
      `;
    } else {
      await sql`
        UPDATE users
        SET periodic_usage = GREATEST(periodic_usage - 1, 0)
        WHERE user_uid = ${userUid}
      `;
    }
  } catch {
    console.error("Failed to refund reserved quota.");
  }
}

function isValidAnalysis(data: unknown): boolean {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  const result = data as Record<string, unknown>;

  return (
    typeof result.summary === "string" &&
    result.summary.trim().length > 0 &&
    Array.isArray(result.root_causes) &&
    result.root_causes.every((item) => typeof item === "string") &&
    Array.isArray(result.recommended_actions) &&
    result.recommended_actions.every((item) => {
      if (typeof item !== "object" || item === null) {
        return false;
      }

      const action = item as Record<string, unknown>;

      return (
        typeof action.action === "string" &&
        typeof action.why === "string" &&
        typeof action.impact === "number" &&
        Number.isInteger(action.impact) &&
        action.impact >= 1 &&
        action.impact <= 5 &&
        typeof action.effort === "number" &&
        Number.isInteger(action.effort) &&
        action.effort >= 1 &&
        action.effort <= 5 &&
        typeof action.priority === "number" &&
        Number.isInteger(action.priority) &&
        action.priority >= 1 &&
        action.priority <= 5
      );
    }) &&
    Array.isArray(result.risks) &&
    result.risks.every((item) => typeof item === "string") &&
    ["low", "medium", "high"].includes(String(result.confidence))
  );
}

export async function POST(req: Request) {
  let body: {
    input?: unknown;
    language?: unknown;
    user_uid?: unknown;
  };

  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid request body.", 400);
  }

  const { input } = body;

  const language: SupportedLanguage =
    body.language === "he" ? "he" : "en";

  const userUid = body.user_uid;

  if (
    typeof userUid !== "string" ||
    !/^[a-zA-Z0-9]{32}$/.test(userUid)
  ) {
    return errorResponse("Invalid installation identifier.", 400);
  }

  if (typeof input !== "string" || !input.trim()) {
    return errorResponse(
      "Please provide a description to analyze.",
      400
    );
  }

  if (input.trim().length > 10000) {
    return errorResponse(
      "Input is too long. Please shorten your description.",
      413
    );
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("DATABASE_URL is not configured.");

    return errorResponse(
      "The service is temporarily unavailable. Please try again later.",
      500
    );
  }

  const sql = neon(databaseUrl);

  let reservation: Reservation = { allowed: false };

  try {
    const configResult = await sql`
      SELECT
        trial_days,
        trial_quota,
        periodic_quota_days,
        periodic_quota
      FROM system_config
      WHERE id = 1
    `;

    const configRows = configResult as unknown as ConfigRecord[];

    if (configRows.length === 0) {
      console.error("System configuration was not found.");

      return errorResponse(
        "The service is temporarily unavailable. Please try again later.",
        500
      );
    }

    const config = configRows[0];

    // Create the user on their first request.
    await sql`
      INSERT INTO users (
        user_uid,
        installation_date,
        trial_enabled,
        trial_start_date,
        trial_end_date,
        trial_quota,
        trial_usage,
        periodic_quota,
        periodic_usage,
        periodic_start_date,
        periodic_end_date
      )
      VALUES (
        ${userUid},
        NOW(),
        TRUE,
        NOW(),
        NOW() + (${config.trial_days} * INTERVAL '1 day'),
        ${config.trial_quota},
        0,
        ${config.periodic_quota},
        0,
        NOW(),
        NOW() + (${config.periodic_quota_days} * INTERVAL '1 day')
      )
      ON CONFLICT (user_uid) DO NOTHING
    `;

    /*
     * Renew an expired periodic quota window.
     * The duration and quota are read from system_config.
     * The UPDATE condition prevents concurrent requests
     * from repeatedly renewing the same window.
     */
    await sql`
      UPDATE users
      SET
        periodic_usage = 0,
        periodic_quota = ${config.periodic_quota},
        periodic_start_date = NOW(),
        periodic_end_date =
          NOW() + (${config.periodic_quota_days} * INTERVAL '1 day')
      WHERE user_uid = ${userUid}
        AND periodic_end_date <= NOW()
    `;

    /*
     * Try to reserve a trial request first.
     *
     * The conditional UPDATE is atomic. Concurrent requests
     * cannot increment trial_usage beyond trial_quota.
     */
    const trialReservation = await sql`
      UPDATE users
      SET trial_usage = trial_usage + 1
      WHERE user_uid = ${userUid}
        AND trial_enabled = TRUE
        AND trial_end_date > NOW()
        AND trial_usage < trial_quota
      RETURNING id
    `;

    if (trialReservation.length > 0) {
      reservation = {
        allowed: true,
        quotaType: "trial",
      };
    } else {
      /*
       * If the trial is unavailable or exhausted,
       * try to reserve a periodic request.
       *
       * This is a separate conditional UPDATE, so the
       * quota limit is checked atomically by PostgreSQL.
       */
      const periodicReservation = await sql`
        UPDATE users
        SET periodic_usage = periodic_usage + 1
        WHERE user_uid = ${userUid}
          AND periodic_end_date > NOW()
          AND periodic_usage < periodic_quota
        RETURNING id
      `;

      if (periodicReservation.length > 0) {
        reservation = {
          allowed: true,
          quotaType: "periodic",
        };
      }
    }
  } catch {
    console.error("Failed to initialize user or reserve quota.");

    return errorResponse(
      "The service is temporarily unavailable. Please try again later.",
      500
    );
  }

  if (!reservation.allowed || !reservation.quotaType) {
    return errorResponse(
      "You have reached your current usage limit.",
      429,
      { quota_exceeded: true }
    );
  }

  const quotaType = reservation.quotaType;

  const languageInstruction =
    language === "he"
      ? `Respond entirely in Hebrew.
All user-facing text must be in natural, clear, professional Hebrew.
This includes the summary, root causes, recommended actions,
explanations, and risks.
Keep all JSON keys in English.
The confidence value must be exactly "low", "medium", or "high".`
      : `Respond entirely in English.
All user-facing text must be in clear, professional English.
Keep all JSON keys and confidence values exactly as specified.`;

  const prompt = `
You are a senior product analytics and decision-making AI.

${languageInstruction}

Analyze the user's challenge carefully.
Provide specific, practical, actionable recommendations.
Do not invent facts that the user has not provided.
Clearly distinguish assumptions from known information.

Return ONLY valid JSON.
Do not include Markdown or text outside the JSON.

USER INPUT:
${input.trim()}

OUTPUT FORMAT:
{
  "summary": "string",
  "root_causes": ["string"],
  "recommended_actions": [
    {
      "action": "string",
      "impact": 1,
      "effort": 1,
      "priority": 1,
      "why": "string"
    }
  ],
  "risks": ["string"],
  "confidence": "medium"
}

Requirements:
- impact, effort, and priority must be integers from 1 to 5.
- confidence must be "low", "medium", or "high".
- Include relevant, actionable recommendations.
- Keep all JSON keys in English.
- All user-facing text must follow the requested language.
`;

  try {
    const response = await client.chat.completions.create({
      model: "gpt-6-luna",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: { type: "json_object" },
      reasoning_effort: "none",
      max_completion_tokens: 3000,
    });

    const content = response.choices?.[0]?.message?.content;

    if (!content) {
      console.error("OpenAI returned an empty response.");

      await refundReservedQuota(userUid, quotaType);

      return errorResponse(
        "The AI returned an empty response. Please try again.",
        502
      );
    }

    let data: unknown;

    try {
      data = JSON.parse(content);
    } catch {
      console.error("OpenAI returned invalid JSON.");

      await refundReservedQuota(userUid, quotaType);

      return errorResponse(
        "The AI returned an invalid response. Please try again.",
        502
      );
    }

    if (!isValidAnalysis(data)) {
      console.error("OpenAI returned an unexpected response structure.");

      await refundReservedQuota(userUid, quotaType);

      return errorResponse(
        "The AI returned an unexpected response. Please try again.",
        502
      );
    }

    return Response.json(data);
  } catch {
    console.error("OpenAI API request failed.");

    await refundReservedQuota(userUid, quotaType);

    return errorResponse(
      "The analysis could not be completed. Please try again later.",
      502
    );
  }
}