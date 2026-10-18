# Asset Dashboard

自托管、**只读**的加密资产看板（Next.js 15）。把多钱包链上余额、DeFi 仓位、交易所余额和手动登记资产汇总到同一界面，并提供历史快照、资金变动流水与垃圾币过滤。

Self-hosted, **read-only** crypto portfolio dashboard. Aggregates multi-wallet on-chain balances, DeFi positions, CEX balances and manual assets — with snapshots, flows and junk-token filtering.

> **重要（别人克隆后必读）**  
> 本仓库**只有**看板 Web 应用与刷新 API，**不会**在后台自己持续拉数据。  
> 生产环境必须在**同一台服务器**上配置 **cron / systemd timer**，周期性 `POST` 本机 `http://127.0.0.1:3000/api/cron/refresh`。  
> 只部署网页、不配定时器 → 界面能开，但数据不会自动更新。这是预期行为，不是 bug。  
> 详见 [定时刷新（必做）](#定时刷新必做) 与 [`docs/scheduled-refresh.md`](./docs/scheduled-refresh.md)。

## 目录

- [架构说明](#架构说明)
- [功能概览](#功能概览)
- [快速开始（本地）](#快速开始本地)
- [环境变量](#环境变量)
- [生产部署（VPS）](#生产部署vps)
- [定时刷新（必做）](#定时刷新必做)
- [选配数据源](#选配数据源)
- [常见问题](#常见问题)
- [安全建议](#安全建议)
- [测试](#测试)
- [项目结构](#项目结构)
- [License](#license)

## 架构说明

```
┌──────────────────────┐         POST /api/cron/refresh
│  VPS cron / systemd  │ ──────► ┌──────────────────────┐
│  (same host)         │         │  Asset Dashboard     │
│  127.0.0.1:3000      │         │  (this repo)         │
└──────────────────────┘         │  - UI + login        │
                                 │  - refresh API       │
                                 │  - snapshots / store │
                                 └──────────┬───────────┘
                                            │
                      ┌─────────────────────┼─────────────────────┐
                      ▼                     ▼                     ▼
               On-chain / DeFi          CEX (read-only)      Manual assets
               (Rabby, BN Web3, …)      (OKX / Binance / …)  (UI or seed)
```

| 组件 | 职责 | 本仓库是否包含 |
|---|---|---|
| 看板应用 | 登录、展示、快照、手动触发刷新、暴露 `/api/cron/refresh` | 是 |
| 宿主机定时器 | 按固定间隔调用本机刷新 API | **否**（需自建，见下方示例） |
| 持久化 | 本地 `data/store.json` 或 Turso/libSQL | 可选配置 |

## 功能概览

- **链上钱包**：EVM / Abstract 等；默认走 Rabby 公开接口，失败时回退 OKX Web3、Zerion、Alchemy RPC、币安 Web3 DeFi 等
- **DeFi 仓位**：Rabby `complex_protocol_list`；币安 Web3 `position/list` 作备用；部分协议有直连 RPC
- **垃圾币过滤**：按名单与启发式剔除 spam / 风险代币（见 `src/lib/onchain/junk-tokens.ts`）
- **交易所**：OKX / Binance / Gate / Bitget，**仅支持只读 API Key**
- **手动资产**：法币、线下持仓等可在界面登记；可选 USD→CNY 汇率
- **历史与流水**：快照、估值变动与链上转入/转出流水、CSV 导出
- **登录**：单用户密码登录；可选 Turso（libSQL）持久化
- **定时刷新**：由本机 cron / systemd 调用刷新 API（`CRON_SECRET`）

## 快速开始（本地）

```bash
git clone https://github.com/Ssw7777/0xstudybank-dashboard.git
cd 0xstudybank-dashboard
pnpm install          # 或 npm install / yarn
cp .env.example .env.local
```

编辑 `.env.local`，至少填写：

```bash
DASHBOARD_PASSWORD=your-password
SESSION_SECRET=replace-with-a-long-random-string
CRON_SECRET=replace-with-another-long-random-string
```

可选：用环境变量预置钱包（**请换成你自己的地址，勿提交真实地址**）：

```bash
SEED_WALLETS=[{"name":"Main","address":"0x0000000000000000000000000000000000000000","chain":"EVM"}]
```

启动：

```bash
pnpm dev
```

浏览器打开 <http://localhost:3000>，登录后：

1. 在 **Addresses** 添加钱包（若未用 `SEED_WALLETS`）
2. 在 **Manual** 登记手动资产（可选）
3. 在界面手动触发一次刷新，或本机用 cron 打本地端口（见下方）

本地未配置 Turso 时，数据写在 `data/store.json`（已在 `.gitignore` 中忽略）。

## 环境变量

所有配置通过环境变量完成。复制 [`.env.example`](./.env.example) 为 `.env.local`（本地）或在部署环境注入同名变量。仓库内**不包含**真实 Key、钱包地址、域名或服务器 IP。

### 必填

| 变量 | 说明 |
|---|---|
| `DASHBOARD_PASSWORD` | 登录密码 |
| `SESSION_SECRET` | Session 签名密钥（建议 ≥32 位随机字符串） |

### 生产强烈建议

| 变量 | 说明 |
|---|---|
| `CRON_SECRET` | 本机定时器调用 `/api/cron/refresh` 时的 Bearer；与 systemd/cron 环境文件保持一致 |

### 持久化与加密

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `TURSO_DATABASE_URL` | 否 | Turso / libSQL 连接 URL；不填则用本地 `data/store.json` |
| `TURSO_AUTH_TOKEN` | 否 | Turso 鉴权 Token |
| `ENCRYPTION_KEY` | 否* | 界面保存的交易所密钥加密用（AES-256-GCM；64 位 hex 或任意口令）。*在 UI 里存 CEX 密钥时需要 |

多实例 / 无状态托管建议配置 Turso，否则重启或换机器会丢本地 `store.json`。单机 VPS 挂载数据卷即可。

### 钱包种子

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `SEED_WALLETS` | 否 | JSON 数组，首次启动写入钱包。格式见上节示例 |
| `PAUSED_WALLET_ADDRESSES` | 否 | 逗号分隔地址；暂停自动刷新，仅展示缓存 |

也可只在界面管理地址，不必写环境变量。

### 汇率

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `USD_CNY_RATE` | 否 | USD→CNY 汇率；也可在界面修改 |

### 交易所（只读 Key）

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `OKX_API_KEY` / `OKX_API_SECRET` / `OKX_API_PASSPHRASE` | 否 | OKX 只读 |
| `OKX_SIMULATED` | 否 | 设为 `1` 时走 OKX 模拟盘 |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | 否 | 币安**交易所**只读（现货等余额） |
| `GATE_API_KEY` / `GATE_API_SECRET` | 否 | Gate 只读 |
| `BITGET_API_KEY` / `BITGET_API_SECRET` / `BITGET_API_PASSPHRASE` | 否 | Bitget 只读 |

### 链上 / DeFi 数据源（全部可选）

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `BN_WEB3_API_KEY` / `BN_WEB3_API_SECRET` | 否 | [币安 Web3 开发者](https://web3.binance.com/en/dev-portal/project) Key；建议只勾 Market / Wallet / DeFi，作 **DeFi 仓位备用源**（与上面的交易所 Key 不同） |
| `OKX_WEB3_API_KEY` / `OKX_WEB3_API_SECRET` / `OKX_WEB3_PASSPHRASE` | 否 | OKX Web3 |
| `OKX_ONCHAINOS_API_KEY` / `OKX_ONCHAINOS_API_SECRET` / `OKX_ONCHAINOS_API_PASSPHRASE` | 否 | OKX OnchainOS |
| `ALCHEMY_API_KEY` | 否 | Alchemy RPC |
| `ZERION_API_KEY` | 否 | Zerion |
| `ZERION_API_KEYS` | 否 | 额外 Zerion Key，逗号分隔 |
| `COINSTATS_API_KEY` | 否 | CoinStats 行情 |
| `DEBANK_ACCESS_KEY` | 否 | DeBank |

无额外 Key 时，多数场景仍可依赖 Rabby 等公开接口；配置备用源可在限流或失败时提高成功率。

### 其他

| 变量 | 必填 | 说明 |
|---|:---:|---|
| `FORCE_INSECURE_COOKIES` | 否 | 本地 HTTP 调试时允许非 Secure Cookie |
| `SANITIZE_ON_READ` | 否 | 读取快照时做锯齿清洗（调试用） |

高级：源码仍支持可选的 OIDC 相关环境变量；自托管场景**不需要**配置它们。

## 生产部署（VPS）

推荐：**一台 VPS + Docker / Node standalone + 反向代理 + 本机 systemd timer**。

```bash
pnpm install
pnpm build
pnpm start
# 默认监听 3000；用 Caddy / nginx 终结 TLS 并反代到 127.0.0.1:3000
```

`next.config` 使用 `output: "standalone"`，可按需打进 Docker：

```dockerfile
# 示例骨架：按需调整 Node 版本与拷贝路径
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

把环境变量注入容器、systemd 单元或 `EnvironmentFile`，**不要**写进镜像层或公开仓库。

可选：仓库仍含 `vercel.json` / OpenNext 配置，方便有需要的人部署到其他平台；**无论部署在哪，都必须另配定时刷新**（VPS 上最稳的是本机 cron/systemd）。

部署完成后，立刻配置下一节。

## 定时刷新（必做）

看板暴露：

```http
POST /api/cron/refresh?mode=auto
Authorization: Bearer <CRON_SECRET>
```

### 推荐：systemd timer（同机）

1. 复制示例脚本与 unit：[`docs/examples/`](./docs/examples/)
2. 写入 `/etc/dashboard-refresh.env`（权限 `600`）：

```bash
CRON_SECRET=与看板上相同的值
DASHBOARD_URL=http://127.0.0.1:3000
```

3. 启用 timer：

```bash
sudo systemctl enable --now dashboard-refresh.timer
systemctl list-timers dashboard-refresh.timer
```

### 备选：crontab

```bash
* * * * * curl -fsS -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "http://127.0.0.1:3000/api/cron/refresh?mode=auto"
```

完整说明与验收清单：[`docs/scheduled-refresh.md`](./docs/scheduled-refresh.md)。

## 选配数据源

### 交易所余额

在环境变量或界面中填入**只读** Key。交易权限不要开。界面保存密钥时需要 `ENCRYPTION_KEY`。

### 币安 Web3 DeFi 备用源

与币安交易所 API 不同，这是 [Web3 开发者门户](https://web3.binance.com/en/dev-portal/project) 的 Key：

- 建议权限：仅 Market / Wallet / DeFi（只读）
- 用途：Rabby DeFi 拉取失败或限流时，用 `position/list` 顶上
- 看板会按现有规则过滤垃圾币；钱包余额接口一般不用于直接加总估值

不配也能跑；有大额 DeFi 仓位时建议配置以提高稳定性。

### 其他链上源

Alchemy / Zerion / OKX Web3 等按需添加，均可空。

## 常见问题

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 网页能开，数据一直旧 | **未配置本机定时器** | 按「定时刷新」配 systemd / cron |
| 调度返回 401 / 403 | `CRON_SECRET` 与看板不一致 | 核对 EnvironmentFile 与看板环境 |
| 刷新 partial / 部分钱包 stale | 上游限流或单轮 `walletBudget` 过小 | 配备用源（如 BN Web3）；略提高频率或 budget |
| 重启后数据清空 | 未挂载数据卷 / 未配 Turso | 持久化 `data/` 或配置 `TURSO_*` |
| CEX 余额为 0 | Key 权限/签名错误，或未触发刷新 | 确认只读 Key；手动或 timer 触发 refresh |
| DeFi 缺大仓位 | 主源失败且未配备用 | 配置 `BN_WEB3_*` 等 |
| 垃圾币抬高估值 | 过滤名单未覆盖 | 见 `src/lib/onchain/junk-tokens.ts`；欢迎提 PR |

## 安全建议

- 只用**只读** API Key；不要开启提现 / 交易权限
- 不要把 `.env` / `.env.local` / 真实 URL / IP / 钱包地址提交进 Git
- 定时器打 `127.0.0.1`，避免把 `CRON_SECRET` 暴露到公网
- `CRON_SECRET` 与登录密码同等重要
- 公开 fork / 演示请使用占位地址与空 Key

## 测试

```bash
npx tsc --noEmit
node --test --import tsx tests/*.test.mjs
```

## 项目结构

```
src/
  app/                 # Next.js App Router（页面与 API）
  components/          # UI
  lib/                 # 刷新、CEX、链上、鉴权、快照清洗等
docs/
  scheduled-refresh.md # 定时刷新完整说明（VPS cron / systemd）
  examples/            # cron 脚本 + systemd unit 脱敏示例
tests/
.env.example           # 环境变量模板
```

## License

MIT
