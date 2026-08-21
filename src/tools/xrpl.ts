import {
  Client,
  Wallet,
  dropsToXrp,
  xrpToDrops,
  PaymentFlags,
  OfferCreateFlags,
  rippleTimeToISOTime,
  type Amount,
  type IssuedCurrencyAmount,
  type OfferCreate,
  type Payment,
  type TrustSet,
} from "xrpl";
import { getRiskSettings } from "./risk";
import { asInteger, asNumber, asString, type AgentTool } from "./types";

const XRPL_WSS = "wss://xrplcluster.com";
const BITSTAMP_USD_ISSUER = "rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B";
const DEFAULT_TRUST_LIMIT = "1000000000";

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

function walletSeed(): string | undefined {
  const seed = process.env.XRPL_WALLET_SEED?.trim();
  return seed ? seed : undefined;
}

export function getWallet(): Wallet {
  const seed = walletSeed();
  if (!seed) {
    throw new Error("XRPL_WALLET_SEED is not set");
  }
  return Wallet.fromSeed(seed);
}

export async function getXrplClient(): Promise<Client> {
  if (client?.isConnected()) {
    return client;
  }
  if (connecting) {
    return connecting;
  }

  connecting = (async () => {
    const next = new Client(XRPL_WSS);
    next.on("disconnected", () => {
      if (client === next) {
        client = null;
      }
    });
    await next.connect();
    client = next;
    return next;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function xrplConnected(): Promise<boolean> {
  try {
    const c = await getXrplClient();
    return c.isConnected();
  } catch {
    return false;
  }
}

export function toXrplCurrency(code: string): string {
  const trimmed = code.trim();
  if (/^[A-Fa-f0-9]{40}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  if (trimmed.length <= 3) {
    return trimmed.toUpperCase();
  }
  return Buffer.from(trimmed, "utf8").toString("hex").toUpperCase().padEnd(40, "0").slice(0, 40);
}

export function decodeCurrency(code: string): string {
  if (!/^[A-Fa-f0-9]{40}$/.test(code)) {
    return code;
  }
  const decoded = Buffer.from(code, "hex").toString("utf8").replace(/\0/g, "").trim();
  return decoded || code;
}

function issuedAmount(currency: string, issuer: string, value: string): IssuedCurrencyAmount {
  return {
    currency: toXrplCurrency(currency),
    issuer,
    value,
  };
}

function amountParts(amount: Amount): { currency: string; issuer?: string; value: number } {
  if (typeof amount === "string") {
    return { currency: "XRP", value: Number(dropsToXrp(amount)) };
  }
  return {
    currency: decodeCurrency(amount.currency),
    issuer: amount.issuer,
    value: Number(amount.value),
  };
}

function isXrp(currency: string | undefined): boolean {
  return !currency || currency.toUpperCase() === "XRP";
}

async function getPrice(args: Record<string, unknown>): Promise<unknown> {
  const currency = asString(args.currency) ?? "XRP";
  const issuer = asString(args.issuer);
  const xrpl = await getXrplClient();

  if (isXrp(currency)) {
    const book = await xrpl.request({
      command: "book_offers",
      taker_gets: { currency: "USD", issuer: BITSTAMP_USD_ISSUER },
      taker_pays: { currency: "XRP" },
      limit: 5,
    });
    const offer = book.result.offers[0];
    if (!offer) {
      return { currency: "XRP", error: "No USD book offers found" };
    }
    const gets = amountParts(offer.TakerGets as Amount);
    const pays = amountParts(offer.TakerPays as Amount);
    const usdPerXrp = gets.value / pays.value;
    return {
      currency: "XRP",
      price_usd: usdPerXrp,
      source: "xrpl_dex",
      quote: "USD",
      quote_issuer: BITSTAMP_USD_ISSUER,
    };
  }

  if (!issuer) {
    throw new Error("issuer is required for issued currencies");
  }

  const token = issuedAmount(currency, issuer, "0");

  try {
    const amm = await xrpl.request({
      command: "amm_info",
      asset: { currency: "XRP" },
      asset2: { currency: token.currency, issuer },
    });
    const pool = amm.result.amm;
    const a = amountParts(pool.amount as Amount);
    const b = amountParts(pool.amount2 as Amount);
    const xrpSide = a.currency === "XRP" ? a : b;
    const tokenSide = a.currency === "XRP" ? b : a;
    const priceXrp = tokenSide.value === 0 ? 0 : xrpSide.value / tokenSide.value;
    return {
      currency: decodeCurrency(token.currency),
      issuer,
      price_xrp: priceXrp,
      amm_account: pool.account,
      trading_fee_bps: Number(pool.trading_fee) / 10,
      reserves: {
        xrp: xrpSide.value,
        token: tokenSide.value,
      },
      source: "amm",
    };
  } catch {
    const book = await xrpl.request({
      command: "book_offers",
      taker_gets: { currency: "XRP" },
      taker_pays: { currency: token.currency, issuer },
      limit: 5,
    });
    const offer = book.result.offers[0];
    if (!offer) {
      return {
        currency: decodeCurrency(token.currency),
        issuer,
        error: "No AMM pool or DEX offers found",
      };
    }
    const gets = amountParts(offer.TakerGets as Amount);
    const pays = amountParts(offer.TakerPays as Amount);
    const priceXrp = pays.value === 0 ? 0 : gets.value / pays.value;
    return {
      currency: decodeCurrency(token.currency),
      issuer,
      price_xrp: priceXrp,
      source: "xrpl_dex",
    };
  }
}

type GeckoPool = {
  id: string;
  attributes?: {
    name?: string;
    address?: string;
    pool_created_at?: string;
    base_token_price_usd?: string;
    base_token_price_native_currency?: string;
    fdv_usd?: string;
    market_cap_usd?: string;
    volume_usd?: { h24?: string };
    reserve_in_usd?: string;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
};

function parseGeckoTokenId(id: string | undefined): { currency?: string; issuer?: string } {
  if (!id) {
    return {};
  }
  const raw = id.replace(/^xrpl_/, "");
  const [currency, issuer] = raw.split(".");
  if (!currency || currency === "XRP") {
    return { currency: "XRP" };
  }
  return { currency: decodeCurrency(currency), issuer };
}

export type AmmLaunch = {
  name?: string;
  currency?: string;
  issuer?: string;
  created_at?: string;
  price_usd?: string;
  price_xrp?: string;
  fdv_usd?: string;
  volume_usd_24h?: string;
  liquidity_usd?: string;
  dex?: string;
};

const LAUNCH_FRESH_MS = 5 * 60 * 1000;
const AMMCREATE_LEDGERS = 90;
const AMMCREATE_BATCH = 8;

function truncateForLog(value: unknown, max = 2000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}… (${text.length} chars)`;
}

function launchCreatedMs(launch: AmmLaunch): number | undefined {
  if (!launch.created_at) {
    return undefined;
  }
  const parsed = Date.parse(launch.created_at);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isFreshLaunch(launch: AmmLaunch, now = Date.now()): boolean {
  const created = launchCreatedMs(launch);
  return created !== undefined && now - created < LAUNCH_FRESH_MS;
}

function launchesAreStale(launches: AmmLaunch[]): boolean {
  return launches.length === 0 || launches.every((launch) => !isFreshLaunch(launch));
}

function sortLaunchesByCreatedAtDesc(launches: AmmLaunch[]): AmmLaunch[] {
  return [...launches].sort((left, right) => {
    const leftMs = launchCreatedMs(left) ?? 0;
    const rightMs = launchCreatedMs(right) ?? 0;
    return rightMs - leftMs;
  });
}

async function fetchExternalLaunches(limit: number): Promise<AmmLaunch[]> {
  const source = "XMagnetic";
  const url = `https://api.geckoterminal.com/api/v2/networks/xrpl/new_pools?page=1`;
  console.log("[get_launches] trying source:", source);
  console.log("[get_launches] XMagnetic URL:", url);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Agent3/1.0 (Greenhead Labs)",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const rawText = await response.text();
    console.log("[get_launches] XMagnetic HTTP status:", response.status, response.statusText);
    console.log("[get_launches] XMagnetic raw response:", truncateForLog(rawText));
    if (!response.ok) {
      throw new Error(`Launch feed request failed (${response.status})`);
    }
    const body = JSON.parse(rawText) as { data?: GeckoPool[] };
    const launches = (body.data ?? []).slice(0, limit).map((pool) => {
      const token = parseGeckoTokenId(pool.relationships?.base_token?.data?.id);
      return {
        name: pool.attributes?.name,
        currency: token.currency,
        issuer: token.issuer,
        created_at: pool.attributes?.pool_created_at,
        price_usd: pool.attributes?.base_token_price_usd,
        price_xrp: pool.attributes?.base_token_price_native_currency,
        fdv_usd: pool.attributes?.fdv_usd,
        volume_usd_24h: pool.attributes?.volume_usd?.h24,
        liquidity_usd: pool.attributes?.reserve_in_usd,
        dex: pool.relationships?.dex?.data?.id,
      };
    });
    console.log(
      "[get_launches] XMagnetic parsed count:",
      launches.length,
      "launches:",
      truncateForLog(launches),
    );
    return launches;
  } catch (error) {
    console.log("[get_launches] XMagnetic error:", error);
    throw error;
  }
}

function unwrapLedgerTx(entry: unknown): {
  type?: string;
  amount?: Amount;
  amount2?: Amount;
  result?: string;
} {
  if (!entry || typeof entry !== "object") {
    return {};
  }
  const record = entry as Record<string, unknown>;
  const tx = (
    record.tx_json && typeof record.tx_json === "object"
      ? record.tx_json
      : record
  ) as Record<string, unknown>;
  const meta = (record.meta ?? record.metaData) as Record<string, unknown> | undefined;
  return {
    type: typeof tx.TransactionType === "string" ? tx.TransactionType : undefined,
    amount: tx.Amount as Amount | undefined,
    amount2: tx.Amount2 as Amount | undefined,
    result: typeof meta?.TransactionResult === "string" ? meta.TransactionResult : undefined,
  };
}

function ammCreateToLaunch(tx: {
  amount?: Amount;
  amount2?: Amount;
  result?: string;
}, createdAt?: string): AmmLaunch | undefined {
  if (tx.result && tx.result !== "tesSUCCESS") {
    return undefined;
  }
  if (tx.amount === undefined || tx.amount2 === undefined) {
    return undefined;
  }
  const first = amountParts(tx.amount);
  const second = amountParts(tx.amount2);
  const token = first.currency === "XRP" ? second : first;
  const xrp = first.currency === "XRP" ? first : second;
  if (!token.issuer || token.currency === "XRP") {
    return undefined;
  }
  const priceXrp =
    xrp.currency === "XRP" && token.value > 0 ? String(xrp.value / token.value) : undefined;
  return {
    name: `${token.currency} / XRP`,
    currency: token.currency,
    issuer: token.issuer,
    created_at: createdAt,
    price_xrp: priceXrp,
    dex: "xrpl_ledger",
  };
}

async function fetchLedgerAmmCreates(limit: number): Promise<AmmLaunch[]> {
  const source = "XRPL direct";
  console.log("[get_launches] trying source:", source);
  try {
    const xrpl = await getXrplClient();
    console.log(
      "[get_launches] XRPL direct command:",
      JSON.stringify({ command: "ledger", ledger_index: "validated" }),
    );
    const current = await xrpl.request({ command: "ledger", ledger_index: "validated" });
    console.log("[get_launches] XRPL direct validated ledger response:", truncateForLog(current));
    const latest = Number(current.result.ledger_index ?? current.result.ledger.ledger_index);
    if (!Number.isFinite(latest) || latest <= 0) {
      throw new Error("Could not read validated ledger index");
    }

    const found: AmmLaunch[] = [];
    const oldest = Math.max(1, latest - AMMCREATE_LEDGERS + 1);
    const ledgerScanCommand = {
      command: "ledger",
      ledger_index: latest,
      transactions: true,
      expand: true,
    };
    console.log("[get_launches] XRPL direct command:", JSON.stringify(ledgerScanCommand));
    console.log(
      "[get_launches] XRPL direct scanning ledgers",
      latest,
      "to",
      oldest,
      "for AMMCreate (not account_tx)",
    );

    let loggedSampleLedger = false;
    for (let batchHigh = latest; batchHigh >= oldest && found.length < limit; batchHigh -= AMMCREATE_BATCH) {
      const batchLow = Math.max(oldest, batchHigh - AMMCREATE_BATCH + 1);
      const indexes: number[] = [];
      for (let index = batchHigh; index >= batchLow; index -= 1) {
        indexes.push(index);
      }

      const pages = await Promise.all(
        indexes.map(async (ledgerIndex) => {
          try {
            return await xrpl.request({
              command: "ledger",
              ledger_index: ledgerIndex,
              transactions: true,
              expand: true,
            });
          } catch (error) {
            console.log("[get_launches] XRPL direct ledger request error:", ledgerIndex, error);
            return null;
          }
        }),
      );

      for (const page of pages) {
        if (!page) {
          continue;
        }
        const closeTime = page.result.ledger.close_time;
        const createdAt =
          typeof closeTime === "number" ? rippleTimeToISOTime(closeTime) : undefined;
        const transactions = page.result.ledger.transactions ?? [];
        if (!loggedSampleLedger) {
          loggedSampleLedger = true;
          console.log(
            "[get_launches] XRPL direct raw ledger",
            page.result.ledger_index ?? page.result.ledger.ledger_index,
            "tx count:",
            transactions.length,
            "sample:",
            truncateForLog(transactions.slice(0, 2)),
          );
        }
        for (const raw of transactions) {
          if (typeof raw === "string") {
            continue;
          }
          const tx = unwrapLedgerTx(raw);
          if (tx.type !== "AMMCreate") {
            continue;
          }
          console.log("[get_launches] XRPL direct raw AMMCreate:", truncateForLog(raw));
          const launch = ammCreateToLaunch(tx, createdAt);
          if (launch) {
            found.push(launch);
          }
        }
      }
    }

    const launches = sortLaunchesByCreatedAtDesc(found).slice(0, limit);
    console.log(
      "[get_launches] XRPL direct AMMCreate matches:",
      launches.length,
      "raw launches:",
      truncateForLog(launches),
    );
    return launches;
  } catch (error) {
    console.log("[get_launches] XRPL direct error:", error);
    throw error;
  }
}

export async function get_xrp_price(
  _args: Record<string, unknown> = {},
): Promise<{ priceUsd: number }> {
  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd",
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "Agent3/1.0 (Greenhead Labs)",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(`CoinGecko price request failed (${response.status})`);
  }
  const body = (await response.json()) as { ripple?: { usd?: number } };
  const priceUsd = body.ripple?.usd;
  if (typeof priceUsd !== "number" || !Number.isFinite(priceUsd)) {
    throw new Error("CoinGecko did not return a numeric XRP/USD price");
  }
  return { priceUsd };
}

export async function get_launches(
  args: Record<string, unknown> = {},
): Promise<{ count: number; launches: AmmLaunch[] }> {
  const limit = Math.min(asInteger(args.limit, 10), 25);
  let launches: AmmLaunch[] = [];
  let externalError: string | undefined;

  try {
    launches = await fetchExternalLaunches(limit);
  } catch (error) {
    console.log("[get_launches] XMagnetic error caught:", error);
    externalError = error instanceof Error ? error.message : "external launch feed failed";
  }

  const freshCount = launches.filter((launch) => isFreshLaunch(launch)).length;
  const stale = Boolean(externalError) || launchesAreStale(launches);
  console.log(
    "[get_launches] XMagnetic parsed count:",
    launches.length,
    "fresh (<5m):",
    freshCount,
    "stale:",
    stale,
    "error:",
    externalError ?? null,
  );

  if (stale) {
    console.log(
      "[get_launches] falling back to XRPL direct because:",
      externalError ?? "external feed stale / 0 fresh AMM launches",
    );
    try {
      launches = await fetchLedgerAmmCreates(limit);
    } catch (error) {
      console.log("[get_launches] XRPL direct error caught:", error);
      if (launches.length === 0) {
        const fallbackError = error instanceof Error ? error.message : "XRPL AMMCreate scan failed";
        throw new Error(
          `get_launches failed: ${externalError ?? "external feed stale"}; fallback: ${fallbackError}`,
        );
      }
    }
  }

  launches = sortLaunchesByCreatedAtDesc(launches).slice(0, limit);
  console.log("[get_launches] returning count:", launches.length);
  return { count: launches.length, launches };
}

async function ensureTrustline(
  xrpl: Client,
  wallet: Wallet,
  currency: string,
  issuer: string,
): Promise<{ created: boolean; hash?: string }> {
  const lines = await xrpl.request({
    command: "account_lines",
    account: wallet.classicAddress,
    peer: issuer,
  });
  const encoded = toXrplCurrency(currency);
  const existing = lines.result.lines.find((line) => line.currency === encoded);
  if (existing) {
    return { created: false };
  }

  const tx: TrustSet = {
    TransactionType: "TrustSet",
    Account: wallet.classicAddress,
    LimitAmount: {
      currency: encoded,
      issuer,
      value: DEFAULT_TRUST_LIMIT,
    },
  };
  const submitted = await xrpl.submitAndWait(tx, { wallet, autofill: true });
  const hash = submitted.result.hash;
  const code = submitted.result.meta && typeof submitted.result.meta === "object"
    ? (submitted.result.meta as { TransactionResult?: string }).TransactionResult
    : undefined;
  if (code && code !== "tesSUCCESS") {
    throw new Error(`TrustSet failed: ${code}`);
  }
  return { created: true, hash };
}

async function quoteTokenOut(
  xrpl: Client,
  currency: string,
  issuer: string,
  xrpIn: number,
): Promise<{ expectedTokens: number; source: string }> {
  try {
    const amm = await xrpl.request({
      command: "amm_info",
      asset: { currency: "XRP" },
      asset2: { currency, issuer },
    });
    const a = amountParts(amm.result.amm.amount as Amount);
    const b = amountParts(amm.result.amm.amount2 as Amount);
    const xrpReserve = a.currency === "XRP" ? a.value : b.value;
    const tokenReserve = a.currency === "XRP" ? b.value : a.value;
    const fee = Number(amm.result.amm.trading_fee) / 100_000;
    const effectiveIn = xrpIn * (1 - fee);
    const expectedTokens = tokenReserve - (tokenReserve * xrpReserve) / (xrpReserve + effectiveIn);
    if (expectedTokens > 0) {
      return { expectedTokens, source: "amm" };
    }
  } catch {
    // Fall through to DEX book.
  }

  const book = await xrpl.request({
    command: "book_offers",
    taker_gets: { currency, issuer },
    taker_pays: { currency: "XRP" },
    limit: 5,
  });
  const offer = book.result.offers[0];
  if (!offer) {
    throw new Error("No AMM pool or DEX offers to quote this buy");
  }
  const gets = amountParts(offer.TakerGets as Amount);
  const pays = amountParts(offer.TakerPays as Amount);
  if (pays.value <= 0) {
    throw new Error("DEX offer has zero XRP cost");
  }
  return { expectedTokens: xrpIn * (gets.value / pays.value), source: "xrpl_dex" };
}

async function buyToken(args: Record<string, unknown>): Promise<unknown> {
  const currency = asString(args.currency);
  const issuer = asString(args.issuer);
  const xrpAmount = asNumber(args.xrp_amount);
  if (!currency || isXrp(currency)) {
    throw new Error("buy_token requires an issued currency");
  }
  if (!issuer) {
    throw new Error("issuer is required");
  }
  if (xrpAmount === undefined || xrpAmount <= 0) {
    throw new Error("xrp_amount must be a positive number");
  }

  const risk = getRiskSettings();
  if (xrpAmount > risk.max_buy_xrp) {
    throw new Error(`xrp_amount ${xrpAmount} exceeds max_buy_xrp ${risk.max_buy_xrp}`);
  }

  const wallet = getWallet();
  const xrpl = await getXrplClient();
  const info = await xrpl.request({
    command: "account_info",
    account: wallet.classicAddress,
    ledger_index: "validated",
  });
  const xrpBalance = Number(dropsToXrp(info.result.account_data.Balance));
  if (xrpBalance - xrpAmount < risk.min_xrp_reserve) {
    throw new Error(
      `Buy would leave ${xrpBalance - xrpAmount} XRP, below min_xrp_reserve ${risk.min_xrp_reserve}`,
    );
  }

  const trust = await ensureTrustline(xrpl, wallet, currency, issuer);
  const encoded = toXrplCurrency(currency);
  const quote = await quoteTokenOut(xrpl, encoded, issuer, xrpAmount);
  const expectedTokens = quote.expectedTokens;
  const deliverMinValue = expectedTokens * (1 - risk.max_slippage_bps / 10_000);
  if (deliverMinValue <= 0) {
    throw new Error("Computed DeliverMin is not positive");
  }

  const sendMax = xrpToDrops(xrpAmount);
  const destinationAmount: IssuedCurrencyAmount = {
    currency: encoded,
    issuer,
    value: expectedTokens.toPrecision(12),
  };

  let computedPaths: Payment["Paths"];
  try {
    const paths = await xrpl.request({
      command: "ripple_path_find",
      source_account: wallet.classicAddress,
      destination_account: wallet.classicAddress,
      destination_amount: destinationAmount,
      send_max: sendMax,
    });
    computedPaths = paths.result.alternatives[0]?.paths_computed;
  } catch {
    computedPaths = undefined;
  }

  const payment: Payment = {
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Destination: wallet.classicAddress,
    Amount: destinationAmount,
    SendMax: sendMax,
    DeliverMin: {
      currency: encoded,
      issuer,
      value: deliverMinValue.toPrecision(8),
    },
    Flags: PaymentFlags.tfPartialPayment,
  };
  if (computedPaths?.length) {
    payment.Paths = computedPaths;
  }

  const submitted = await xrpl.submitAndWait(payment, { wallet, autofill: true });
  const resultCode =
    submitted.result.meta && typeof submitted.result.meta === "object"
      ? (submitted.result.meta as { TransactionResult?: string }).TransactionResult
      : undefined;

  return {
    status: resultCode ?? "unknown",
    hash: submitted.result.hash,
    account: wallet.classicAddress,
    currency: decodeCurrency(encoded),
    issuer,
    xrp_spent_max: xrpAmount,
    expected_tokens: expectedTokens,
    deliver_min: deliverMinValue,
    quote_source: quote.source,
    trustline: trust,
  };
}

async function quoteXrpOut(
  xrpl: Client,
  currency: string,
  issuer: string,
  tokenIn: number,
): Promise<{ expectedXrp: number; source: string }> {
  try {
    const amm = await xrpl.request({
      command: "amm_info",
      asset: { currency: "XRP" },
      asset2: { currency, issuer },
    });
    const a = amountParts(amm.result.amm.amount as Amount);
    const b = amountParts(amm.result.amm.amount2 as Amount);
    const xrpReserve = a.currency === "XRP" ? a.value : b.value;
    const tokenReserve = a.currency === "XRP" ? b.value : a.value;
    const fee = Number(amm.result.amm.trading_fee) / 100_000;
    const effectiveIn = tokenIn * (1 - fee);
    const expectedXrp = xrpReserve - (xrpReserve * tokenReserve) / (tokenReserve + effectiveIn);
    if (expectedXrp > 0) {
      return { expectedXrp, source: "amm" };
    }
  } catch {
    // Fall through to DEX book.
  }

  const book = await xrpl.request({
    command: "book_offers",
    taker_gets: { currency: "XRP" },
    taker_pays: { currency, issuer },
    limit: 5,
  });
  const offer = book.result.offers[0];
  if (!offer) {
    throw new Error("No AMM pool or DEX offers to quote this sell");
  }
  const gets = amountParts(offer.TakerGets as Amount);
  const pays = amountParts(offer.TakerPays as Amount);
  if (pays.value <= 0) {
    throw new Error("DEX offer has zero token size");
  }
  return { expectedXrp: tokenIn * (gets.value / pays.value), source: "xrpl_dex" };
}

function maxSellSlippageBps(): number {
  const parsed = Number(process.env.MAX_SELL_SLIPPAGE_BPS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300;
}

function formatIssuedValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Issued amount must be positive");
  }
  return Number(value.toPrecision(15)).toString();
}

export async function buy_token(args: Record<string, unknown>): Promise<unknown> {
  return buyToken(args);
}

export async function sell_token(args: Record<string, unknown> = {}): Promise<unknown> {
  const currency = asString(args.currency);
  const issuer = asString(args.issuer);
  const amountTokens = asNumber(args.amountTokens) ?? asNumber(args.amount);
  if (!currency || isXrp(currency)) {
    throw new Error("sell_token requires an issued currency");
  }
  if (!issuer) {
    throw new Error("issuer is required");
  }
  if (amountTokens === undefined || amountTokens <= 0) {
    throw new Error("amountTokens must be a positive number");
  }

  const wallet = getWallet();
  const xrpl = await getXrplClient();
  const encoded = toXrplCurrency(currency);
  const lines = await xrpl.request({
    command: "account_lines",
    account: wallet.classicAddress,
    peer: issuer,
    ledger_index: "validated",
  });
  const line = lines.result.lines.find((entry) => entry.currency === encoded);
  const balance = line ? Number(line.balance) : 0;
  if (balance < amountTokens) {
    throw new Error(`Insufficient token balance: have ${balance}, need ${amountTokens}`);
  }

  const quote = await quoteXrpOut(xrpl, encoded, issuer, amountTokens);
  const slippageBps = maxSellSlippageBps();
  const minXrp = quote.expectedXrp * (1 - slippageBps / 10_000);
  if (minXrp <= 0) {
    throw new Error("Computed minimum XRP proceeds are not positive");
  }

  const offer: OfferCreate = {
    TransactionType: "OfferCreate",
    Account: wallet.classicAddress,
    TakerGets: {
      currency: encoded,
      issuer,
      value: formatIssuedValue(amountTokens),
    },
    TakerPays: xrpToDrops(minXrp),
    Flags: OfferCreateFlags.tfFillOrKill | OfferCreateFlags.tfSell,
  };

  const submitted = await xrpl.submitAndWait(offer, { wallet, autofill: true });
  const resultCode =
    submitted.result.meta && typeof submitted.result.meta === "object"
      ? (submitted.result.meta as { TransactionResult?: string }).TransactionResult
      : undefined;

  return {
    status: resultCode ?? "unknown",
    hash: submitted.result.hash,
    account: wallet.classicAddress,
    currency: decodeCurrency(encoded),
    issuer,
    tokens_sold: amountTokens,
    min_xrp: minXrp,
    expected_xrp: quote.expectedXrp,
    slippage_bps: slippageBps,
    quote_source: quote.source,
  };
}

async function checkBalance(args: Record<string, unknown>): Promise<unknown> {
  const xrpl = await getXrplClient();
  const address = asString(args.address) ?? getWallet().classicAddress;
  const info = await xrpl.request({
    command: "account_info",
    account: address,
    ledger_index: "validated",
  });
  const lines = await xrpl.request({
    command: "account_lines",
    account: address,
    ledger_index: "validated",
  });

  return {
    address,
    xrp: Number(dropsToXrp(info.result.account_data.Balance)),
    owner_count: info.result.account_data.OwnerCount,
    tokens: lines.result.lines.map((line) => ({
      currency: decodeCurrency(line.currency),
      issuer: line.account,
      balance: Number(line.balance),
      limit: line.limit,
    })),
  };
}

export const xrplTools: AgentTool[] = [
  {
    name: "get_price",
    description:
      "Get the current XRPL price. For XRP, returns USD from the DEX. For issued tokens, pass currency and issuer to price against XRP via AMM (DEX fallback).",
    parameters: {
      type: "object",
      properties: {
        currency: {
          type: "string",
          description: "Currency code (XRP, USD, or a token ticker / 160-bit hex code)",
        },
        issuer: {
          type: "string",
          description: "Token issuer classic address. Required for issued currencies.",
        },
      },
      required: ["currency"],
    },
    execute: getPrice,
  },
  {
    name: "get_xrp_price",
    description: "Fetch the current XRP/USD price from CoinGecko. Returns { priceUsd: number }.",
    parameters: {
      type: "object",
      properties: {
        vs: {
          type: "string",
          description: "Quote currency. Always USD; included so the model can call the tool with an empty object.",
        },
      },
    },
    execute: get_xrp_price,
  },
  {
    name: "get_launches",
    description:
      "List recently launched XRPL tokens / AMM pools. Prefers XMagnetic/GeckoTerminal new pools, then scans recent validated ledgers for AMMCreate (not account_tx).",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of launches to return (default 10, max 25)",
        },
      },
    },
    execute: get_launches,
  },
  {
    name: "buy_token",
    description:
      "Buy an issued XRPL token by spending XRP from the configured wallet. Enforces max_buy_xrp, min_xrp_reserve, and max_slippage_bps. Creates a trustline if needed.",
    parameters: {
      type: "object",
      properties: {
        currency: {
          type: "string",
          description: "Token currency code or 160-bit hex",
        },
        issuer: {
          type: "string",
          description: "Token issuer classic address",
        },
        xrp_amount: {
          type: "number",
          description: "Maximum XRP to spend",
        },
      },
      required: ["currency", "issuer", "xrp_amount"],
    },
    execute: buy_token,
  },
  {
    name: "sell_token",
    description:
      "Sell an issued XRPL token back to XRP via OfferCreate (fill-or-kill) using XRPL_WALLET_SEED. Enforces MAX_SELL_SLIPPAGE_BPS (default 300).",
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
        amountTokens: {
          type: "number",
          description: "Amount of tokens to sell",
        },
      },
      required: ["issuer", "currency", "amountTokens"],
    },
    execute: sell_token,
  },
  {
    name: "check_balance",
    description:
      "Check XRP and issued-token balances. Defaults to the wallet derived from XRPL_WALLET_SEED.",
    parameters: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Classic address to inspect. Omit to use the configured wallet.",
        },
      },
    },
    execute: checkBalance,
  },
];
