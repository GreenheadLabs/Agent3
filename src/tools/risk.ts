import { asNumber, asString, type AgentTool } from "./types";

export type RiskSettings = {
  max_buy_xrp: number;
  max_slippage_bps: number;
  min_xrp_reserve: number;
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getRiskSettings(): RiskSettings {
  return {
    max_buy_xrp: envNumber("MAX_BUY_XRP", 10),
    max_slippage_bps: envNumber("MAX_SLIPPAGE_BPS", 150),
    min_xrp_reserve: envNumber("MIN_XRP_RESERVE", 10),
  };
}

function ratingFor(score: number): "low" | "medium" | "high" | "extreme" {
  if (score >= 80) {
    return "extreme";
  }
  if (score >= 60) {
    return "high";
  }
  if (score >= 40) {
    return "medium";
  }
  return "low";
}

export async function score_token(
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const issuer = asString(args.issuer);
  const currency = asString(args.currency);
  const poolXrp = asNumber(args.poolXrp);
  const poolTokens = asNumber(args.poolTokens);

  if (!issuer) {
    throw new Error("issuer is required");
  }
  if (!currency) {
    throw new Error("currency is required");
  }
  if (poolXrp === undefined) {
    throw new Error("poolXrp is required");
  }
  if (poolTokens === undefined) {
    throw new Error("poolTokens is required");
  }

  const reasons: string[] = [];
  let score = 40;

  if (poolXrp <= 0 || poolTokens <= 0) {
    return {
      issuer,
      currency,
      poolXrp,
      poolTokens,
      score: 100,
      rating: "extreme" as const,
      reasons: ["Pool XRP or token reserve is zero or negative — treat as untradable."],
    };
  }

  if (poolXrp < 1) {
    score += 35;
    reasons.push(`Pool has only ${poolXrp} XRP — extreme illiquidity / rug risk.`);
  } else if (poolXrp < 10) {
    score += 25;
    reasons.push(`Pool has ${poolXrp} XRP — very thin liquidity.`);
  } else if (poolXrp < 50) {
    score += 15;
    reasons.push(`Pool has ${poolXrp} XRP — below a comfortable liquidity floor.`);
  } else if (poolXrp > 10_000) {
    score -= 15;
    reasons.push(`Pool has ${poolXrp} XRP — relatively deep liquidity.`);
  } else {
    reasons.push(`Pool has ${poolXrp} XRP — moderate liquidity.`);
  }

  const tokensPerXrp = poolTokens / poolXrp;
  if (tokensPerXrp > 1e12) {
    score += 20;
    reasons.push("Token/XRP reserve ratio is extreme (hyper-inflated supply).");
  } else if (tokensPerXrp > 1e9) {
    score += 12;
    reasons.push("Very large token supply relative to XRP in the pool.");
  }

  if (issuer.length < 25 || !issuer.startsWith("r")) {
    score += 10;
    reasons.push("Issuer address looks malformed.");
  }

  score = Math.min(100, Math.max(0, Math.round(score)));
  if (reasons.length === 0) {
    reasons.push("No extra red flags from pool size and supply ratio.");
  }

  return {
    issuer,
    currency,
    poolXrp,
    poolTokens,
    tokens_per_xrp: tokensPerXrp,
    score,
    rating: ratingFor(score),
    reasons,
  };
}

export const riskTools: AgentTool[] = [
  {
    name: "score_token",
    description:
      "Score an XRPL token 0-100 for risk from issuer, currency, and AMM pool reserves. Higher is riskier.",
    parameters: {
      type: "object",
      properties: {
        issuer: {
          type: "string",
          description: "Token issuer classic address",
        },
        currency: {
          type: "string",
          description: "Token currency code or 160-bit hex",
        },
        poolXrp: {
          type: "number",
          description: "XRP amount currently in the AMM pool",
        },
        poolTokens: {
          type: "number",
          description: "Token amount currently in the AMM pool",
        },
      },
      required: ["issuer", "currency", "poolXrp", "poolTokens"],
    },
    execute: score_token,
  },
];

