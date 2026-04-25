// Tiny in-process TTL cache. Dedupes RPC calls across concurrent users:
// 100 people refreshing the page within a 10s window produce one RPC call, not
// 100. Not persistent — cleared on container restart, which is fine.

interface Entry<T> { value: T; expires: number }
const store = new Map<string, Entry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

export async function ttlCache<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const now = Date.now()
  const existing = store.get(key) as Entry<T> | undefined
  if (existing && existing.expires > now) return existing.value

  // De-dupe parallel misses — the first caller fetches, the rest await the
  // same promise so we never issue two in-flight requests for the same key.
  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending

  const p = (async () => {
    try {
      const value = await fetcher()
      store.set(key, { value, expires: Date.now() + ttlMs })
      return value
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}
