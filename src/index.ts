import "dotenv/config";
import express from "express";
import { listTools, runChat } from "./agent";
import { get_launches, get_xrp_price } from "./tools/xrpl";

const PORT = Number(process.env.PORT) || 3100;
const MODEL = process.env.MODEL ?? "deepseek-r1:8b";
const MODEL_FAST = process.env.MODEL_FAST ?? "qwen2.5:7b";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    model: MODEL,
    model_fast: MODEL_FAST,
    uptime: process.uptime(),
  });
});

app.get("/v1/tools", (_req, res) => {
  res.json({ tools: listTools() });
});

async function liveSystemPromptData(): Promise<{
  xrpUsd: number | null;
  recentAmmLaunches: unknown[];
}> {
  const [priceResult, launchResult] = await Promise.allSettled([
    get_xrp_price(),
    get_launches({ limit: 3 }),
  ]);
  return {
    xrpUsd: priceResult.status === "fulfilled" ? priceResult.value.priceUsd : null,
    recentAmmLaunches:
      launchResult.status === "fulfilled" ? launchResult.value.launches.slice(0, 3) : [],
  };
}

app.post("/v1/chat", async (req, res) => {
  const prompt = req.body?.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  try {
    const live = await liveSystemPromptData();
    const systemPrompt = [
      "Live XRPL market data — treat this as system ground truth and answer with these figures. Do not invent prices or launches.",
      `Current XRP/USD price: ${live.xrpUsd ?? "unavailable"}`,
      `Top 3 recent AMM launches: ${JSON.stringify(live.recentAmmLaunches)}`,
    ].join("\n");
    const context = {
      system: systemPrompt,
      xrpUsd: live.xrpUsd,
      recentAmmLaunches: live.recentAmmLaunches,
      ...(req.body?.context != null ? { user_context: req.body.context } : {}),
    };
    const result = await runChat(prompt.trim(), context, MODEL);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat failed";
    res.status(502).json({ error: message });
  }
});

type TradeDecision = "buy" | "skip";

type DecisionResult = {
  decision: TradeDecision;
  confidence: number;
  reason: string;
};

type DecisionInput = {
  issuer: string;
  currency: string;
  poolXrp: number;
  poolTokens: number;
  launchAgeSeconds: number;
  source: string;
};

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseDecisionBody(body: unknown): DecisionInput | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "JSON body is required" };
  }
  const payload = body as Record<string, unknown>;
  const issuer = typeof payload.issuer === "string" ? payload.issuer.trim() : "";
  const currency = typeof payload.currency === "string" ? payload.currency.trim() : "";
  const source = typeof payload.source === "string" ? payload.source.trim() : "";
  const poolXrp = asFiniteNumber(payload.poolXrp);
  const poolTokens = asFiniteNumber(payload.poolTokens);
  const launchAgeSeconds = asFiniteNumber(payload.launchAgeSeconds);
  if (!issuer) {
    return { error: "issuer is required" };
  }
  if (!currency) {
    return { error: "currency is required" };
  }
  if (poolXrp === undefined) {
    return { error: "poolXrp is required" };
  }
  if (poolTokens === undefined) {
    return { error: "poolTokens is required" };
  }
  if (launchAgeSeconds === undefined) {
    return { error: "launchAgeSeconds is required" };
  }
  if (!source) {
    return { error: "source is required" };
  }
  return { issuer, currency, poolXrp, poolTokens, launchAgeSeconds, source };
}

function buildDecisionPrompt(data: DecisionInput): string {
  const impliedXrpPerToken = data.poolTokens > 0 ? data.poolXrp / data.poolTokens : null;
  return [
    "You are Agent3 making an internal TradeDesk launch decision.",
    "Decide whether to BUY or SKIP this XRPL token.",
    "Do NOT call buy_token or submit any payment. This route is analysis only.",
    "You MAY use read-only tools (get_price, get_xrp_price, get_launches, get_status, get_risk_settings, check_balance) if they help.",
    "Prefer skip when the pool is tiny, data is thin, or the launch looks like a sniping trap.",
    "",
    "Launch:",
    `- currency: ${data.currency}`,
    `- issuer: ${data.issuer}`,
    `- poolXrp: ${data.poolXrp}`,
    `- poolTokens: ${data.poolTokens}`,
    `- implied XRP per token: ${impliedXrpPerToken ?? "n/a"}`,
    `- launchAgeSeconds: ${data.launchAgeSeconds}`,
    `- source: ${data.source}`,
    "",
    "Return ONLY valid JSON with this exact shape:",
    '{"decision":"buy"|"skip","confidence":0.0,"reason":"short explanation"}',
    "confidence must be a number between 0 and 1.",
  ].join("\n");
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("No JSON object in model response");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

function normalizeDecision(raw: unknown, fallbackReason: string): DecisionResult {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const decisionRaw = typeof obj.decision === "string" ? obj.decision.trim().toLowerCase() : "";
  const decision: TradeDecision = decisionRaw === "buy" ? "buy" : "skip";
  let confidence = 0;
  if (typeof obj.confidence === "number" && Number.isFinite(obj.confidence)) {
    confidence = obj.confidence;
  } else if (typeof obj.confidence === "string") {
    const parsed = Number(obj.confidence);
    if (Number.isFinite(parsed)) {
      confidence = parsed;
    }
  }
  confidence = Math.min(1, Math.max(0, confidence));
  const reason =
    typeof obj.reason === "string" && obj.reason.trim() !== ""
      ? obj.reason.trim()
      : fallbackReason;
  return { decision, confidence, reason };
}

app.post("/v1/decision", async (req, res) => {
  const parsed = parseDecisionBody(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    const result = await runChat(buildDecisionPrompt(parsed), {
      system:
        "Internal TradeDesk decision. Do not execute buy_token or any payment. Reply with JSON only: {decision, confidence, reason}.",
      launch: parsed,
    }, MODEL_FAST);
    let decision: DecisionResult;
    try {
      decision = normalizeDecision(
        extractJsonObject(result.response),
        result.response.trim() || "Model did not return a parseable decision; defaulting to skip.",
      );
    } catch {
      decision = {
        decision: "skip",
        confidence: 0,
        reason: result.response.trim() || "Model did not return a parseable decision; defaulting to skip.",
      };
    }
    res.json(decision);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Decision failed";
    res.status(502).json({ error: message });
  }
});

type SentimentLabel = "bullish" | "bearish" | "neutral";

async function runSentiment(text: string): Promise<{
  sentiment: SentimentLabel;
  score: number;
  reason: string;
  model: string;
}> {
  const base = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL_FAST,
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
  const raw = extractJsonObject(content) as Record<string, unknown>;
  const labelRaw = typeof raw.sentiment === "string" ? raw.sentiment.trim().toLowerCase() : "";
  const sentiment: SentimentLabel =
    labelRaw === "bullish" || labelRaw === "bearish" || labelRaw === "neutral" ? labelRaw : "neutral";
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
      : content || "No reason provided";
  return { sentiment, score, reason, model: MODEL_FAST };
}

app.post("/v1/sentiment", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    res.json(await runSentiment(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sentiment failed";
    res.status(502).json({ error: message });
  }
});

app.post("/v1/trade-advice", async (req, res) => {
  const prompt = req.body?.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  try {
    const live = await liveSystemPromptData();
    const result = await runChat(
      prompt.trim(),
      {
        system: [
          "Trade-advice mode. Give a clear buy, hold, or skip recommendation with risk notes.",
          "Do not invent prices, balances, or transaction hashes.",
          `Current XRP/USD price: ${live.xrpUsd ?? "unavailable"}`,
          `Top 3 recent AMM launches: ${JSON.stringify(live.recentAmmLaunches)}`,
        ].join(" "),
        xrpUsd: live.xrpUsd,
        recentAmmLaunches: live.recentAmmLaunches,
        ...(req.body?.context != null ? { user_context: req.body.context } : {}),
      },
      MODEL,
    );
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trade advice failed";
    res.status(502).json({ error: message });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent3 listening on http://0.0.0.0:${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Model fast: ${MODEL_FAST}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
