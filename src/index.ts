import "dotenv/config";
import express from "express";
import { listTools, runChat } from "./agent";
import { get_launches, get_xrp_price } from "./tools/xrpl";

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

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent3 listening on http://0.0.0.0:${PORT}`);
  console.log(`Model: ${MODEL}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
