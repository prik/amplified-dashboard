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

export interface ParsedTokenBalance {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null }
}

export interface ParsedTx {
  slot: number
  blockTime: number | null
  meta: {
    err: unknown
    preBalances: number[]
    postBalances: number[]
    fee: number
    preTokenBalances?: ParsedTokenBalance[]
    postTokenBalances?: ParsedTokenBalance[]
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
// 20ms = ~50 RPS sustained, well under Speedy Nodes' 60 RPS cap, and since each
// call awaits before sleeping there's only ever 1 request in-flight (so the
// 5-request burst cap doesn't apply).
const PER_SIG_SPACING_MS = 20

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

export interface TokenAccountInfo {
  pubkey: string
  amount: string
  decimals: number
  uiAmount: number | null
}

// All token accounts a wallet owns for a given mint. Usually one (the ATA),
// but pre-ATA wallets and rare manual setups can have multiple. We sum across
// every returned account when computing balances. The {mint} filter matches
// regardless of which token program the account lives under.
export async function getTokenAccountsByOwner(owner: string, mint: string): Promise<TokenAccountInfo[]> {
  const res = await rpcCall<{ value: Array<{ pubkey: string; account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number; uiAmount: number | null } } } } } }> }>(
    'getTokenAccountsByOwner',
    [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]
  ).catch(() => null)
  if (!res?.value) return []
  const out: TokenAccountInfo[] = []
  for (const v of res.value) {
    const t = v.account?.data?.parsed?.info?.tokenAmount
    if (!t) continue
    out.push({ pubkey: v.pubkey, amount: t.amount, decimals: t.decimals, uiAmount: t.uiAmount })
  }
  return out
}

// Sum of an owner's raw token balance across all token accounts for a given
// mint. Returns 0 if the owner has no token accounts. Used by the close-side
// indexer side-effect to detect partial vs full closes — non-zero balance
// after a close-settle means the user still holds part of the position.
export async function getTokenBalanceRaw(owner: string, mint: string): Promise<bigint> {
  const accts = await getTokenAccountsByOwner(owner, mint)
  let total = 0n
  for (const a of accts) total += BigInt(a.amount)
  return total
}

// Same as above but returns decimals as well — useful when we don't know them
// yet (caller can cache).
export async function getTokenBalanceWithDecimals(
  owner: string, mint: string
): Promise<{ raw: bigint; decimals: number } | null> {
  const accts = await getTokenAccountsByOwner(owner, mint)
  if (accts.length === 0) return { raw: 0n, decimals: 0 }
  let total = 0n
  for (const a of accts) total += BigInt(a.amount)
  return { raw: total, decimals: accts[0].decimals }
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

// Same as getTokenSupply but also returns raw + decimals — needed by mcap
// math, which works in raw units to avoid float precision loss.
export async function getTokenSupplyRaw(mint: string): Promise<{ raw: bigint; decimals: number } | null> {
  try {
    const res = await rpcCall<{ value: { amount: string; decimals: number } }>(
      'getTokenSupply',
      [mint, { commitment: 'confirmed' }]
    )
    if (!res?.value) return null
    return { raw: BigInt(res.value.amount), decimals: res.value.decimals }
  } catch {
    return null
  }
}

