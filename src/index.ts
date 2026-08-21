import "dotenv/config";
import express from "express";
import { dropsToXrp } from "xrpl";
import { listTools, runChat } from "./agent";
import { score_token } from "./tools/risk";
import {
  buy_token,
  get_launches,
  get_xrp_price,
  getXrplClient,
  sell_token,
  toXrplCurrency,
  type AmmLaunch,
} from "./tools/xrpl";

const PORT = Number(process.env.PORT) || 3100;
const MODEL = process.env.MODEL ?? "qwen2.5:7b";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    model: MODEL,
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
    const result = await runChat(prompt.trim(), context);
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
    });
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

type OpenPosition = {
  issuer: string;
  currency: string;
  tokens: number;
  xrpSpent: number;
  openedAt: number;
  buyHash?: string;
};

const openPositions = new Map<string, OpenPosition>();
const SCAN_MS = 60_000;
const POSITION_CHECK_MS = 5 * 60_000;
const MAX_LAUNCH_AGE_SECONDS = 5 * 60;
const TAKE_PROFIT = 0.3;
const STOP_LOSS = -0.2;

function autoTradeEnabled(): boolean {
  return process.env.AUTO_TRADE === "true";
}

function maxBuyXrp(): number {
  const parsed = Number(process.env.MAX_BUY_XRP);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function positionKey(issuer: string, currency: string): string {
  return `${issuer}:${currency}`;
}

function logDecision(event: string, details: Record<string, unknown>): void {
  console.log(`[auto-trade] ${event}`, details);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function launchAgeSeconds(createdAt: string | undefined): number | undefined {
  if (!createdAt) {
    return undefined;
  }
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) {
    return undefined;
  }
  return (Date.now() - created) / 1000;
}

async function ammReserves(
  currency: string,
  issuer: string,
): Promise<{ poolXrp: number; poolTokens: number } | null> {
  try {
    const xrpl = await getXrplClient();
    const encoded = toXrplCurrency(currency);
    const amm = await xrpl.request({
      command: "amm_info",
      asset: { currency: "XRP" },
      asset2: { currency: encoded, issuer },
    });
    const amounts = [amm.result.amm.amount, amm.result.amm.amount2];
    let poolXrp: number | undefined;
    let poolTokens: number | undefined;
    for (const amount of amounts) {
      if (typeof amount === "string") {
        poolXrp = Number(dropsToXrp(amount));
      } else if (amount && typeof amount === "object" && "value" in amount) {
        poolTokens = Number((amount as { value: string }).value);
      }
    }
    if (poolXrp === undefined || poolTokens === undefined || poolXrp <= 0 || poolTokens <= 0) {
      return null;
    }
    return { poolXrp, poolTokens };
  } catch {
    return null;
  }
}

async function tokenPriceXrp(currency: string, issuer: string): Promise<number | null> {
  const reserves = await ammReserves(currency, issuer);
  if (!reserves || reserves.poolTokens <= 0) {
    return null;
  }
  return reserves.poolXrp / reserves.poolTokens;
}

async function decideLaunch(input: DecisionInput, score: unknown): Promise<DecisionResult> {
  const result = await runChat(
    [
      buildDecisionPrompt(input),
      "You MUST call score_token with this issuer, currency, poolXrp, and poolTokens before deciding.",
      "Do not call buy_token or sell_token.",
    ].join("\n"),
    {
      system:
        "Autonomous scan. Call score_token, then return JSON only: {decision, confidence, reason}.",
      launch: input,
      score_token: score,
    },
  );
  try {
    return normalizeDecision(
      extractJsonObject(result.response),
      result.response.trim() || "Unparseable model decision; skipping.",
    );
  } catch {
    return {
      decision: "skip",
      confidence: 0,
      reason: result.response.trim() || "Unparseable model decision; skipping.",
    };
  }
}

async function scanNewLaunches(): Promise<void> {
  const feed = await get_launches({ limit: 25 });
  const fresh = feed.launches.filter((launch: AmmLaunch) => {
    const age = launchAgeSeconds(launch.created_at);
    return Boolean(launch.issuer && launch.currency && age !== undefined && age >= 0 && age < MAX_LAUNCH_AGE_SECONDS);
  });

  logDecision("scan", { found: feed.launches.length, fresh: fresh.length });

  for (const launch of fresh) {
    const issuer = launch.issuer as string;
    const currency = launch.currency as string;
    const key = positionKey(issuer, currency);
    const age = launchAgeSeconds(launch.created_at) ?? 0;
    if (openPositions.has(key)) {
      logDecision("skip", { currency, issuer, reason: "already holding an open position" });
      continue;
    }

    const reserves = await ammReserves(currency, issuer);
    const poolXrp = reserves?.poolXrp ?? (Number(launch.liquidity_usd) || 0);
    const poolTokens = reserves?.poolTokens ?? 0;
    const input: DecisionInput = {
      issuer,
      currency,
      poolXrp,
      poolTokens,
      launchAgeSeconds: age,
      source: launch.dex ?? "auto-trade",
    };

    let score: unknown;
    try {
      score = await score_token({
        issuer,
        currency,
        poolXrp,
        poolTokens,
      });
    } catch (error) {
      logDecision("score_error", {
        currency,
        issuer,
        error: error instanceof Error ? error.message : "score_token failed",
      });
      continue;
    }

    let decision: DecisionResult;
    try {
      decision = await decideLaunch(input, score);
    } catch (error) {
      decision = {
        decision: "skip",
        confidence: 0,
        reason: error instanceof Error ? error.message : "Ollama decision failed",
      };
    }

    logDecision("decision", {
      currency,
      issuer,
      age_seconds: age,
      score,
      decision: decision.decision,
      confidence: decision.confidence,
      reason: decision.reason,
    });

    if (decision.decision !== "buy" || decision.confidence < 0.75) {
      continue;
    }

    const xrpAmount = maxBuyXrp();
    try {
      const bought = asRecord(
        await buy_token({
          issuer,
          currency,
          xrp_amount: xrpAmount,
        }),
      );
      const status = typeof bought.status === "string" ? bought.status : "unknown";
      const hash = typeof bought.hash === "string" ? bought.hash : undefined;
      const tokens = asFiniteNumber(bought.expected_tokens) ?? 0;
      logDecision("buy", {
        currency,
        issuer,
        xrp_amount: xrpAmount,
        status,
        txHash: hash,
        reason: decision.reason,
      });
      if (status === "tesSUCCESS" && tokens > 0) {
        openPositions.set(key, {
          issuer,
          currency,
          tokens,
          xrpSpent: xrpAmount,
          openedAt: Date.now(),
          buyHash: hash,
        });
      }
    } catch (error) {
      logDecision("buy_error", {
        currency,
        issuer,
        error: error instanceof Error ? error.message : "buy_token failed",
      });
    }
  }
}

async function checkOpenPositions(): Promise<void> {
  if (openPositions.size === 0) {
    logDecision("positions", { open: 0 });
    return;
  }

  for (const [key, position] of [...openPositions.entries()]) {
    try {
      const price = await tokenPriceXrp(position.currency, position.issuer);
      if (price === null || position.tokens <= 0 || position.xrpSpent <= 0) {
        logDecision("position_skip", {
          currency: position.currency,
          issuer: position.issuer,
          reason: "unable to mark position to market",
        });
        continue;
      }
      const markValue = position.tokens * price;
      const upnl = (markValue - position.xrpSpent) / position.xrpSpent;
      const action =
        upnl > TAKE_PROFIT ? "take_profit" : upnl < STOP_LOSS ? "stop_loss" : "hold";
      logDecision("position", {
        currency: position.currency,
        issuer: position.issuer,
        upnl,
        mark_xrp: markValue,
        action,
      });
      if (action === "hold") {
        continue;
      }

      const sold = asRecord(
        await sell_token({
          issuer: position.issuer,
          currency: position.currency,
          amountTokens: position.tokens,
        }),
      );
      logDecision("sell", {
        currency: position.currency,
        issuer: position.issuer,
        upnl,
        reason: action,
        status: sold.status,
        txHash: sold.hash,
      });
      if (sold.status === "tesSUCCESS") {
        openPositions.delete(key);
      }
    } catch (error) {
      logDecision("sell_error", {
        currency: position.currency,
        issuer: position.issuer,
        error: error instanceof Error ? error.message : "sell_token failed",
      });
    }
  }
}

function startAutoTradeLoop(): void {
  if (!autoTradeEnabled()) {
    console.log("[auto-trade] disabled (set AUTO_TRADE=true to enable)");
    return;
  }

  console.log("[auto-trade] enabled — scanning launches every 60s, positions every 5m");
  let scanning = false;
  let lastPositionCheck = Date.now();

  const tick = async () => {
    if (scanning) {
      return;
    }
    scanning = true;
    try {
      await scanNewLaunches();
      if (Date.now() - lastPositionCheck >= POSITION_CHECK_MS) {
        lastPositionCheck = Date.now();
        await checkOpenPositions();
      }
    } catch (error) {
      logDecision("loop_error", {
        error: error instanceof Error ? error.message : "auto-trade tick failed",
      });
    } finally {
      scanning = false;
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, SCAN_MS);
}

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent3 listening on http://0.0.0.0:${PORT}`);
  console.log(`Model: ${MODEL}`);
  startAutoTradeLoop();
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
