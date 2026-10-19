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
  trial_warning_remaining: number;
  periodic_warning_remaining: number;
  quota_exhausted_notice_enabled: boolean;
};

type QuotaReservationRecord = {
  usage: number;
  quota: number;
  window_start: Date | string;
};

type QuotaStatusRecord = {
  trial_enabled: boolean;
  trial_start_date: Date | string;
  trial_end_date: Date | string;
  trial_usage: number;
  trial_quota: number;
  periodic_start_date: Date | string;
  periodic_end_date: Date | string;
  periodic_usage: number;
  periodic_quota: number;
};

type Reservation = {
  allowed: boolean;
  quotaType?: QuotaType;
  remaining?: number;
  total?: number;
  warningThreshold?: number;
  windowStart?: Date | string;
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
  let quotaExhaustedNoticeEnabled = true;

  try {
    const configResult = await sql`
      SELECT
        trial_days,
        trial_quota,
        periodic_quota_days,
        periodic_quota,
        trial_warning_remaining,
        periodic_warning_remaining,
        quota_exhausted_notice_enabled
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

    quotaExhaustedNoticeEnabled =
      config.quota_exhausted_notice_enabled;

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

    // Renew an expired periodic quota window.
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

    // Reserve a trial request first.
    const trialReservationResult = await sql`
      UPDATE users
      SET trial_usage = trial_usage + 1
      WHERE user_uid = ${userUid}
        AND trial_enabled = TRUE
        AND trial_end_date > NOW()
        AND trial_usage < trial_quota
      RETURNING
        trial_usage AS usage,
        trial_quota AS quota,
        trial_start_date AS window_start
    `;

    const trialReservation =
      trialReservationResult as unknown as QuotaReservationRecord[];

    if (trialReservation.length > 0) {
      const record = trialReservation[0];

      reservation = {
        allowed: true,
        quotaType: "trial",
        remaining: record.quota - record.usage,
        total: record.quota,
        warningThreshold: config.trial_warning_remaining,
        windowStart: record.window_start,
      };
    } else {
      // If trial quota is unavailable, try periodic quota.
      const periodicReservationResult = await sql`
        UPDATE users
        SET periodic_usage = periodic_usage + 1
        WHERE user_uid = ${userUid}
          AND periodic_end_date > NOW()
          AND periodic_usage < periodic_quota
      RETURNING
        periodic_usage AS usage,
        periodic_quota AS quota,
        periodic_start_date AS window_start
      `;

      const periodicReservation =
        periodicReservationResult as unknown as QuotaReservationRecord[];

      if (periodicReservation.length > 0) {
        const record = periodicReservation[0];

        reservation = {
          allowed: true,
          quotaType: "periodic",
          remaining: record.quota - record.usage,
          total: record.quota,
          warningThreshold: config.periodic_warning_remaining,
          windowStart: record.window_start,
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
      {
        quota_exceeded: true,
        quota_exhausted_notice_enabled:
          quotaExhaustedNoticeEnabled,
      }
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

    const remaining = reservation.remaining ?? 0;
    const warningThreshold = reservation.warningThreshold ?? 0;

    const windowStart = reservation.windowStart;

    const windowId =
      windowStart instanceof Date
        ? windowStart.toISOString()
        : new Date(windowStart ?? "").toISOString();

    const quotaInfo = {
      type: quotaType,
      remaining,
      total: reservation.total ?? 0,
      warning_threshold: warningThreshold,
      warning_due:
        remaining > 0 && remaining <= warningThreshold,
      window_id: windowId,
      exhausted_notice_enabled: quotaExhaustedNoticeEnabled,
    };

    return Response.json({
      ...(data as Record<string, unknown>),
      quota: quotaInfo,
    });
  } catch {
    console.error("OpenAI API request failed.");

    await refundReservedQuota(userUid, quotaType);

    return errorResponse(
      "The analysis could not be completed. Please try again later.",
      502
    );
  }
}
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userUid = searchParams.get("user_uid");

  if (
    typeof userUid !== "string" ||
    !/^[a-zA-Z0-9]{32}$/.test(userUid)
  ) {
    return errorResponse("Invalid installation identifier.", 400);
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

  try {
    const configResult = await sql`
      SELECT
        trial_days,
        trial_quota,
        periodic_quota_days,
        periodic_quota,
        trial_warning_remaining,
        periodic_warning_remaining,
        quota_exhausted_notice_enabled
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

    // Register the installation if this is its first request.
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

    // Renew an expired periodic quota window.
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

    const userResult = await sql`
      SELECT
        trial_enabled,
        trial_start_date,
        trial_end_date,
        trial_usage,
        trial_quota,
        periodic_start_date,
        periodic_end_date,
        periodic_usage,
        periodic_quota
      FROM users
      WHERE user_uid = ${userUid}
      LIMIT 1
    `;

    const userRows = userResult as unknown as QuotaStatusRecord[];

    if (userRows.length === 0) {
      console.error("User quota record was not found.");

      return errorResponse(
        "The service is temporarily unavailable. Please try again later.",
        500
      );
    }

    const user = userRows[0];

    const trialIsAvailable =
      user.trial_enabled &&
      new Date(user.trial_end_date).getTime() > Date.now() &&
      user.trial_usage < user.trial_quota;

    const quotaType: QuotaType = trialIsAvailable
      ? "trial"
      : "periodic";

    const total =
      quotaType === "trial"
        ? user.trial_quota
        : user.periodic_quota;

    const used =
      quotaType === "trial"
        ? user.trial_usage
        : user.periodic_usage;

    const remaining = Math.max(0, total - used);

    const warningThreshold =
      quotaType === "trial"
        ? config.trial_warning_remaining
        : config.periodic_warning_remaining;

    const windowStart =
      quotaType === "trial"
        ? user.trial_start_date
        : user.periodic_start_date;

    const windowId = new Date(windowStart).toISOString();

    return Response.json(
      {
        quota: {
          type: quotaType,
          remaining,
          total,
          warning_threshold: warningThreshold,
          warning_due:
            remaining > 0 && remaining <= warningThreshold,
          window_id: windowId,
          exhausted_notice_enabled:
            config.quota_exhausted_notice_enabled,
        },
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch {
    console.error("Failed to retrieve quota status.");

    return errorResponse(
      "The service is temporarily unavailable. Please try again later.",
      500
    );
  }
}