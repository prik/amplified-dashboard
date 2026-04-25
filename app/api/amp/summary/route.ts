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
  const price = await getSolPriceUsd()
  let treasurySol: number | null = null
  try {
    // Cache treasury balance for 10s across all concurrent visitors so we
    // don't fire one getBalance per page load.
    const lam = await ttlCache('treasury_lamports', 10_000, () => getBalance(FEE_WALLET))
    treasurySol = lamToSol(lam)
  } catch {}
  return Response.json(buildSummary(range, price, treasurySol))
}
