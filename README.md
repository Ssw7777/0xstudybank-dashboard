# Asset Dashboard

A self-hosted, read-only crypto portfolio dashboard built with Next.js 15.
It aggregates on-chain wallets (EVM / Abstract), DeFi positions, CEX balances
(OKX, Binance, Gate, Bitget) and manually entered assets into one view with
history snapshots, flow tracking and junk-token filtering.

自托管的只读加密资产看板（Next.js 15）：汇总链上钱包、DeFi 仓位、交易所余额和手动资产，
支持历史快照、资金流水和垃圾币过滤。

## Features

- Wallet balances via Rabby public API, with fallbacks (OKX Web3, Zerion, Alchemy RPC, Binance Web3 DeFi)
- DeFi positions (Rabby `complex_protocol_list`, Binance Web3 `position/list` backup, direct RPC readers)
- Junk / spam token filtering (`src/lib/onchain/junk-tokens.ts`)
- CEX balances with **read-only** API keys
- Snapshots, change history, flows, CSV export
- Password login (single user), optional Turso persistence
- Cron refresh endpoint (`/api/cron/refresh`) protected by `CRON_SECRET` or GitHub OIDC

## Quick start

```bash
pnpm install          # or npm install
cp .env.example .env.local
# fill in DASHBOARD_PASSWORD and SESSION_SECRET at minimum
pnpm dev
```

Open http://localhost:3000, log in, then add wallets in **Addresses** and manual assets in **Manual**.

## Configuration

All configuration is via environment variables; see [`.env.example`](./.env.example).
Nothing personal is hard-coded: wallets come from the UI / database or the optional
`SEED_WALLETS` env var.

| Variable | Purpose |
|---|---|
| `DASHBOARD_PASSWORD`, `SESSION_SECRET` | Login (required) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Persistent store (optional) |
| `ENCRYPTION_KEY` | Encrypt CEX keys saved via UI |
| `SEED_WALLETS`, `PAUSED_WALLET_ADDRESSES` | Optional initial wallets / paused wallets |
| `OKX_*`, `BINANCE_*`, `GATE_*`, `BITGET_*` | CEX read-only keys |
| `BN_WEB3_*`, `OKX_WEB3_*`, `OKX_ONCHAINOS_*`, `ALCHEMY_API_KEY`, `ZERION_API_KEY(S)`, `COINSTATS_API_KEY`, `DEBANK_ACCESS_KEY` | Optional data providers |
| `CRON_SECRET`, `GITHUB_OIDC_AUDIENCES`, `GITHUB_OIDC_TRUSTED_WORKFLOWS` | Scheduled refresh auth |

> Only ever use **read-only** API keys. Never commit `.env*` files.

## Deploy

- Node / Docker / VPS: `pnpm build && pnpm start` (`output: "standalone"`)
- Vercel: `vercel.json` included
- Cloudflare Workers: `pnpm deploy` via OpenNext (set your own account id in `wrangler.jsonc`)
- GitHub Actions fallback refresh: `.github/workflows/production-refresh.yml` (set repo variable `DASHBOARD_URL`)

## Tests

```bash
npx tsc --noEmit
node --test --import tsx tests/*.test.mjs
```

## License

MIT
