import type { ManualAsset, Wallet } from "./types";

/**
 * Initial baseline values used only before the first successful refresh.
 * All zeros in the public version; real values come from live refreshes.
 */
export const BASELINE = {
  totalUsd: 0,
  onchainUsd: 0,
  cexUsd: 0,
  manualUsd: 0,
  okx: 0,
  binance: 0,
  gate: 0,
  bitget: 0,
  evmUsd: 0,
  abstractUsd: 0,
} as const;

/** Manual assets are added in the UI (/dashboard/manual); nothing is seeded. */
export const SEED_MANUAL: ManualAsset[] = [];

type SeedEntry = { name: string; address: string; chain?: "EVM" | "ABSTRACT" };

/**
 * Optional initial wallet list, read from the SEED_WALLETS env var (JSON array), e.g.
 *   SEED_WALLETS='[{"name":"Main","address":"0x0000000000000000000000000000000000000000","chain":"EVM"}]'
 * Wallets can also be added later in the UI (/dashboard/addresses). Defaults to empty.
 */
function readSeedEntries(): SeedEntry[] {
  const raw = process.env.SEED_WALLETS || "";
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is SeedEntry => !!e && typeof e.name === "string" && typeof e.address === "string"
    );
  } catch {
    return [];
  }
}

export function seedWallets(): Wallet[] {
  const now = new Date().toISOString();
  return readSeedEntries().map((entry, i) => ({
    id: `s${i + 1}`,
    name: entry.name,
    address: entry.address,
    chain: entry.chain === "ABSTRACT" ? ("ABSTRACT" as const) : ("EVM" as const),
    balanceUsd: 0,
    lastUpdated: now,
    status: "baseline" as const,
  }));
}

/**
 * Wallets merged into an existing store on load (deduped by lowercase address,
 * never overwrites existing entries). Empty in the public version.
 */
export const MIGRATION_WALLETS: Array<{ name: string; address: string; chain: "EVM" | "ABSTRACT" }> = [];
