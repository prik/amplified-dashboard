import { NextRequest } from 'next/server'
import { buildTradeFrequency } from '@/lib/amp/queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? 'all'
  return Response.json(buildTradeFrequency(range))
}
