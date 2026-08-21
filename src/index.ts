import "dotenv/config";
import express from "express";
import { listTools, runChat } from "./agent";

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

app.post("/v1/chat", async (req, res) => {
  const prompt = req.body?.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  try {
    const result = await runChat(prompt.trim(), req.body?.context);
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
