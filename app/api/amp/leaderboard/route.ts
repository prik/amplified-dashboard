import { NextRequest } from 'next/server'
import { buildLeaderboard } from '@/lib/amp/queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const limit = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10) || 50
  return Response.json(buildLeaderboard(limit))
}
