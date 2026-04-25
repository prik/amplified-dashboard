import { NextRequest } from 'next/server'
import { buildNewUsers } from '@/lib/amp/queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? '30d'
  return Response.json(buildNewUsers(range))
}
