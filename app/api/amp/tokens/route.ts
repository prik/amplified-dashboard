import { NextRequest } from 'next/server'
import { resolveTokenMetaBatch } from '@/lib/amp/tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/amp/tokens
// body: { mints: string[] }
// → { meta: Record<mint, { symbol: string|null; name: string|null }> }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { mints?: unknown } | null
  const mintsRaw = Array.isArray(body?.mints) ? body!.mints : []
  const mints = mintsRaw.filter((m): m is string => typeof m === 'string').slice(0, 50)
  const map = await resolveTokenMetaBatch(mints)
  const meta: Record<string, { symbol: string | null; name: string | null }> = {}
  for (const [mint, m] of map) meta[mint] = { symbol: m.symbol, name: m.name }
  return Response.json({ meta })
}
