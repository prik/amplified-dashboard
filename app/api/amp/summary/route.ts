import { NextRequest } from 'next/server'
import { buildSummary, lamToSol } from '@/lib/amp/queries'
import { getSolPriceUsd } from '@/lib/amp/price'
import { getBalance } from '@/lib/amp/rpc'
import { FEE_WALLET } from '@/lib/amp/config'
import { ttlCache } from '@/lib/amp/cache'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? '7d'
  // Run the two upstream calls in parallel — both are cached, but on cache
  // miss this halves the cold-path latency (one CoinGecko + one Solana RPC
  // round-trip rather than back-to-back).
  const [price, lam] = await Promise.all([
    getSolPriceUsd(),
    ttlCache('treasury_lamports', 10_000, () => getBalance(FEE_WALLET)).catch(() => null),
  ])
  const treasurySol = lam == null ? null : lamToSol(lam)
  return Response.json(buildSummary(range, price, treasurySol))
}
