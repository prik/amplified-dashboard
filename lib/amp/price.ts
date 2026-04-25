let cached: { price: number | null; ts: number } = { price: null, ts: 0 }
const TTL_MS = 60_000

export async function getSolPriceUsd(): Promise<number | null> {
  const now = Date.now()
  if (cached.price != null && now - cached.ts < TTL_MS) return cached.price

  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`coingecko http ${res.status}`)
    const data = (await res.json()) as { solana?: { usd?: number } }
    const price = data?.solana?.usd
    if (typeof price === 'number' && price > 0) {
      cached = { price, ts: now }
      return price
    }
    throw new Error('coingecko: no price')
  } catch (e) {
    if (cached.price != null) return cached.price
    console.error('[amp] SOL price fetch failed:', e instanceof Error ? e.message : e)
    return null
  }
}
