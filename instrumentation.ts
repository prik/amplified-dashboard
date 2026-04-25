// Runs once when the Next.js server process boots. We use it to kick off the
// Solana fee-wallet indexer so the tail loop starts tracking new txs without
// requiring a separate worker process.
//
// See https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { startIndexer } = await import('./lib/amp/indexer')
  startIndexer()
}
