import { Client, dropsToXrp } from "xrpl";
import { asString, type AgentTool } from "./types";

const XRPL_WSS = "wss://xrplcluster.com";

function decodeCurrency(code: string): string {
  if (!/^[A-Fa-f0-9]{40}$/.test(code)) {
    return code;
  }
  const decoded = Buffer.from(code, "hex").toString("utf8").replace(/\0/g, "").trim();
  return decoded || code;
}

export async function get_portfolio(
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const address = asString(args.address);
  if (!address) {
    throw new Error("address is required");
  }

  const client = new Client(XRPL_WSS);
  await client.connect();
  try {
    const info = await client.request({
      command: "account_info",
      account: address,
      ledger_index: "validated",
    });
    const lines = await client.request({
      command: "account_lines",
      account: address,
      ledger_index: "validated",
    });

    const xrp = Number(dropsToXrp(info.result.account_data.Balance));
    const tokens = lines.result.lines
      .map((line) => ({
        currency: decodeCurrency(line.currency),
        issuer: line.account,
        balance: Number(line.balance),
        limit: line.limit,
      }))
      .filter((token) => token.balance !== 0);

    return {
      address,
      source: XRPL_WSS,
      xrp,
      owner_count: info.result.account_data.OwnerCount,
      token_count: tokens.length,
      tokens,
    };
  } finally {
    await client.disconnect();
  }
}

export const portfolioTools: AgentTool[] = [
  {
    name: "get_portfolio",
    description:
      "Fetch XRP and issued-token balances for an XRPL classic address via xrplcluster.com.",
    parameters: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "XRPL classic address (r...)",
        },
      },
      required: ["address"],
    },
    execute: get_portfolio,
  },
];
