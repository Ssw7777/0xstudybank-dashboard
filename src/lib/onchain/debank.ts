import type {
  ChainAllocation,
  DappAllocation,
  DappChainAllocation,
  DappTokenPosition,
  DappWalletShare,
  OnchainBreakdown,
  TokenLine,
  TokenHolding,
  WalletChainCacheEntry,
  WalletLongtailCacheEntry,
  WalletProtocolCacheEntry,
  WalletTokenCacheEntry,
  ZerionDefiCacheEntry,
  Wallet,
} from "../types";
import { activeTokenSource, fetchZerionTokens, type TokenSource } from "./token-providers";
import { mergeTokenCacheObservation, tokenCacheNeedsRefresh, tokenIdentity, hasNonzeroHolding } from "./token-cache-policy";
import {preserveRpcProtocols} from './protocol-observation';
import { comparedTokensFromLines, shouldRejectIncomingWalletTotal } from './total-calibration';
import { isDustTokenValue, isJunkTokenSymbol } from './junk-tokens';
import { bnWeb3Credentials } from './bn-web3';
import {
  collectBnDefiTokenKeys,
  fetchBnDefiProtocols,
  mergeBnProtocolsWithPrevious,
} from './bn-web3-observation';
import { isWalletRefreshEnabled } from '../wallets';

export interface ChainBalanceDetail {
  id: string;
  name: string;
  valueUsd: number;
  logoUrl?: string;
}

export interface TotalBalanceDetail {
  totalUsd: number;
  chains: ChainBalanceDetail[];
  /** chain_list was present and the total is ~0, so the provider explicitly says empty. */
  explicitEmpty?: boolean;
}

export interface AppBalanceDetail {
  chains: ChainBalanceDetail[];
  protocols: Record<string, unknown>[];
}

/** Token lines for one wallet, already classified. `chain` is the DeBank chain id. */
interface WalletTokenDetail {
  tokens: Array<TokenLine & { chain: string }>;
  unpricedCount: number;
  unpricedByChain: Record<string, number>;
  /** 本次真正取到明细的链；`*` 表示官方接口一次性覆盖全部链。 */
  coveredChains: string[];
}

const cache = new Map<string, { detail: TotalBalanceDetail; at: number; complete: boolean }>();
const TTL = 5 * 60 * 1000;
/** 协议明细缓存 6 小时；过期时一轮尝试补齐全部地址，失败则继续保留上次成功值。 */
const PROTOCOL_TTL = 6 * 60 * 60 * 1000;
/** Failed protocol reads retry after 30 minutes instead of occupying every rolling batch. */
const PROTOCOL_RETRY_TTL = 30 * 60 * 1000;
/** One protocol request per batch is enough to refresh all 25 records well inside the 6-hour TTL. */
const PROTOCOL_WALLET_BUDGET = 1;
/**
 * Active EVM set is ~15; budget 3/min from pinned Rabby totals (8s spaced).
 * OKX/Zerion must NOT publish competing wallet totals — they miss Base
 * tokenized equities (NVDAc / 1inch stock campaign) and cause ±$1k flaps.
 * CF fires wallet-batch every minute while walletsOver5min > 0 or oldest > 90s.
 */
const MAX_PUBLIC_REQUESTS_PER_RUN = 3;
/**
 * 直连层（Alchemy/Zerion 鉴权接口）可以并行：无公共接口的串行限制。
 * 公共源兜底请求仍会被 waitForPublicSlot 全局串行化，互不冲突。
 */
const CONCURRENCY = 1;
/**
 * Rabby / DeBank 公共接口严格串行；相邻请求至少间隔 8 秒。
 * 刚成功的地址默认跳过约 90 秒，避免五分钟窗口内重复烧额度。
 */
const PUBLIC_REQUEST_INTERVAL_MS = 8_000;
/** Skip wallets whose lastSuccess is newer than this (unless only/live). */
const FRESH_SKIP_MS = 60_000;
/**
 * 代币明细发现额度控制：成功缓存 12 小时，失败至少间隔 15 分钟；每轮最多 1 个地址。
 * lastAttemptAt 仅用于失败退避，不能冒充上次成功更新时间。
 */
const TOKEN_WALLET_BUDGET = 1;
const TOKEN_CHAINS_PER_WALLET = 3;
const TOKEN_MIN_CHAIN_USD = 5;
const TOKEN_MIN_VALUE_USD = 0.01;

/** 稳定币白名单：这些代币在链上分类时归入“稳定币”，其余归入“现货”。 */
const STABLE_SYMBOLS = new Set([
  "USDT", "USDC", "USDG", "USDE", "USD1", "USDT.E", "USDC.E", "USDT0", "USD0",
  "DAI", "FDUSD", "TUSD", "BUSD", "USDD", "PYUSD", "GHO", "USDS", "SUSDE", "SUSDS",
  "FRAX", "LUSD", "USDX", "USDP", "USDR", "USDF", "USDY", "USD+", "SUSD", "CRVUSD",
]);

const TOKENS_PER_GROUP = 12;

let publicRequestQueue: Promise<void> = Promise.resolve();
let nextPublicRequestAt = 0;
/**
 * 公共接口（Rabby / DeBank 无 Key 路径）被限流后的全局冷却截止时间。
 * 冷却期内不再发新请求，直接沿用上次成功数据，避免把 429 变成请求轰炸。
 */
const publicBlockedUntilByHost = new Map<string, number>();
/** 连续 429 按主机隔离：App 接口限流不能拖死 Rabby 的钱包总额。 */
const publicConsecutive429ByHost = new Map<string, number>();

export type WalletFetchStatus = "ok" | "cached" | "error";

export function getPublicBlockedUntil(): number {
  return Math.max(0, ...publicBlockedUntilByHost.values());
}

function publicHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function publicBlocked(url?: string): boolean {
  if (url) return Date.now() < (publicBlockedUntilByHost.get(publicHost(url)) ?? 0);
  return Date.now() < getPublicBlockedUntil();
}

function markPublicBlocked(url: string, ms: number) {
  // Longer cooldown after consecutive 429s; scheduler keeps ticking smaller batches.
  const wait = Math.min(3 * 60_000, Math.max(30_000, ms));
  const host = publicHost(url);
  publicBlockedUntilByHost.set(
    host,
    Math.max(publicBlockedUntilByHost.get(host) ?? 0, Date.now() + wait)
  );
}

const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapObject(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    return record.data as Record<string, unknown>;
  }
  return record;
}

function unwrapArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  const list = Array.isArray(record.data)
    ? record.data
    : record.data && typeof record.data === "object" && Array.isArray((record.data as Record<string, unknown>).list)
      ? ((record.data as Record<string, unknown>).list as unknown[])
      : Array.isArray(record.list)
        ? record.list
        : [];
  return list.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

export function parseTotalDetail(data: unknown): TotalBalanceDetail | null {
  const body = unwrapObject(data);
  if (!body) return null;
  const rawTotal = body.total_usd_value ?? body.total_usd;
  const totalUsd = Number(rawTotal);
  if (!Number.isFinite(totalUsd) || totalUsd < 0) return null;
  // A bare {total_usd_value:0} without chain_list is a degraded payload, not an empty wallet.
  if (!Array.isArray(body.chain_list)) return null;
  const rawChains = body.chain_list;
  const chains = rawChains
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((chain) => ({
      id: String(chain.id || chain.community_id || "unknown"),
      name: String(chain.name || chain.id || "Unknown"),
      valueUsd: number(chain.usd_value ?? chain.total_usd_value),
      logoUrl: typeof chain.logo_url === "string" && chain.logo_url ? chain.logo_url : undefined,
    }))
    .filter((chain) => chain.valueUsd >= 0.01)
    .sort((left, right) => right.valueUsd - left.valueUsd);
  return { totalUsd, chains, explicitEmpty: totalUsd < 0.01 };
}

/** Parse a Rabby/DeBank complex-protocol response while preserving an empty, valid list. */
export function parseProtocolDetail(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return unwrapArray(data);
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const hasRecognizedList =
    Array.isArray(record.data) ||
    Array.isArray(record.list) ||
    (!!record.data &&
      typeof record.data === "object" &&
      Array.isArray((record.data as Record<string, unknown>).list));
  return hasRecognizedList ? unwrapArray(data) : null;
}

/**
 * DeBank renders app-native assets (for example Polymarket) next to chain assets,
 * but they are not included in `/user/total_balance`. Convert them into both a
 * synthetic allocation and a protocol row so every view uses the same net worth.
 */
export function parseAppDetail(data: unknown): AppBalanceDetail | null {
  const body = unwrapObject(data);
  if (!body || !Array.isArray(body.apps)) return null;
  const chains: ChainBalanceDetail[] = [];
  const protocols: Record<string, unknown>[] = [];
  for (const raw of body.apps) {
    if (!raw || typeof raw !== "object") continue;
    const app = raw as Record<string, unknown>;
    const items = Array.isArray(app.portfolio_item_list)
      ? app.portfolio_item_list.filter(
          (item): item is Record<string, unknown> => !!item && typeof item === "object"
        )
      : [];
    const valueUsd = items.reduce((sum, item) => {
      const stats = item.stats && typeof item.stats === "object"
        ? (item.stats as Record<string, unknown>)
        : {};
      return sum + number(stats.net_usd_value ?? stats.asset_usd_value);
    }, 0);
    if (Math.abs(valueUsd) < 0.01) continue;
    const id = String(app.id || app.name || "unknown");
    const name = String(app.name || app.id || "Unknown App");
    const logoUrl = typeof app.logo_url === "string" && app.logo_url ? app.logo_url : undefined;
    chains.push({ id: `app:${id}`, name, valueUsd, logoUrl });
    protocols.push({
      ...app,
      id: `app:${id}`,
      chain: `app:${id}`,
      chain_name: name,
      _assetMonitorSource: "app",
    });
  }
  chains.sort((left, right) => right.valueUsd - left.valueUsd);
  return { chains, protocols };
}

const commonHeaders = { Accept: "application/json", "User-Agent": "asset-monitor/0.2" };

function waitForPublicSlot(url: string) {
  const host = new URL(url).hostname;
  if (host !== "api.rabby.io" && host !== "api.debank.com") return Promise.resolve();
  const turn = publicRequestQueue.then(async () => {
    const delay = Math.max(0, nextPublicRequestAt - Date.now());
    if (delay) await sleep(delay);
    nextPublicRequestAt = Date.now() + PUBLIC_REQUEST_INTERVAL_MS;
  });
  publicRequestQueue = turn.catch(() => undefined);
  return turn;
}

function isPublicEndpoint(url: string) {
  try {
    const host = new URL(url).hostname;
    return host === "api.rabby.io" || host === "api.debank.com";
  } catch {
    return false;
  }
}

function retryDelay(response: Response, attempt: number) {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(8_000, Math.max(750, seconds * 1_000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(8_000, Math.max(750, date - Date.now()));
  }
  return Math.min(8_000, 900 * 2 ** attempt);
}

async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
  retries = 2,
  deadlineMs?: number
): Promise<{ data: unknown | null; status: number; attempted: boolean }> {
  const publicEndpoint = isPublicEndpoint(url);
  // 冷却期内直接返回限流状态：不再发请求，调用方沿用上次成功数据。
  if (publicEndpoint && publicBlocked(url)) return { data: null, status: 429, attempted: false };
  let attempted = false;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (deadlineMs != null && Date.now() >= deadlineMs - 500) {
      return { data: null, status: 0, attempted };
    }
    try {
      await waitForPublicSlot(url);
      if (deadlineMs != null && Date.now() >= deadlineMs - 500) {
        return { data: null, status: 0, attempted };
      }
      attempted = true;
      const timeoutMs =
        deadlineMs == null ? 10_000 : Math.max(500, Math.min(10_000, deadlineMs - Date.now()));
      const response = await fetch(url, {
        headers: { ...commonHeaders, ...headers },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        if (publicEndpoint) publicConsecutive429ByHost.set(publicHost(url), 0);
        return { data: await response.json(), status: response.status, attempted };
      }
      if (response.status === 429) {
        const wait = retryDelay(response, attempt);
        if (publicEndpoint) {
          const host = publicHost(url);
          const consecutive = (publicConsecutive429ByHost.get(host) ?? 0) + 1;
          publicConsecutive429ByHost.set(host, consecutive);
          // 偶发 429：先自己退避重试同一请求；只有连续多次才进入全局冷却
          if (consecutive >= 3) markPublicBlocked(url, wait);
          if (attempt < retries) {
            await sleep(wait);
            continue;
          }
          return { data: null, status: 429, attempted };
        }
        if (attempt < retries) {
          await sleep(wait);
          continue;
        }
        return { data: null, status: 429, attempted };
      }
      if (response.status >= 500 && attempt < retries) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      return { data: null, status: response.status, attempted };
    } catch {
      if (attempt < retries) {
        await sleep(Math.min(4_000, 600 * 2 ** attempt));
        continue;
      }
      return { data: null, status: 0, attempted };
    }
  }
  return { data: null, status: 0, attempted };
}

async function fetchAppDetailOnce(
  address: string
): Promise<{ detail: AppBalanceDetail | null; attempted: boolean }> {
  const response = await fetchJson(
    `https://api.debank.com/portfolio/app_list?user_id=${address}`,
    { Origin: "https://debank.com", Referer: "https://debank.com/" },
    0
  );
  return { detail: parseAppDetail(response.data), attempted: response.attempted };
}

async function fetchDetailOnce(
  address: string,
  previousAppChains: ChainBalanceDetail[] = []
): Promise<{
  detail: TotalBalanceDetail | null;
  apps: Record<string, unknown>[] | null;
  attempted: boolean;
  complete: boolean;
}> {
  const key = process.env.DEBANK_ACCESS_KEY;
  let attempted = false;
  let base: TotalBalanceDetail | null = null;
  if (key) {
    const response = await fetchJson(
      `https://pro-openapi.debank.com/v1/user/total_balance?id=${address}`,
      { AccessKey: key },
      1
    );
    attempted = attempted || response.attempted;
    base = parseTotalDetail(response.data);
  }
  let rabbyStatus = 0;
  if (!base) {
    const rabbyResponse = await fetchJson(
      `https://api.rabby.io/v1/user/total_balance?id=${address}`,
      {},
      1
    );
    rabbyStatus = rabbyResponse.status;
    attempted = attempted || rabbyResponse.attempted;
    base = parseTotalDetail(rabbyResponse.data);
  }
  // The legacy host is a last-resort fallback. Avoid doubling requests while Rabby is rate-limiting.
  if (!base && rabbyStatus !== 429 && rabbyStatus !== 0) {
    const legacyResponse = await fetchJson(
      `https://api.debank.com/user/total_balance?addr=${address}`,
      { Origin: "https://debank.com", Referer: "https://debank.com/" },
      0
    );
    attempted = attempted || legacyResponse.attempted;
    base = parseTotalDetail(legacyResponse.data);
  }
  if (!base) {
    console.warn(`[wallet-detail] no total for ${address.slice(0, 8)} rabby=${rabbyStatus} attempted=${attempted} blocked=${publicBlocked()}`);
    return { detail: null, apps: null, attempted, complete: false };
  }

  const appResult = await fetchAppDetailOnce(address);
  attempted = attempted || appResult.attempted;
  const appChains = appResult.detail?.chains ?? previousAppChains;
  const appUsd = appChains.reduce((sum, chain) => sum + chain.valueUsd, 0);
  return {
    detail: {
      totalUsd: base.totalUsd + appUsd,
      chains: [...base.chains, ...appChains].sort((left, right) => right.valueUsd - left.valueUsd),
      explicitEmpty: base.explicitEmpty === true && appUsd < 0.01,
    },
    apps: appResult.detail?.protocols ?? null,
    attempted,
    complete: appResult.detail !== null || previousAppChains.length > 0,
  };
}

async function fetchWalletDetail(
  address: string,
  force = false,
  previousAppChains: ChainBalanceDetail[] = []
): Promise<{
  detail: TotalBalanceDetail | null;
  apps: Record<string, unknown>[] | null;
  complete: boolean;
  status: WalletFetchStatus;
  attempted: boolean;
}> {
  const normalized = address.toLowerCase();
  const hit = cache.get(normalized);
  if (!force && hit && Date.now() - hit.at < TTL) {
    return { detail: hit.detail, apps: null, complete: hit.complete, status: "cached", attempted: false };
  }

  const { detail, apps, attempted, complete } = await fetchDetailOnce(normalized, previousAppChains);
  if (detail) {
    cache.set(normalized, { detail, at: Date.now(), complete });
    return { detail, apps, complete, status: "ok", attempted };
  }
  return hit
    ? { detail: hit.detail, apps: null, complete: hit.complete, status: "cached", attempted }
    : { detail: null, apps: null, complete: false, status: "error", attempted };
}

type ProtocolCache = Record<string, WalletProtocolCacheEntry>;
type ChainCache = Record<string, WalletChainCacheEntry>;

async function fetchComplexProtocols(
  address: string,
  store: ProtocolCache
): Promise<Record<string, unknown>[] | null> {
  const normalized = address.toLowerCase();
  const hit = store[normalized] || null;
  const now = Date.now();
  const successAt = hit?.at ? new Date(hit.at).getTime() : 0;
  const attemptedAt = hit?.lastAttemptAt ? new Date(hit.lastAttemptAt).getTime() : 0;
  if (hit && successAt > 0 && now - successAt < PROTOCOL_TTL) return hit.protocols;
  if (hit && attemptedAt > 0 && now - attemptedAt < PROTOCOL_RETRY_TTL) return hit.protocols;
  const attemptIso = new Date().toISOString();
  store[normalized] = hit
    ? { ...hit, lastAttemptAt: attemptIso }
    : { at: "", lastAttemptAt: attemptIso, protocols: [] };
  const key = process.env.DEBANK_ACCESS_KEY;
  const urls: Array<{ url: string; headers?: Record<string, string> }> = [];
  if (key) {
    urls.push({
      url: `https://pro-openapi.debank.com/v1/user/all_complex_protocol_list?id=${normalized}`,
      headers: { AccessKey: key },
    });
  }
  urls.push(
    { url: `https://api.rabby.io/v1/user/complex_protocol_list?id=${normalized}` }
  );
  for (const candidate of urls) {
    const response = await fetchJson(candidate.url, candidate.headers, 0);
    const protocols = parseProtocolDetail(response.data);
    if (protocols !== null) {
      store[normalized] = preserveRpcProtocols(store[normalized],{
        ...store[normalized],
        protocols,
        at: attemptIso,
        lastAttemptAt: attemptIso,
        lastError: undefined,
      });
      return store[normalized].protocols;
    }
  }
  // Rabby / DeBank failed or 429: Binance Web3 DeFi position/list as read-only backup.
  // Covers supported chains (incl. USDai@Arb); unsupported protocols keep the previous Rabby cache.
  if (bnWeb3Credentials()) {
    try {
      const bn = await fetchBnDefiProtocols(normalized);
      if (bn) {
        const merged = mergeBnProtocolsWithPrevious(hit?.protocols ?? [], bn.protocols);
        store[normalized] = preserveRpcProtocols(store[normalized], {
          ...store[normalized],
          protocols: merged,
          at: attemptIso,
          lastAttemptAt: attemptIso,
          lastError: undefined,
        });
        return store[normalized].protocols;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "bn_web3_failed";
      store[normalized] = {
        ...store[normalized],
        lastAttemptAt: attemptIso,
        lastError: /^bn_web3_[a-z0-9_]+$/.test(message) ? message : "bn_web3_failed",
      };
    }
  }
  return hit?.protocols ?? null;
}

function tokenKind(symbol: string, isCore: boolean): TokenLine["kind"] {
  const upper = symbol.toUpperCase();
  if (STABLE_SYMBOLS.has(upper)) return "stable";
  if (upper.endsWith(".E") && STABLE_SYMBOLS.has(upper.slice(0, -2))) return "stable";
  return isCore ? "native" : "spot";
}

/**
 * Parse `/v1/user/all_token_list` output into wallet token lines.
 * Returns null only when the response shape is unusable, so an empty wallet is still "ok".
 */
function parseTokenList(data: unknown): WalletTokenDetail | null {
  if (data === null || data === undefined) return null;
  const items = unwrapArray(data);
  const tokens: Array<TokenLine & { chain: string }> = [];
  const unpricedByChain: Record<string, number> = {};
  let unpricedCount = 0;
  for (const item of items) {
    const symbol = String(item.optimized_symbol || item.display_symbol || item.symbol || "").trim();
    if (!symbol || isJunkTokenSymbol(symbol, String(item.name || ""))) continue;
    const amount = number(item.amount);
    if (!amount || Math.abs(amount) < 1e-9) continue;
    const chain = String(item.chain || "unknown");
    // Protocol receipt tokens (aToken / PT / YT / LP share…) belong to the DApp section,
    // not to “钱包内稳定币 / 现货”. Skipping them keeps the two views from double-explaining.
    if (String(item.protocol_id || "").trim()) continue;
    const price = number(item.price);
    const valueUsd = number(item.usd_value) || Math.abs(amount * price);
    const isCore = item.is_core === true;
    const isVerified = item.is_verified === true || isCore;
    const isSuspicious = item.is_suspicious === true;
    // Unverified / suspicious / valueless tokens never enter the priced lists, so scam-token
    // prices cannot inflate the explanatory totals.
    if (!Number.isFinite(valueUsd) || valueUsd < TOKEN_MIN_VALUE_USD || !isVerified || isSuspicious) {
      unpricedCount += 1;
      unpricedByChain[chain] = (unpricedByChain[chain] || 0) + 1;
      continue;
    }
    tokens.push({
      symbol,
      amount,
      valueUsd: Math.abs(valueUsd),
      tokenId: String(item.id || symbol),
      kind: tokenKind(symbol, isCore),
      isCore,
      logoUrl: typeof item.logo_url === "string" && item.logo_url ? item.logo_url : undefined,
      chain,
    });
  }
  tokens.sort((left, right) => right.valueUsd - left.valueUsd);
  return { tokens, unpricedCount, unpricedByChain, coveredChains: [] };
}

/**
 * Wallet token list (stablecoins / native / spot per chain).
 * Official DeBank Pro endpoint first (one request covers every chain), then the Rabby
 * public endpoint for a bounded number of chains per wallet.
 */
async function fetchTokenListOnce(
  address: string,
  chainIds: string[],
  deadlineMs?: number
): Promise<WalletTokenDetail | null> {
  const key = process.env.DEBANK_ACCESS_KEY;
  if (key) {
    const official = await fetchJson(
      `https://pro-openapi.debank.com/v1/user/all_token_list?id=${address}&is_all=true`,
      { AccessKey: key },
      0,
      deadlineMs
    );
    const parsed = parseTokenList(official.data);
    if (parsed) return { ...parsed, coveredChains: ["*"] };
  }

  // 免费替代方案：Zerion 一个请求拿到全链代币（含价格与图标）
  if (process.env.ZERION_API_KEY) {
    const zerion = await fetchZerionTokens(address, { deadlineMs });
    if (zerion) return zerion;
  }

  if (!chainIds.length) return null;
  const merged: WalletTokenDetail = {
    tokens: [],
    unpricedCount: 0,
    unpricedByChain: {},
    coveredChains: [],
  };
  let anyOk = false;
  for (const chainId of chainIds) {
    if (deadlineMs != null && Date.now() >= deadlineMs - 500) break;
    const response = await fetchJson(
      `https://api.rabby.io/v1/user/token_list?id=${address}&chain_id=${encodeURIComponent(chainId)}&is_all=true`,
      {},
      0,
      deadlineMs
    );
    const parsed = parseTokenList(response.data);
    if (!parsed) continue;
    anyOk = true;
    merged.tokens.push(...parsed.tokens);
    merged.unpricedCount += parsed.unpricedCount;
    for (const [chain, count] of Object.entries(parsed.unpricedByChain)) {
      merged.unpricedByChain[chain] = (merged.unpricedByChain[chain] || 0) + count;
    }
    merged.coveredChains.push(chainId);
  }
  if (!anyOk) return null;
  merged.tokens.sort((left, right) => right.valueUsd - left.valueUsd);
  return merged;
}

async function fetchWalletTokens(
  address: string,
  chainIds: string[],
  store: TokenCache,
  force = false,
  deadlineMs?: number
): Promise<{ detail: WalletTokenDetail | null; status: WalletFetchStatus }> {
  const normalized = address.toLowerCase();
  const hit = store[normalized] || null;
  if (!force && hit && !tokenCacheNeedsRefresh(hit)) return { detail: hit, status: "cached" };
  const attemptedAt = new Date().toISOString();
  store[normalized] = hit
    ? { ...hit, lastAttemptAt: attemptedAt }
    : {
        at: "",
        lastAttemptAt: attemptedAt,
        tokens: [],
        unpricedCount: 0,
        unpricedByChain: {},
        coveredChains: [],
      };
  const detail = await fetchTokenListOnce(normalized, chainIds, deadlineMs);
  if (detail) {
    const merged = mergeTokenCacheObservation(hit, detail, attemptedAt);
    store[normalized] = merged;
    return { detail: merged, status: detail.coveredChains.length ? "ok" : hit ? "cached" : "error" };
  }
  return hit ? { detail: hit, status: "cached" } : { detail: null, status: "error" };
}

type TokenCache = Record<string, WalletTokenCacheEntry>;

/** 需要补代币明细的地址：本地缓存过期，或从来没取过。 */
function tokenCacheStale(address: string, store: TokenCache) {
  return tokenCacheNeedsRefresh(store[address.toLowerCase()]);
}

function protocolCacheStale(address: string, store: ProtocolCache) {
  const hit = store[address.toLowerCase()];
  if (!hit?.at) return true;
  const successAt = new Date(hit.at).getTime();
  return !Number.isFinite(successAt) || Date.now() - successAt >= PROTOCOL_TTL;
}

/** Chains worth a token request: the largest ones that actually hold value. */
function tokenChainsFor(address: string): string[] {
  const detail = cache.get(address.toLowerCase())?.detail;
  if (!detail) return [];
  return detail.chains
    .filter((chain) => chain.valueUsd >= TOKEN_MIN_CHAIN_USD)
    .slice(0, TOKEN_CHAINS_PER_WALLET)
    .map((chain) => chain.id);
}

export async function fetchWalletUsd(
  address: string,
  opts?: { force?: boolean }
): Promise<{ usd: number; status: WalletFetchStatus; attempted: boolean }> {
  const { detail, status, attempted } = await fetchWalletDetail(address, opts?.force);
  return { usd: detail?.totalUsd ?? 0, status, attempted };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function refreshWallets(
  wallets: Wallet[],
  chainStore: ChainCache,
  tokenStore: TokenCache,
  protocolStore: ProtocolCache,
  defiStore: Record<string, ZerionDefiCacheEntry>,
  longtailStore: Record<string, WalletLongtailCacheEntry>,
  opts: {
    budget?: number;
    /** 只刷这些钱包（id 或小写地址），用于单地址手动检查。 */
    only?: string[];
    /** 只刷「成功时间超过 N 分钟」的地址（从未成功的地址永远符合），供调度器补查批次使用。 */
    staleMinutes?: number;
    /** 实时模式：全部钱包 + DeFi 仓位强制读取（无视 TTL），用于打开页面/手动刷新。 */
    live?: boolean;
  } = {}
): Promise<Wallet[]> {
  if (!wallets.length) return [];
  // Kept in the persisted schema for backward compatibility. Canonical totals now
  // come from DeBank/Rabby; these old estimator caches are no longer allowed to
  // replace a successfully observed wallet net worth.
  void defiStore;
  void longtailStore;
  const originalOrder = new Map(wallets.map((wallet, index) => [wallet.id, index]));
  // Public DeBank-compatible requests are serialized, so stay inside the Vercel function budget.
  const stopAt = Date.now() + (opts.live ? 50_000 : 40_000);
  /**
   * 每个小批次按「成功时间最旧优先」选址：超过 20 分钟没更新的地址会排在最前，
   * 每轮滚动批次都优先单独检查它们；从未成功过的地址永远最优先。
   * 只有真实成功才更新 lastSuccess，失败继续保留缓存和原成功时间（于是下批继续优先重试）。
   * 协议明细按 6 小时、代币明细按 12 小时缓存轮换补，避免把免费额度一次用光。
   */
  /** Failed reads retain the last good value; updatedAt advances so one bad address cannot starve the queue. */
  const budget = opts.live
    ? Math.max(1, Math.min(opts.budget ?? wallets.length, wallets.length))
    : Math.max(1, Math.min(opts.budget ?? MAX_PUBLIC_REQUESTS_PER_RUN, MAX_PUBLIC_REQUESTS_PER_RUN));
  const nowMs = Date.now();
  const successTs = (wallet: Wallet) => {
    const raw = wallet.lastSuccess?.at;
    if (!raw) return 0; // 从未成功 → 最高优先级
    const ts = new Date(raw).getTime();
    return Number.isFinite(ts) ? ts : 0;
  };
  const attemptTs = (wallet: Wallet) => {
    const raw = wallet.updatedAt ?? wallet.lastUpdated;
    if (!raw) return 0;
    const ts = new Date(raw).getTime();
    return Number.isFinite(ts) ? ts : 0;
  };
  let pool = wallets;
  if (opts.only?.length) {
    const wanted = new Set(opts.only.map((value) => value.toLowerCase()));
    // Manual single-wallet check may still target a paused address on demand.
    pool = wallets.filter(
      (wallet) => wanted.has(wallet.id.toLowerCase()) || wanted.has(wallet.address.toLowerCase())
    );
  } else {
    pool = wallets.filter(isWalletRefreshEnabled);
    if (opts.staleMinutes && opts.staleMinutes > 0) {
      const minAgeMs = opts.staleMinutes * 60_000;
      pool = pool.filter((wallet) => nowMs - successTs(wallet) >= minAgeMs);
    } else if (!opts.live) {
      // Skip recently successful addresses so Rabby quota goes to stale wallets.
      pool = pool.filter((wallet) => nowMs - successTs(wallet) >= FRESH_SKIP_MS);
    }
  }
  const targets = [...pool]
    .sort(
      (left, right) =>
        successTs(left) - successTs(right) ||
        attemptTs(left) - attemptTs(right) ||
        right.balanceUsd - left.balanceUsd
    )
    .slice(0, budget);
  const targetIds = new Set(targets.map((wallet) => wallet.id));
  /**
   * 本轮要补代币明细的地址：优先“从来没取过”的地址（例如余额抓取失败的钱包，
   * 里面的 PONS / stonks 只能靠代币明细补出来），其次按余额从大到小。
   */
  const tokenTargets = new Set(
    [...targets]
      .filter((wallet) => tokenCacheStale(wallet.address, tokenStore))
      .sort((left, right) => {
        const leftCached = tokenStore[left.address.toLowerCase()] ? 1 : 0;
        const rightCached = tokenStore[right.address.toLowerCase()] ? 1 : 0;
        if (leftCached !== rightCached) return leftCached - rightCached;
        return right.balanceUsd - left.balanceUsd;
      })
      .slice(0, TOKEN_WALLET_BUDGET)
      .map((wallet) => wallet.address.toLowerCase())
  );
  const protocolTargets = new Set(
    [...targets]
      .filter((wallet) => protocolCacheStale(wallet.address, protocolStore))
      .sort((left, right) => {
        const leftAt = protocolStore[left.address.toLowerCase()]?.at || "";
        const rightAt = protocolStore[right.address.toLowerCase()]?.at || "";
        return new Date(leftAt || 0).getTime() - new Date(rightAt || 0).getTime();
      })
      .slice(0, PROTOCOL_WALLET_BUDGET)
      .map((wallet) => wallet.address.toLowerCase())
  );
  const refreshed = await mapPool(targets, CONCURRENCY, async (wallet) => {
    const attemptedAt = new Date().toISOString();
    const previous = wallet.balanceUsd;
    const addressLower = wallet.address.toLowerCase();
    const hasDetailTime = () => opts.live || Date.now() < stopAt - 10_000;
    const wantsTokenDetail = tokenTargets.has(addressLower);
    const previousAppChains = (chainStore[addressLower]?.chains ?? []).filter((chain) =>
      chain.id.startsWith("app:")
    );
    // Pinned sole total source: Rabby/public. OKX/Zerion calibration used to
    // rewrite balanceUsd (source=direct/zerion) and drop Base NVDAc (~$1k) on
    // several wallets — that is the ±$1000 fake flow. Never publish those totals.
    const { detail, apps, status, attempted } = await fetchWalletDetail(
      wallet.address,
      true,
      previousAppChains
    );

    if (status === "ok" && detail) {
      chainStore[addressLower] = {
        at: attemptedAt,
        totalUsd: detail.totalUsd,
        chains: detail.chains.map((chain) => ({ ...chain })),
      };
      if (apps !== null) {
        const protocolEntry = protocolStore[addressLower] ?? { at: "", protocols: [] };
        protocolStore[addressLower] = {
          ...protocolEntry,
          apps,
          appAt: attemptedAt,
          appLastAttemptAt: attemptedAt,
        };
      }
      if (protocolTargets.has(addressLower) && hasDetailTime()) {
        await fetchComplexProtocols(wallet.address, protocolStore);
      }
      // Recover Base NVDAc (and similar) into the token table when the chain
      // total is large but no matching priced row exists yet.
      const topChainMissingTokens = (() => {
        const chains = chainStore[addressLower]?.chains ?? [];
        const top = chains.find((chain) => !chain.id.startsWith("app:") && chain.valueUsd >= 100);
        if (!top) return false;
        const tokens = tokenStore[addressLower]?.tokens ?? [];
        return !tokens.some((token) => token.chain === top.id && (Number(token.valueUsd) || 0) >= 50);
      })();
      if ((wantsTokenDetail || topChainMissingTokens) && hasDetailTime()) {
        const chainIds = tokenChainsFor(wallet.address);
        // Always include the largest chain so NVDAc on Base is not skipped.
        const topId = (chainStore[addressLower]?.chains ?? []).find(
          (chain) => !chain.id.startsWith("app:") && chain.valueUsd >= 100
        )?.id;
        const ids = topId && !chainIds.includes(topId) ? [topId, ...chainIds].slice(0, TOKEN_CHAINS_PER_WALLET) : chainIds;
        await fetchWalletTokens(wallet.address, ids, tokenStore, true, stopAt);
      }
      const balanceUsd = Math.round(detail.totalUsd * 100) / 100;
      // A successful App audit may legitimately contain no positions. Its
      // timestamp, rather than a non-empty app chain list, proves completeness
      // when the public App endpoint is temporarily unavailable.
      const appAuditAtMs = Date.parse(protocolStore[addressLower]?.appAt ?? "");
      const observedAtMs = Date.parse(attemptedAt);
      const hasCompleteAppAudit =
        Number.isFinite(appAuditAtMs) &&
        appAuditAtMs <= observedAtMs + 60_000 &&
        observedAtMs - appAuditAtMs <= 6 * 60 * 60 * 1000;
      const source = hasCompleteAppAudit ? ("public" as const) : ("public-partial" as const);
      const cachedTokens = tokenStore[addressLower]?.tokens;
      const previousTokens = cachedTokens ? comparedTokensFromLines(cachedTokens) : null;
      // Rabby itself can price phishing/scam tokens into total_usd_value (dust wallet
      // 0.44 → 23718). Reject spikes and risk-inflated flaps for EVERY wallet.
      if (
        await shouldRejectIncomingWalletTotal({
          address: wallet.address,
          previousUsd: previous,
          nextUsd: balanceUsd,
          nextSource: source,
          confirmedEmpty: detail.explicitEmpty === true,
          previousTokens,
          deadlineMs: stopAt,
        })
      ) {
        // Keep last-good NAV after a successful Rabby contact, but always bump
        // lastSuccess so freshness clocks do not stall on intentional rejects.
        return {
          ...wallet,
          balanceUsd: previous,
          lastUpdated: attemptedAt,
          updatedAt: attemptedAt,
          lastSuccess: { at: attemptedAt, balanceUsd: previous },
          status: "ok" as const,
          source: wallet.source === "public" || wallet.source === "public-partial"
            ? wallet.source
            : source,
        };
      }
      return {
        ...wallet,
        balanceUsd,
        lastUpdated: attemptedAt,
        updatedAt: attemptedAt,
        lastSuccess: { at: attemptedAt, balanceUsd },
        status: "ok" as const,
        source,
      };
    }

    // Rabby/public failed or blocked: keep last-good. Do NOT fall through to
    // OKX/Zerion totals (coverage hole on tokenized stocks / Base NVDAc).
    // Keep last confirmed balance; never zero on provider failure.
    if (!attempted && !publicBlocked()) return wallet;
    if (wantsTokenDetail && hasDetailTime()) {
      await fetchWalletTokens(
        wallet.address,
        tokenChainsFor(wallet.address),
        tokenStore,
        true,
        stopAt
      );
    }
    return {
      ...wallet,
      balanceUsd: previous,
      updatedAt: attemptedAt,
      status: previous > 0 ? ("cached" as const) : ("error" as const),
    };
  });
  // 没被选中的地址原样返回（保留上次成功的余额与状态）
  const untouched = wallets.filter((wallet) => !targetIds.has(wallet.id));
  return [...refreshed, ...untouched].sort(
    (left, right) => (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0)
  );
}

function canonicalDappName(value: string) {
  const name = value.trim() || "Unknown DApp";
  if (/^aave\b/i.test(name)) return "Aave";
  if (/^pendle\b/i.test(name)) return "Pendle";
  return name.replace(/\s+(v|version)\s*\d+(?:\.\d+)?$/i, "").trim();
}

function chainName(id: string, fallback = "") {
  const names: Record<string, string> = {
    eth: "Ethereum", arb: "Arbitrum", op: "Optimism", base: "Base", bsc: "BNB Chain",
    linea: "Linea", abs: "Abstract", xlayer: "X Layer", matic: "Polygon", avax: "Avalanche",
    bera: "Berachain", scrl: "Scroll", hood: "Robinhood Chain", plasma: "Plasma", monad: "Monad",
  };
  return names[id] || fallback || id || "Unknown";
}

function tokensFromItem(item: Record<string, unknown>): DappTokenPosition[] {
  const detail = item.detail && typeof item.detail === "object" ? (item.detail as Record<string, unknown>) : {};
  const output: DappTokenPosition[] = [];
  const append = (raw: unknown, role: DappTokenPosition["role"]) => {
    if (!Array.isArray(raw)) return;
    for (const token of raw) {
      if (!token || typeof token !== "object") continue;
      const value = token as Record<string, unknown>;
      const amount = number(value.amount);
      const valueUsd = number(value.usd_value) || amount * number(value.price);
      if (Math.abs(valueUsd) < 0.01) continue;
      output.push({
        symbol: String(value.optimized_symbol || value.display_symbol || value.symbol || "TOKEN"),
        amount,
        valueUsd: Math.abs(valueUsd),
        role,
      });
    }
  };
  const supply = detail.supply_token_list;
  append(Array.isArray(supply) && supply.length ? supply : detail.token_list, "asset");
  append(detail.reward_token_list, "reward");
  const borrow = detail.borrow_token_list;
  append(Array.isArray(borrow) && borrow.length ? borrow : detail.debt_token_list, "debt");
  return output;
}

function mergeTokens(target: DappTokenPosition[], additions: DappTokenPosition[]) {
  for (const token of additions) {
    const current = target.find((item) => item.symbol === token.symbol && item.role === token.role);
    if (current) {
      current.amount += token.amount;
      current.valueUsd += token.valueUsd;
    } else {
      target.push({ ...token });
    }
  }
}

type WalletAccumulator = DappWalletShare;
type ChainAccumulator = Omit<DappChainAllocation, "wallets"> & { wallets: Map<string, WalletAccumulator> };
type DappAccumulator = Omit<DappAllocation, "chains" | "wallets"> & {
  chains: Map<string, ChainAccumulator>;
  wallets: Map<string, WalletAccumulator>;
};

function addWalletShare(
  map: Map<string, WalletAccumulator>,
  wallet: Wallet,
  assetUsd: number,
  debtUsd: number,
  netUsd: number,
  tokens: DappTokenPosition[]
) {
  const current = map.get(wallet.id) || {
    walletId: wallet.id,
    walletName: wallet.name,
    address: wallet.address,
    assetUsd: 0,
    debtUsd: 0,
    netUsd: 0,
    tokens: [],
  };
  current.assetUsd += assetUsd;
  current.debtUsd += debtUsd;
  current.netUsd += netUsd;
  mergeTokens(current.tokens, tokens);
  map.set(wallet.id, current);
}

const rounded = (value: number) => Math.round(value * 100) / 100;

export async function refreshOnchainBreakdown(
  wallets: Wallet[],
  chainStore: ChainCache,
  tokenStore: TokenCache,
  protocolStore: ProtocolCache,
  defiStore: Record<string, ZerionDefiCacheEntry>
): Promise<OnchainBreakdown> {
  const chainMap = new Map<string, {
    id: string;
    name: string;
    logoUrl?: string;
    valueUsd: number;
    wallets: Map<string, { walletId: string; walletName: string; address: string; valueUsd: number }>;
    tokens: Map<string, TokenLine>;
    unpricedCount: number;
    tokenCovered: boolean;
  }>();
  const dappMap = new Map<string, DappAccumulator>();
  const dappByChain = new Map<string, number>();
  const chainUnpriced = new Map<string, number>();
  const tokenMap = new Map<
    string,
    Omit<TokenHolding, "wallets" | "walletCount" | "amount" | "valueUsd" | "price"> & {
      amount: number;
      valueUsd: number;
      wallets: Map<string, { walletId: string; walletName: string; address: string; amount: number; valueUsd: number }>;
    }
  >();
  let successfulWallets = 0;
  let cachedWallets = 0;
  const dappSource = new Map<string, "zerion" | "audit">();

  // Paused Abstract wallets stay listed but must not inflate chain/token/dapp stats.
  const activeWallets = wallets.filter(isWalletRefreshEnabled);
  await mapPool(activeWallets, CONCURRENCY, async (wallet) => {
    // refreshWallets runs immediately before this and fills the cache. Avoid a second
    // network storm for addresses whose total request just failed.
    const normalizedAddress = wallet.address.toLowerCase();
    const persistedDetail = chainStore[normalizedAddress] ?? null;
    const detail = persistedDetail ?? cache.get(normalizedAddress)?.detail ?? null;
    // DeBank/Rabby protocol rows explain the canonical wallet total; App rows explain
    // assets such as Polymarket that live outside the normal chain-total endpoint.
    const protocolEntry = protocolStore[wallet.address.toLowerCase()] ?? null;
    const protocols = protocolEntry
      ? [...(protocolEntry.protocols ?? []), ...(protocolEntry.apps ?? [])]
      : null;
    const tokenDetail = tokenStore[wallet.address.toLowerCase()] ?? null;
    if (
      wallet.status === "cached" ||
      wallet.status === "error" ||
      wallet.status === "stale" ||
      wallet.source === "public-partial"
    ) {
      cachedWallets += 1;
    }
    if (detail) {
      successfulWallets += 1;
      for (const chain of detail.chains) {
        const current = chainMap.get(chain.id) || {
          id: chain.id,
          name: chainName(chain.id, chain.name),
          logoUrl: chain.logoUrl,
          valueUsd: 0,
          wallets: new Map(),
          tokens: new Map(),
          unpricedCount: 0,
          tokenCovered: false,
        };
        if (!current.logoUrl && chain.logoUrl) current.logoUrl = chain.logoUrl;
        current.valueUsd += chain.valueUsd;
        const share = current.wallets.get(wallet.id) || {
          walletId: wallet.id,
          walletName: wallet.name,
          address: wallet.address,
          valueUsd: 0,
        };
        share.valueUsd += chain.valueUsd;
        current.wallets.set(wallet.id, share);
        chainMap.set(chain.id, current);
      }
    }
    // DeFi receipt tokens (e.g. sUSDai / poolCa) must not also appear as wallet spot when
    // the same capital is already explained by a BN (or known USDai) protocol row.
    const defiReceiptKeys = collectBnDefiTokenKeys(protocols ?? []);
    for (const protocol of protocols ?? []) {
      const pid = String(protocol.id || "");
      if (pid === "arb_usdai" || pid.endsWith("_usdai")) {
        defiReceiptKeys.add("arb:0x0b2b2b2076d95dda7817e785989fe353fe955ef9");
      }
    }
    if (tokenDetail) {
      for (const token of tokenDetail.tokens) {
        if (isJunkTokenSymbol(token.symbol) || isDustTokenValue(token.valueUsd)) continue;
        const chainId = token.chain;
        const identity = tokenIdentity(token).toLowerCase();
        if (identity.startsWith("0x") && defiReceiptKeys.has(`${chainId}:${identity}`)) continue;
        const current = chainMap.get(chainId) || {
          id: chainId,
          name: chainName(chainId),
          logoUrl: undefined as string | undefined,
          valueUsd: 0,
          wallets: new Map(),
          tokens: new Map(),
          unpricedCount: 0,
          tokenCovered: false,
        };
        current.tokenCovered =
          current.tokenCovered || tokenDetail.coveredChains.includes("*") || tokenDetail.coveredChains.includes(chainId);
        const key = `${token.kind}:${tokenIdentity(token)}`;
        const existing = current.tokens.get(key);
        if (existing) {
          existing.amount += token.amount;
          existing.valueUsd += token.valueUsd;
        } else {
          const { chain: _chain, ...line } = token;
          void _chain;
          current.tokens.set(key, { ...line });
        }
        chainMap.set(chainId, current);

        // 跨钱包的代币聚合：同一个代币在不同钱包分别持有多少，是"多钱包综合体"的核心。
        const tokenKey = `${chainId}:${tokenIdentity(token)}`;
        const holding =
          tokenMap.get(tokenKey) ||
          {
            id: tokenKey,
            symbol: token.symbol,
            chain: chainId,
            chainName: chainName(chainId),
            amount: 0,
            valueUsd: 0,
            kind: token.kind,
            logoUrl: token.logoUrl,
            priceSource: token.priceSource,
            wallets: new Map<string, { walletId: string; walletName: string; address: string; amount: number; valueUsd: number }>(),
          };
        holding.amount += token.amount;
        holding.valueUsd += token.valueUsd;
        if (token.priceSource) holding.priceSource = token.priceSource;
        if (!holding.logoUrl && token.logoUrl) holding.logoUrl = token.logoUrl;
        const walletShare = holding.wallets.get(wallet.id) || {
          walletId: wallet.id,
          walletName: wallet.name,
          address: wallet.address,
          amount: 0,
          valueUsd: 0,
        };
        walletShare.amount += token.amount;
        walletShare.valueUsd += token.valueUsd;
        holding.wallets.set(wallet.id, walletShare);
        tokenMap.set(tokenKey, holding);
      }
      for (const [chainId, count] of Object.entries(tokenDetail.unpricedByChain)) {
        chainUnpriced.set(chainId, (chainUnpriced.get(chainId) || 0) + count);
      }
      if (tokenDetail.coveredChains.includes("*")) {
        for (const entry of chainMap.values()) entry.tokenCovered = true;
      }
    }
    for (const protocol of protocols ?? []) {
      const items = Array.isArray(protocol.portfolio_item_list)
        ? protocol.portfolio_item_list.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        : [];
      if (!items.length) continue;
      const name = canonicalDappName(String(protocol.name || protocol.id || "Unknown DApp"));
      const key = name.toLowerCase();
      const protocolChain = String(protocol.chain || "unknown");
      const protocolChainName = String(protocol.chain_name || chainName(protocolChain));
      const current = dappMap.get(key) || {
        id: String(protocol.id || key),
        name,
        siteUrl: String(protocol.site_url || ""),
        logoUrl: typeof protocol.logo_url === "string" && protocol.logo_url ? protocol.logo_url : undefined,
        assetUsd: 0,
        debtUsd: 0,
        netUsd: 0,
        chains: new Map(),
        wallets: new Map(),
      };
      if (!current.logoUrl && typeof protocol.logo_url === "string" && protocol.logo_url) {
        current.logoUrl = protocol.logo_url;
      }
      const chain = current.chains.get(protocolChain) || {
        id: protocolChain,
        name: protocolChainName,
        assetUsd: 0,
        debtUsd: 0,
        netUsd: 0,
        wallets: new Map(),
      };

      let assetUsd = 0;
      let debtUsd = 0;
      let netUsd = 0;
      const tokens: DappTokenPosition[] = [];
      for (const item of items) {
        const stats = item.stats && typeof item.stats === "object" ? (item.stats as Record<string, unknown>) : {};
        const itemAsset = number(stats.asset_usd_value);
        const itemDebt = Math.abs(number(stats.debt_usd_value));
        assetUsd += itemAsset;
        debtUsd += itemDebt;
        netUsd += stats.net_usd_value == null ? itemAsset - itemDebt : number(stats.net_usd_value);
        mergeTokens(tokens, tokensFromItem(item));
      }
      if (Math.abs(netUsd) < 0.01 && assetUsd < 0.01 && debtUsd < 0.01) continue;

      current.assetUsd += assetUsd;
      current.debtUsd += debtUsd;
      current.netUsd += netUsd;
      chain.assetUsd += assetUsd;
      chain.debtUsd += debtUsd;
      chain.netUsd += netUsd;
      addWalletShare(current.wallets, wallet, assetUsd, debtUsd, netUsd, tokens);
      addWalletShare(chain.wallets, wallet, assetUsd, debtUsd, netUsd, tokens);
      current.chains.set(protocolChain, chain);
      dappMap.set(key, current);
      dappSource.set(key, "audit");
      dappByChain.set(protocolChain, (dappByChain.get(protocolChain) || 0) + netUsd);
    }

    // Zerion 实时 DeFi 仓位并入 DApp 展示（deposit/staked/reward；借贷不计入）
    const zerionPositions = protocols === null
      ? (defiStore[wallet.address.toLowerCase()]?.positions ?? [])
      : [];
    for (const position of zerionPositions) {
      if (position.valueUsd <= 0.005) continue;
      const name = canonicalDappName(position.name);
      const key = name.toLowerCase();
      const current = dappMap.get(key) || {
        id: key,
        name,
        siteUrl: "",
        logoUrl: undefined,
        assetUsd: 0,
        debtUsd: 0,
        netUsd: 0,
        chains: new Map(),
        wallets: new Map(),
      };
      const chain = current.chains.get(position.chain) || {
        id: position.chain,
        name: chainName(position.chain),
        assetUsd: 0,
        debtUsd: 0,
        netUsd: 0,
        wallets: new Map(),
      };
      current.assetUsd += position.valueUsd;
      current.netUsd += position.valueUsd;
      chain.assetUsd += position.valueUsd;
      chain.netUsd += position.valueUsd;
      addWalletShare(current.wallets, wallet, position.valueUsd, 0, position.valueUsd, []);
      addWalletShare(chain.wallets, wallet, position.valueUsd, 0, position.valueUsd, []);
      current.chains.set(position.chain, chain);
      dappMap.set(key, current);
      dappSource.set(key, "zerion");
      dappByChain.set(position.chain, (dappByChain.get(position.chain) || 0) + position.valueUsd);
    }
  });

  const chains: ChainAllocation[] = [...chainMap.values()]
    .map((chain) => {
      const dappUsd = dappByChain.get(chain.id) || 0;
      const walletsForChain = [...chain.wallets.values()]
        .map((wallet) => ({ ...wallet, valueUsd: rounded(wallet.valueUsd) }))
        .sort((left, right) => right.valueUsd - left.valueUsd);
      const allTokens = [...chain.tokens.values()].sort((left, right) => right.valueUsd - left.valueUsd);
      const stablecoins = allTokens
        .filter((token) => token.kind === "stable")
        .slice(0, TOKENS_PER_GROUP)
        .map((token) => ({ ...token, valueUsd: rounded(token.valueUsd) }));
      const spot = allTokens
        .filter((token) => token.kind !== "stable")
        .slice(0, TOKENS_PER_GROUP)
        .map((token) => ({ ...token, valueUsd: rounded(token.valueUsd) }));
      const stableUsd = rounded(
        allTokens.filter((token) => token.kind === "stable").reduce((sum, token) => sum + token.valueUsd, 0)
      );
      const nativeUsd = rounded(
        allTokens.filter((token) => token.kind === "native").reduce((sum, token) => sum + token.valueUsd, 0)
      );
      const spotUsd = rounded(
        allTokens.filter((token) => token.kind !== "stable").reduce((sum, token) => sum + token.valueUsd, 0)
      );
      return {
        id: chain.id,
        name: chain.name,
        logoUrl: chain.logoUrl,
        valueUsd: rounded(chain.valueUsd),
        // 链总额 = 代币+原生币+实时 DeFi（链分布缓存已并入）；walletUsd 为扣除 DeFi 后的钱包内净值
        walletUsd: rounded(chain.valueUsd - dappUsd),
        dappUsd: rounded(dappUsd),
        walletCount: walletsForChain.length,
        wallets: walletsForChain,
        stablecoins,
        spot,
        stableUsd,
        spotUsd,
        nativeUsd,
        unpricedCount: chainUnpriced.get(chain.id) || chain.unpricedCount || 0,
        tokenDetailAvailable: chain.tokenCovered,
      };
    })
    .sort((left, right) => right.valueUsd - left.valueUsd);

  const finalizeWallet = (wallet: WalletAccumulator): DappWalletShare => ({
    ...wallet,
    assetUsd: rounded(wallet.assetUsd),
    debtUsd: rounded(wallet.debtUsd),
    netUsd: rounded(wallet.netUsd),
    tokens: wallet.tokens
      .map((token) => ({ ...token, valueUsd: rounded(token.valueUsd) }))
      .sort((left, right) => right.valueUsd - left.valueUsd)
      .slice(0, 12),
  });

  const dapps: DappAllocation[] = [...dappMap.values()]
    .map((dapp) => ({
      id: dapp.id,
      name: dapp.name,
      siteUrl: dapp.siteUrl,
      logoUrl: dapp.logoUrl,
      assetUsd: rounded(dapp.assetUsd),
      debtUsd: rounded(dapp.debtUsd),
      netUsd: rounded(dapp.netUsd),
      wallets: [...dapp.wallets.values()].map(finalizeWallet).sort((left, right) => right.netUsd - left.netUsd),
      chains: [...dapp.chains.values()]
        .map((chain): DappChainAllocation => ({
          id: chain.id,
          name: chain.name,
          assetUsd: rounded(chain.assetUsd),
          debtUsd: rounded(chain.debtUsd),
          netUsd: rounded(chain.netUsd),
          wallets: [...chain.wallets.values()].map(finalizeWallet).sort((left, right) => right.netUsd - left.netUsd),
        }))
        .sort((left, right) => right.netUsd - left.netUsd),
      source: dappSource.get(dapp.name.toLowerCase()) ?? "audit",
    }))
    .sort((left, right) => right.netUsd - left.netUsd);

  const tokens: TokenHolding[] = [...tokenMap.values()]
    .map((holding) => ({
      id: holding.id,
      symbol: holding.symbol,
      chain: holding.chain,
      chainName: holding.chainName,
      amount: holding.amount,
      price: holding.amount > 0 ? holding.valueUsd / holding.amount : 0,
      priceSource: holding.priceSource,
      valueUsd: rounded(holding.valueUsd),
      kind: holding.kind,
      logoUrl: holding.logoUrl,
      walletCount: holding.wallets.size,
      wallets: [...holding.wallets.values()]
        .map((share) => ({
          ...share,
          amount: share.amount,
          valueUsd: rounded(share.valueUsd),
        }))
        .sort((left, right) => right.valueUsd - left.valueUsd),
    }))
    .filter(hasNonzeroHolding)
    .sort((left, right) => right.valueUsd - left.valueUsd);

  return {
    generatedAt: new Date().toISOString(),
    walletCount: activeWallets.length,
    successfulWallets,
    chains,
    dapps,
    tokens,
    tokensTotalUsd: rounded(tokens.reduce((sum, token) => sum + token.valueUsd, 0)),
    tokenSource: Object.values(tokenStore).some(entry => entry.tokens.some(t=>t.quantitySource==='rpc')) ? "rpc" : Object.values(tokenStore).some(entry => entry.source === "rabby-public") ? "rabby-public" : activeTokenSource(),
    cachedWallets,
    partial: cachedWallets > 0,
    rateLimitedUntil: publicBlocked() ? new Date(getPublicBlockedUntil()).toISOString() : null,
  };
}
