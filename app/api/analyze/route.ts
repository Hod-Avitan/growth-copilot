import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function POST(req: Request) {
  const { input } = await req.json();

  const prompt = `
You are a senior product analytics AI.

Return ONLY valid JSON. No explanations, no markdown.

INPUT:
${input}

OUTPUT FORMAT:
{
  "summary": string,
  "root_causes": string[],
  "recommended_actions": [
    {
      "action": string,
      "impact": number,
      "effort": number,
      "priority": number,
      "why": string
    }
  ],
  "risks": string[],
  "confidence": "low" | "medium" | "high"
}
`;

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const content = response.choices?.[0]?.message?.content;

    if (!content) {
      return Response.json({
        summary: "Empty AI response",
        root_causes: [],
        recommended_actions: [],
        risks: [],
        confidence: "low",
      });
    }

    let data;

    try {
      data = JSON.parse(content);
    } catch (err) {
      console.error("JSON parse error:", content);

      return Response.json({
        summary: "Invalid AI response format",
        root_causes: [],
        recommended_actions: [],
        risks: [],
        confidence: "low",
      });
    }

    return Response.json(data);
  } catch (error: any) {
    console.error("API ERROR:", error);

    return Response.json(
      {
        summary: "API request failed",
        root_causes: [],
        recommended_actions: [],
        risks: [],
        confidence: "low",
      },
      { status: 200 } // חשוב: לא לשבור frontend יותר
    );
  }
}
