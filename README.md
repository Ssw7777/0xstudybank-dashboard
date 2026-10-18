# Asset Dashboard

自托管、只读的加密资产看板（Next.js 15）。把多钱包链上余额、DeFi 仓位、交易所余额和手动登记资产汇总到同一界面，并提供历史快照、资金变动流水与垃圾币过滤。

Self-hosted, **read-only** crypto portfolio dashboard. Aggregates multi-wallet on-chain balances, DeFi positions, CEX balances and manual assets — with snapshots, flows and junk-token filtering.

## 功能概览

- **链上钱包**：EVM / Abstract 等；默认走 Rabby 公开接口，失败时回退 OKX Web3、Zerion、Alchemy RPC、币安 Web3 DeFi 等
- **DeFi 仓位**：Rabby `complex_protocol_list`，币安 Web3 `position/list` 作备用；部分协议有直连 RPC 读取
- **垃圾币过滤**：按名单与启发式剔除 spam / 风险代币（见 `src/lib/onchain/junk-tokens.ts`）
- **交易所**：OKX / Binance / Gate / Bitget，**仅支持只读 API Key**
- **手动资产**：法币、线下持仓等可在界面登记；可选 USD→CNY 汇率
- **历史与流水**：定时快照、估值变动与链上转入/转出流水、CSV 导出
- **登录**：单用户密码登录；可选 Turso（libSQL）持久化
- **定时刷新**：`/api/cron/refresh`，用 `CRON_SECRET` 或 GitHub Actions OIDC 鉴权

## 快速开始

```bash
git clone https://github.com/Ssw7777/0xstudybank-dashboard.git
cd 0xstudybank-dashboard
pnpm install          # 或 npm install / yarn
cp .env.example .env.local
# 至少填写 DASHBOARD_PASSWORD 与 SESSION_SECRET
pnpm dev
```

浏览器打开 <http://localhost:3000>，登录后：

1. 在 **Addresses** 添加钱包地址
2. 在 **Manual** 登记手动资产（可选）
3. 触发一次刷新，或配置定时任务（见下方「部署」）

本地无 Turso 时，数据写在 `data/store.json`（已在 `.gitignore` 中忽略）。

## 配置说明

所有配置通过环境变量完成。复制 `.env.example` 为 `.env.local`（本地）或在部署平台填入同名变量。仓库内**不包含**真实 Key、钱包地址、域名或服务器 IP。

```bash
cp .env.example .env.local
```

完整变量见 [`.env.example`](./.env.example)。下表按用途分组：

### 必填

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `DASHBOARD_PASSWORD` | 是 | 登录密码 |
| `SESSION_SECRET` | 是 | Session 签名密钥（建议 ≥32 位随机字符串） |

### 持久化与加密

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `TURSO_DATABASE_URL` | 否 | Turso / libSQL 连接 URL；不填则用本地 `data/store.json` |
| `TURSO_AUTH_TOKEN` | 否 | Turso 鉴权 Token |
| `ENCRYPTION_KEY` | 否* | 界面保存的交易所密钥加密用（AES-256-GCM；64 位 hex 或任意口令）。*在 UI 里存 CEX 密钥时需要 |

### 钱包种子（可选；也可只在界面管理）

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `SEED_WALLETS` | 否 | JSON 数组，首次启动写入示例钱包。格式：`[{"name":"Main","address":"0x…","chain":"EVM"}]` |
| `PAUSED_WALLET_ADDRESSES` | 否 | 逗号分隔地址；暂停自动刷新，仅展示缓存 |

### 汇率

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `USD_CNY_RATE` | 否 | USD→CNY 汇率；也可在界面修改 |

### 交易所（只读 Key）

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `OKX_API_KEY` / `OKX_API_SECRET` / `OKX_API_PASSPHRASE` | 否 | OKX 只读 |
| `OKX_SIMULATED` | 否 | 设为 `1` 时走 OKX 模拟盘 |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | 否 | 币安交易所只读 |
| `GATE_API_KEY` / `GATE_API_SECRET` | 否 | Gate 只读 |
| `BITGET_API_KEY` / `BITGET_API_SECRET` / `BITGET_API_PASSPHRASE` | 否 | Bitget 只读 |

### 链上 / DeFi 数据源（全部可选）

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `BN_WEB3_API_KEY` / `BN_WEB3_API_SECRET` | 否 | [币安 Web3 开发者](https://web3.binance.com/en/dev-portal/project) Key；建议只勾 Market / Wallet / DeFi，作 DeFi 仓位备用源 |
| `OKX_WEB3_API_KEY` / `OKX_WEB3_API_SECRET` / `OKX_WEB3_PASSPHRASE` | 否 | OKX Web3 |
| `OKX_ONCHAINOS_API_KEY` / `OKX_ONCHAINOS_API_SECRET` / `OKX_ONCHAINOS_API_PASSPHRASE` | 否 | OKX OnchainOS |
| `ALCHEMY_API_KEY` | 否 | Alchemy RPC |
| `ZERION_API_KEY` | 否 | Zerion |
| `ZERION_API_KEYS` | 否 | 额外 Zerion Key，逗号分隔 |
| `COINSTATS_API_KEY` | 否 | CoinStats 行情 |
| `DEBANK_ACCESS_KEY` | 否 | DeBank |

### 定时刷新鉴权

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `CRON_SECRET` | 否* | `Authorization: Bearer <secret>` 调用 `/api/cron/refresh`。*生产环境建议配置 |
| `GITHUB_OIDC_AUDIENCES` | 否 | 逗号分隔的 OIDC audience（通常等于看板对外 URL） |
| `GITHUB_OIDC_TRUSTED_WORKFLOWS` | 否 | 信任的 workflow 标识 JSON 数组 |

### 其他

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `FORCE_INSECURE_COOKIES` | 否 | 本地 HTTP 调试时允许非 Secure Cookie |
| `SANITIZE_ON_READ` | 否 | 读取快照时做锯齿清洗（调试用） |

> **安全**：只用**只读** API Key；不要把 `.env` / `.env.local` 提交进 Git；公开仓库里不要放真实钱包地址、域名或服务器 IP。

## 部署建议

### Node / VPS / Docker

```bash
pnpm build && pnpm start
```

`next.config` 使用 `output: "standalone"`，可按需打进 Docker 镜像自托管。把环境变量注入容器或 systemd 单元即可。

### Vercel

仓库含 `vercel.json`。在项目 Environment Variables 中填入上表变量后部署。

### Cloudflare Workers（OpenNext）

```bash
pnpm deploy
```

在 `wrangler.jsonc` 中配置你自己的 Cloudflare `account_id`，或通过 `CLOUDFLARE_ACCOUNT_ID` 环境变量注入，**不要把真实 account id 写进公开提交**。

### 定时刷新（推荐配合公开调度仓库）

本仓库提供手动备用 workflow：`.github/workflows/production-refresh.yml`。

更完整的定时调度见公开仓库 [0xstudybank-scheduler](https://github.com/Ssw7777/0xstudybank-scheduler)：

1. 在 **scheduler** 仓库设置 Repository Variable：`DASHBOARD_URL` = 你的看板根 URL（例如 `https://your-dashboard.example.com`）
2. 在看板上配置 `CRON_SECRET`，或配置 `GITHUB_OIDC_AUDIENCES`（与 `DASHBOARD_URL` 一致）并信任对应 workflow
3. **不要**把真实 URL 写进公开代码；只用仓库 / Worker 变量

调用示例：

```bash
curl -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "$DASHBOARD_URL/api/cron/refresh?mode=auto"
```

## 测试

```bash
npx tsc --noEmit
node --test --import tsx tests/*.test.mjs
```

## 项目结构（简要）

```
src/
  app/           # Next.js App Router（页面与 API）
  components/    # UI
  lib/           # 刷新、CEX、链上、鉴权、快照清洗等
tests/           # 单元测试
.env.example     # 环境变量模板
```

## License

MIT
