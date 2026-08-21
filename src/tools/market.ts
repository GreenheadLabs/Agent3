import { asInteger, type AgentTool } from "./types";

const XRPL_TO = "https://api.xrpl.to/v1";
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "Agent3/1.0 (Greenhead Labs)",
};

function decodeCurrency(code: string | undefined): string | undefined {
  if (!code) {
    return code;
  }
  if (!/^[A-Fa-f0-9]{40}$/.test(code)) {
    return code;
  }
  const decoded = Buffer.from(code, "hex").toString("utf8").replace(/\0/g, "").trim();
  return decoded || code;
}

type XrplToToken = {
  name?: string;
  user?: string;
  issuer?: string;
  currency?: string;
  usd?: string | number;
  exch?: number;
  vol24hxrp?: number;
  marketcap?: number;
  p24h?: number;
  holders?: number;
  tvl?: number;
  AMM?: unknown;
  trendingScore?: number;
  verified?: number;
};

type XrplToAmmPool = {
  ammAccount?: string;
  status?: string;
  tradingFee?: number;
  asset1?: { currency?: string; issuer?: string };
  asset2?: { currency?: string; issuer?: string };
  currentLiquidity?: {
    asset1Amount?: number;
    asset2Amount?: number;
    lpTokenBalance?: number;
  };
  apy24h?: { apy?: number; volume?: number; liquidity?: number };
  health?: { depth?: string; activity?: string };
  lpHolderCount?: number;
  tags?: string[];
};

export async function get_trending_tokens(
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const limit = Math.min(asInteger(args.limit, 15), 50);
  const response = await fetch(
    `${XRPL_TO}/tokens?sort=trending&order=desc&limit=${limit}`,
    { headers: HEADERS, signal: AbortSignal.timeout(15_000) },
  );
  if (!response.ok) {
    throw new Error(`xrpl.to trending request failed (${response.status})`);
  }
  const body = (await response.json()) as { tokens?: XrplToToken[] };
  const tokens = (body.tokens ?? []).map((token) => ({
    name: token.name ?? token.user,
    currency: decodeCurrency(token.currency),
    issuer: token.issuer,
    price_usd: token.usd,
    price_xrp: token.exch,
    volume_xrp_24h: token.vol24hxrp,
    marketcap: token.marketcap,
    change_24h_pct: token.p24h,
    holders: token.holders,
    tvl: token.tvl,
    amm: token.AMM ?? null,
    trending_score: token.trendingScore,
    verified: Boolean(token.verified),
  }));
  return { source: "xrpl.to", count: tokens.length, tokens };
}

export async function get_amm_pools(
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const limit = Math.min(asInteger(args.limit, 15), 50);
  const response = await fetch(`${XRPL_TO}/amm?limit=${limit}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`xrpl.to AMM request failed (${response.status})`);
  }
  const body = (await response.json()) as { pools?: XrplToAmmPool[]; summary?: unknown };
  const pools = (body.pools ?? [])
    .filter((pool) => !pool.status || pool.status === "active")
    .slice(0, limit)
    .map((pool) => ({
      amm_account: pool.ammAccount,
      status: pool.status ?? "active",
      trading_fee: pool.tradingFee,
      asset1: {
        currency: decodeCurrency(pool.asset1?.currency),
        issuer: pool.asset1?.issuer,
      },
      asset2: {
        currency: decodeCurrency(pool.asset2?.currency),
        issuer: pool.asset2?.issuer,
      },
      liquidity: pool.currentLiquidity,
      apy_24h: pool.apy24h?.apy,
      volume_24h: pool.apy24h?.volume,
      health: pool.health,
      lp_holders: pool.lpHolderCount,
      tags: pool.tags,
    }));
  return { source: "xrpl.to", count: pools.length, summary: body.summary, pools };
}

export const marketTools: AgentTool[] = [
  {
    name: "get_trending_tokens",
    description: "Fetch top trending XRPL tokens from xrpl.to (price, volume, holders, TVL, AMM).",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum tokens to return (default 15, max 50)",
        },
      },
    },
    execute: get_trending_tokens,
  },
  {
    name: "get_amm_pools",
    description: "Fetch active XRPL AMM pools from xrpl.to (assets, liquidity, APY, health).",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum pools to return (default 15, max 50)",
        },
      },
    },
    execute: get_amm_pools,
  },
];
