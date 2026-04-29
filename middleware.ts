import { NextRequest, NextResponse } from 'next/server'

// Per-IP token-bucket limiter for /api/* routes.
//
// Trust model: the host firewall is locked to Cloudflare IPs, so the only
// honest source of client IP is the CF-Connecting-IP header set by Cloudflare.
// Anything else can be spoofed by a client and must not be trusted.
const RATE_PER_MIN = 90
const BURST = 30
const REFILL_PER_SEC = RATE_PER_MIN / 60
const MAX_TOKENS = RATE_PER_MIN + BURST

type Bucket = { tokens: number; last: number }
const buckets = new Map<string, Bucket>()

let pruneCounter = 0
function maybePrune(now: number) {
  if ((++pruneCounter & 0x3ff) !== 0) return
  const cutoff = now - 600
  for (const [k, v] of buckets) if (v.last < cutoff) buckets.delete(k)
}

function clientIp(req: NextRequest): string {
  const cf = req.headers.get('cf-connecting-ip')
  if (cf) return cf
  // Fallback for local/dev where CF isn't in front. Production should always
  // see CF-Connecting-IP because the firewall blocks non-CF origins.
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return 'unknown'
}

function take(ip: string): boolean {
  const now = Date.now() / 1000
  maybePrune(now)
  const b = buckets.get(ip) ?? { tokens: MAX_TOKENS, last: now }
  b.tokens = Math.min(MAX_TOKENS, b.tokens + (now - b.last) * REFILL_PER_SEC)
  b.last = now
  if (b.tokens < 1) {
    buckets.set(ip, b)
    return false
  }
  b.tokens -= 1
  buckets.set(ip, b)
  return true
}

export function middleware(req: NextRequest) {
  // SSE is one persistent connection per client; rate-limiting it would just
  // bounce legitimate dashboard tabs. The route itself is cheap to keep open.
  if (req.nextUrl.pathname === '/api/amp/events') return NextResponse.next()

  if (!take(clientIp(req))) {
    return new NextResponse('Too Many Requests', {
      status: 429,
      headers: { 'Retry-After': '30' },
    })
  }
  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
  runtime: 'nodejs',
}
