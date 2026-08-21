import { asString, type AgentTool } from "./types";

type SentimentLabel = "bullish" | "bearish" | "neutral";

function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Ollama sentiment response was not JSON");
  }
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Ollama sentiment response was not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function normalizeSentiment(raw: Record<string, unknown>, fallback: string): {
  sentiment: SentimentLabel;
  score: number;
  reason: string;
} {
  const labelRaw = typeof raw.sentiment === "string" ? raw.sentiment.trim().toLowerCase() : "";
  let sentiment: SentimentLabel = "neutral";
  if (labelRaw === "bullish" || labelRaw === "bearish" || labelRaw === "neutral") {
    sentiment = labelRaw;
  }

  let score = 50;
  if (typeof raw.score === "number" && Number.isFinite(raw.score)) {
    score = raw.score;
  } else if (typeof raw.score === "string") {
    const parsed = Number(raw.score);
    if (Number.isFinite(parsed)) {
      score = parsed;
    }
  }
  score = Math.min(100, Math.max(0, score));

  const reason =
    typeof raw.reason === "string" && raw.reason.trim() !== ""
      ? raw.reason.trim()
      : fallback;

  return { sentiment, score, reason };
}

export async function analyze_sentiment(
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const text = asString(args.text);
  if (!text) {
    throw new Error("text is required");
  }

  const base = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const model = process.env.MODEL ?? "qwen2.5:7b";
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      messages: [
        {
          role: "system",
          content:
            'Score market sentiment of the user text. Return JSON only: {"sentiment":"bullish"|"bearish"|"neutral","score":0-100,"reason":"short explanation"}. score 0 is max bearish, 50 is neutral, 100 is max bullish.',
        },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json()) as { message?: { content?: string }; error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Ollama sentiment request failed (${response.status})`);
  }
  const content = body.message?.content?.trim() || "";
  return normalizeSentiment(extractJsonObject(content), content || "No reason provided");
}

export const sentimentTools: AgentTool[] = [
  {
    name: "analyze_sentiment",
    description:
      "Run Ollama to score text as bullish, bearish, or neutral. Returns sentiment, 0-100 score (50=neutral), and reason.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to score (tweet, headline, chat, token description, etc.)",
        },
      },
      required: ["text"],
    },
    execute: analyze_sentiment,
  },
];
