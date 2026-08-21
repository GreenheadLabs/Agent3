import { systemTools } from "./tools/system";
import { xrplTools } from "./tools/xrpl";
import { marketTools } from "./tools/market";
import { sentimentTools } from "./tools/sentiment";
import { portfolioTools } from "./tools/portfolio";
import { riskTools } from "./tools/risk";
import type { AgentTool } from "./tools/types";

const MAX_TOOL_ROUNDS = 8;

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_name?: string;
  tool_calls?: OllamaToolCall[];
};

export type OllamaToolCall = {
  type?: string;
  function: {
    name: string;
    arguments?: Record<string, unknown> | string;
    index?: number;
  };
};

export type ChatResult = {
  response: string;
  model: string;
  tools_used: string[];
};

type OllamaChatResponse = {
  model?: string;
  message?: ChatMessage;
  error?: string;
};

const tools: AgentTool[] = [
  ...xrplTools,
  ...systemTools,
  ...marketTools,
  ...sentimentTools,
  ...portfolioTools,
  ...riskTools,
];
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

export function listTools(): Array<{ name: string; description: string }> {
  return tools.map(({ name, description }) => ({ name, description }));
}

function ollamaTools() {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function formatContext(context: unknown): string {
  if (context == null || context === "") {
    return "";
  }
  if (typeof context === "string") {
    return context;
  }
  try {
    return JSON.stringify(context, null, 2);
  } catch {
    return String(context);
  }
}

function parseArguments(raw: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  return raw;
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = toolsByName.get(name);
  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  try {
    const result = await tool.execute(args);
    return JSON.stringify(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed";
    return JSON.stringify({ error: message, tool: name });
  }
}

async function ollamaChat(messages: ChatMessage[]): Promise<OllamaChatResponse> {
  const base = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const model = process.env.MODEL ?? "qwen2.5:7b";
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools: ollamaTools(),
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  const body = (await response.json()) as OllamaChatResponse;
  if (!response.ok) {
    throw new Error(body.error ?? `Ollama request failed (${response.status})`);
  }
  if (body.error) {
    throw new Error(body.error);
  }
  return body;
}

export async function runChat(prompt: string, context?: unknown): Promise<ChatResult> {
  const model = process.env.MODEL ?? "qwen2.5:7b";
  const contextBlock = formatContext(context);
  const userContent = contextBlock
    ? `${prompt}\n\nContext:\n${contextBlock}`
    : prompt;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are Agent3, a local XRPL assistant.",
        "Use tools for live prices, launches, balances, status, and buys.",
        "Never invent balances, prices, or transaction hashes.",
        "Never ask for or reveal XRPL_WALLET_SEED.",
        "Respect risk settings before buying tokens.",
        "When a tool returns an error, explain it clearly.",
      ].join(" "),
    },
    { role: "user", content: userContent },
  ];

  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const reply = await ollamaChat(messages);
    const message = reply.message ?? { role: "assistant", content: "" };
    messages.push(message);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        response: message.content?.trim() || "",
        model: reply.model ?? model,
        tools_used: toolsUsed,
      };
    }

    for (const call of calls) {
      const name = call.function?.name;
      if (!name) {
        messages.push({
          role: "tool",
          tool_name: "unknown",
          content: JSON.stringify({ error: "Tool call missing function name" }),
        });
        continue;
      }
      toolsUsed.push(name);
      const args = parseArguments(call.function.arguments);
      const result = await executeTool(name, args);
      messages.push({
        role: "tool",
        tool_name: name,
        content: result,
      });
    }
  }

  return {
    response: "Stopped after the maximum number of tool rounds without a final answer.",
    model,
    tools_used: toolsUsed,
  };
}
