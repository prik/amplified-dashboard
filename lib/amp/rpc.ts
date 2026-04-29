import { RPC_URL } from './config'

let rpcIdCounter = 1

interface RpcResponse<T> {
  jsonrpc: '2.0'
  id: number
  result?: T
  error?: { code: number; message: string }
}

async function rpcCall<T = unknown>(method: string, params: unknown[]): Promise<T> {
  // Retry with exponential backoff on 429 / transient errors. The RPC enforces
  // per-method rate limits, so under load a single call can get throttled.
  let lastErr: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = { jsonrpc: '2.0', id: rpcIdCounter++, method, params }
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 429) {
        lastErr = new Error(`rpc ${method} http 429`)
        await sleep(500 * Math.pow(2, attempt))
        continue
      }
      if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`)
      const json: RpcResponse<T> = await res.json()
      if (json.error) {
        // "Too many requests for a specific RPC call" is a content-level rate
        // limit that still returns 200. Retry it.
        const msg = json.error.message || ''
        if (/too many requests/i.test(msg)) {
          lastErr = new Error(`rpc ${method}: ${msg}`)
          await sleep(500 * Math.pow(2, attempt))
          continue
        }
        throw new Error(`rpc ${method}: ${msg}`)
      }
      return json.result as T
    } catch (e) {
      // fetch/TCP-level failures — treat as transient, retry a couple times
      if (attempt === 3) throw e
      lastErr = e
      await sleep(500 * Math.pow(2, attempt))
    }
  }
  throw lastErr
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface SigMeta {
  signature: string
  slot: number
  blockTime: number | null
  err: unknown
  memo: string | null
  confirmationStatus?: string
}

export async function getSignaturesForAddress(
  address: string,
  opts: { before?: string; until?: string; limit?: number } = {}
): Promise<SigMeta[]> {
  const { before, until, limit = 1000 } = opts
  const params: Record<string, unknown> = { limit }
  if (before) params.before = before
  if (until) params.until = until
  return rpcCall<SigMeta[]>('getSignaturesForAddress', [address, params])
}

export interface ParsedTx {
  slot: number
  blockTime: number | null
  meta: {
    err: unknown
    preBalances: number[]
    postBalances: number[]
    fee: number
  } | null
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean } | string>
    }
  } | null
}

export interface TxBatchResult {
  signature: string
  tx: ParsedTx | null
  error: { message: string } | null
}

const txParams = (sig: string) => [
  sig,
  { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
]

// Batch JSON-RPC was tested earlier but provider rate-limits made single-call
// with paced spacing strictly more reliable. Slower but doesn't get throttled.
const PER_SIG_SPACING_MS = 300

export async function getTransactionsBatch(signatures: string[]): Promise<TxBatchResult[]> {
  const out: TxBatchResult[] = []
  for (const sig of signatures) {
    try {
      const tx = await rpcCall<ParsedTx | null>('getTransaction', txParams(sig))
      out.push({ signature: sig, tx: tx ?? null, error: null })
    } catch (e) {
      out.push({ signature: sig, tx: null, error: { message: e instanceof Error ? e.message : String(e) } })
    }
    await sleep(PER_SIG_SPACING_MS)
  }
  return out
}

export async function getBalance(address: string): Promise<number> {
  const res = await rpcCall<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }])
  return res?.value ?? 0
}

// Fetch the total supply of an SPL token. Returns the supply as a plain number
// (decimals already applied — e.g. 1B for a 1B-supply token).
export async function getTokenSupply(mint: string): Promise<number> {
  const res = await rpcCall<{ value: { amount: string; decimals: number; uiAmount: number | null } }>(
    'getTokenSupply',
    [mint, { commitment: 'confirmed' }]
  )
  if (res?.value?.uiAmount != null) return res.value.uiAmount
  // Fallback: parse raw amount and divide by 10^decimals
  const amount = res?.value?.amount ? Number(res.value.amount) : 0
  const decimals = res?.value?.decimals ?? 0
  return amount / Math.pow(10, decimals)
}

