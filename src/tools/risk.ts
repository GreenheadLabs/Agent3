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
