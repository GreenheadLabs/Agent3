# Agent3

Greenhead Labs local Ollama agent server with XRPL tools. Runs on a Mac Mini M4 and is meant to be reached through a Cloudflare Tunnel.

## Setup

```bash
cp .env.example .env
# set XRPL_WALLET_SEED in .env — never commit it
npm install
npm start
```

The server listens on `0.0.0.0:3100`.

Expose it with Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:3100
```

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `OLLAMA_URL` | `http://localhost:11434` | Local Ollama |
| `MODEL` | `deepseek-r1:8b` | Quality model for `/v1/chat` and `/v1/trade-advice` |
| `MODEL_FAST` | `qwen2.5:7b` | Fast model for `/v1/sentiment` and `/v1/decision` |
| `XRPL_WALLET_SEED` | empty | Family seed only; never hardcoded |
| `PORT` | `3100` | HTTP port |
| `MAX_BUY_XRP` | `10` | Cap for `buy_token` |
| `MAX_SLIPPAGE_BPS` | `150` | `buy_token` DeliverMin slippage |
| `MIN_XRP_RESERVE` | `10` | XRP left in the wallet after a buy |

XRPL websocket: `wss://xrplcluster.com`.

## Routes

- `POST /v1/chat` — `{ "prompt": "...", "context": optional }` quality model + tool loop
- `POST /v1/trade-advice` — trade recommendation using the quality model
- `POST /v1/decision` — TradeDesk buy/skip using the fast model
- `POST /v1/sentiment` — `{ "text": "..." }` bullish/bearish/neutral using the fast model
- `GET /health` — `{ "status": "ok", "model", "model_fast", "uptime" }`
- `GET /v1/tools` — tool names and descriptions

## Tools

XRPL: `get_price`, `get_launches`, `buy_token`, `check_balance`

System: `get_status`, `get_risk_settings`

`buy_token` submits a real mainnet payment from the wallet derived from `XRPL_WALLET_SEED`.
