import { NextRequest } from 'next/server'
import { ampEvents, type TxEvent } from '@/lib/amp/events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Server-sent events stream. The dashboard opens one EventSource per tab; we
// push a "tx" event whenever the indexer ingests new SOL transfers, and a
// keepalive comment every 20s so proxies don't idle-close the connection.

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const safeEnqueue = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          closed = true
        }
      }

      safeEnqueue(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`)

      const onTx = (ev: TxEvent) => {
        safeEnqueue(`event: tx\ndata: ${JSON.stringify(ev)}\n\n`)
      }
      ampEvents.on('tx', onTx)

      // Send a real "ping" event every 10s so the client's onmessage / watchdog
      // sees traffic. `: comment\n\n` keepalives are valid SSE but the browser
      // never surfaces them to JS, so a stuck connection looks identical to a
      // healthy quiet one. A real event keeps both sides honest.
      const keepalive = setInterval(
        () => safeEnqueue(`event: ping\ndata: ${Date.now()}\n\n`),
        10_000
      )

      const cleanup = () => {
        closed = true
        clearInterval(keepalive)
        ampEvents.off('tx', onTx)
        try { controller.close() } catch {}
      }
      req.signal.addEventListener('abort', cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Caddy's reverse proxy respects this to disable any output buffering.
      'x-accel-buffering': 'no',
    },
  })
}
