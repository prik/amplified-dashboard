import { NextRequest } from 'next/server'
import { buildTimeseries } from '@/lib/amp/queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? '7d'
  return Response.json(buildTimeseries(range))
}
