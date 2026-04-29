import { getTokenMeta, getTokenMetaBatch, upsertTokenMeta, type TokenMeta } from './db'
import { getTokenSupplyRaw } from './rpc'

// Pump.fun's free public API. No auth required, no documented rate limit.
// We cache aggressively in `amp_token_meta` so we hit it at most once per mint.
const PUMP_FUN_API = 'https://frontend-api-v3.pump.fun/coins'

const inflight = new Map<string, Promise<TokenMeta | null>>()

async function fetchOnePumpFun(mint: string): Promise<{ symbol: string | null; name: string | null }> {
  try {
    const res = await fetch(`${PUMP_FUN_API}/${mint}`, { cache: 'no-store' })
    if (!res.ok) return { symbol: null, name: null }
    const j = await res.json()
    if (!j || (typeof j === 'object' && Object.keys(j).length === 0)) {
      return { symbol: null, name: null }
    }
    return {
      symbol: typeof j.symbol === 'string' ? j.symbol : null,
      name: typeof j.name === 'string' ? j.name : null,
    }
  } catch {
    return { symbol: null, name: null }
  }
}

async function fetchFreshMeta(mint: string): Promise<TokenMeta | null> {
  // Run pump.fun lookup and on-chain supply lookup in parallel — both are
  // independent, both write into the same token_meta row.
  const [pump, supply] = await Promise.all([
    fetchOnePumpFun(mint),
    getTokenSupplyRaw(mint),
  ])
  if (!pump.symbol && !pump.name && !supply) return null
  // Convert BigInt supply to Number for storage. SPL token supply on common
  // tokens (1B × 10^6 = 10^15) is within Number.MAX_SAFE_INTEGER. For larger
  // mints this would lose precision; we accept that — display-side mcap math
  // doesn't need byte-exact precision.
  const supplyNum = supply ? Number(supply.raw) : null
  return {
    mint,
    symbol: pump.symbol,
    name: pump.name,
    decimals: supply?.decimals ?? null,
    total_supply_raw: supplyNum,
    fetched_at: Math.floor(Date.now() / 1000),
  }
}

// Resolve and cache a token's full meta (symbol/name + decimals + supply).
// Returns null if all sources fail. If only some fields are known the cache
// still updates (upsert COALESCEs), so the next call can fill missing pieces.
export async function resolveTokenMeta(mint: string): Promise<TokenMeta | null> {
  const cached = getTokenMeta(mint)
  // Re-resolve if we're missing supply data (mcap calc needs it). Symbol-only
  // hits from a previous version of the cache will get topped up here.
  const needsSupplyFill = !!cached && (cached.total_supply_raw == null || cached.decimals == null)
  if (cached && !needsSupplyFill) return cached

  let p = inflight.get(mint)
  if (!p) {
    p = (async () => {
      const fresh = await fetchFreshMeta(mint)
      if (fresh) {
        try { upsertTokenMeta(fresh) } catch {}
        return getTokenMeta(mint)  // re-read so we get the merged row
      }
      return null
    })()
    inflight.set(mint, p)
    p.finally(() => inflight.delete(mint))
  }
  return p
}

// Batch resolve. Hits the cache once for all mints, fetches whatever's missing
// in parallel (capped to avoid stampedes). Returns a Map keyed by mint.
export async function resolveTokenMetaBatch(mints: string[]): Promise<Map<string, TokenMeta>> {
  const uniq = Array.from(new Set(mints.filter(Boolean)))
  if (uniq.length === 0) return new Map()
  const cached = getTokenMetaBatch(uniq)
  const missing = uniq.filter((m) => !cached.has(m))
  if (missing.length === 0) return cached

  const CHUNK = 6
  for (let i = 0; i < missing.length; i += CHUNK) {
    const batch = missing.slice(i, i + CHUNK)
    const results = await Promise.all(batch.map((m) => resolveTokenMeta(m)))
    for (let j = 0; j < batch.length; j++) {
      const r = results[j]
      if (r) cached.set(batch[j], r)
    }
  }
  return cached
}
