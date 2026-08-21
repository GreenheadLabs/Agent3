import { asString, type AgentTool } from "./types";
import { getRiskSettings, type RiskSettings } from "./risk";
import { getWallet, xrplConnected } from "./xrpl";

async function ollamaReachable(): Promise<boolean> {
  const base = (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function getStatus(): Promise<unknown> {
  let walletAddress: string | null = null;
  let walletError: string | undefined;
  try {
    walletAddress = getWallet().classicAddress;
  } catch (error) {
    walletError = error instanceof Error ? error.message : "wallet unavailable";
  }

  return {
    service: "agent3",
    model: process.env.MODEL ?? "deepseek-r1:8b",
    ollama_url: process.env.OLLAMA_URL ?? "http://localhost:11434",
    ollama_reachable: await ollamaReachable(),
    xrpl_endpoint: "wss://xrplcluster.com",
    xrpl_connected: await xrplConnected(),
    wallet_configured: Boolean(process.env.XRPL_WALLET_SEED?.trim()),
    wallet_address: walletAddress,
    wallet_error: walletError,
    uptime_seconds: process.uptime(),
    memory_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    platform: process.platform,
    node: process.version,
  };
}

export const systemTools: AgentTool[] = [
  {
    name: "get_status",
    description:
      "Get Agent3 runtime status: model, Ollama reachability, XRPL connection, and wallet address (never the seed).",
    parameters: {
      type: "object",
      properties: {
        detail: {
          type: "string",
          description: "Optional unused placeholder so the model can call the tool with an empty object.",
        },
      },
    },
    execute: async () => getStatus(),
  },
  {
    name: "get_risk_settings",
    description:
      "Get buy-side risk limits used by buy_token: max XRP per buy, max slippage in basis points, and minimum XRP reserve to keep in the wallet.",
    parameters: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Optional setting name to return a single value (max_buy_xrp, max_slippage_bps, min_xrp_reserve).",
        },
      },
    },
    execute: async (args) => {
      const settings = getRiskSettings();
      const key = asString(args.key);
      if (!key) {
        return settings;
      }
      if (key in settings) {
        return { [key]: settings[key as keyof RiskSettings] };
      }
      throw new Error(`Unknown risk setting: ${key}`);
    },
  },
];
