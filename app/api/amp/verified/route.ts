import { buildVerified } from '@/lib/amp/queries'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json(buildVerified())
}
