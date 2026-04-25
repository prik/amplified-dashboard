import {
  getSignaturesForAddress, getTransactionsBatch, getEnhancedTransactions,
  getTokenSupply, sleep, type ParsedTx, type EnhancedTx, HAS_HELIUS,
} from './rpc'
import { insertTxs, getState, setState, hasSignature, countTxs, type TxRow } from './db'
import { FEE_WALLET, TOKEN_MINT } from './config'
import { ampEvents } from './events'

const SIG_PAGE = 1000
const ENHANCED_PAGE = 100
const TAIL_INTERVAL_MS = 60_000
const BETWEEN_PAGE_MS = 300

interface Classified {
  direction: 'in' | 'out'
  counterparty: string
  amount_lamports: number
}

// Classify a generic parsed Solana tx by comparing pre/post balances at the
// fee-wallet index. For INFLOWS the counterparty is the tx's fee payer (first
// signer), NOT the account with the largest opposite delta — on Amplified buys
// the pool co-signs the tx and moves SOL for trade settlement, so a naive
// largest-delta heuristic misattributes the fee source. The user's deposit
// wallet is always the fee payer.
function classifyParsedTx(tx: ParsedTx | null): Classified | null {
  if (!tx || !tx.meta || tx.meta.err) return null
  const keys = tx.transaction?.message?.accountKeys
  if (!keys) return null
  const keyPubkey = (k: (typeof keys)[number]) => (typeof k === 'string' ? k : k.pubkey)
  const keyIsSigner = (k: (typeof keys)[number]) => (typeof k === 'string' ? false : k.signer)

  const idx = keys.findIndex((k) => keyPubkey(k) === FEE_WALLET)
  if (idx < 0) return null
  const pre = tx.meta.preBalances, post = tx.meta.postBalances
  if (!pre || !post || pre.length !== post.length || idx >= pre.length) return null
  const ourDelta = post[idx] - pre[idx]
  if (ourDelta === 0) return null

  if (ourDelta > 0) {
    // Inflow: counterparty = the user's fee-paying signer (not the pool).
    const payerIdx = keys.findIndex((k) => keyIsSigner(k) && keyPubkey(k) !== FEE_WALLET)
    if (payerIdx < 0) return null
    const payer = keyPubkey(keys[payerIdx])
    if (!payer || payer === FEE_WALLET) return null
    return { direction: 'in', counterparty: payer, amount_lamports: ourDelta }
  }

  // Outflow: fee wallet is the signer. Recipient = largest positive delta.
  let cpIdx = -1, cpDelta = 0
  for (let i = 0; i < pre.length; i++) {
    if (i === idx) continue
    const d = post[i] - pre[i]
    if (d > cpDelta) { cpDelta = d; cpIdx = i }
  }
  if (cpIdx < 0) return null
  const counterparty = keyPubkey(keys[cpIdx])
  if (!counterparty || counterparty === FEE_WALLET) return null
  return { direction: 'out', counterparty, amount_lamports: Math.abs(ourDelta) }
}

// Classify Helius-enhanced tx. Net fee-wallet delta decides direction; for
// inflows the counterparty is the tx's feePayer (the user's deposit wallet),
// not whichever account happened to have the largest opposite transfer.
function classifyEnhanced(tx: EnhancedTx): Classified | null {
  if (tx.transactionError) return null
  const transfers = tx.nativeTransfers ?? []

  let inAmt = 0
  let outAmt = 0
  let biggestOutRecipient: string | null = null
  let biggestOutAmt = 0

  for (const t of transfers) {
    if (!t.amount || t.amount <= 0) continue
    if (t.toUserAccount === FEE_WALLET && t.fromUserAccount && t.fromUserAccount !== FEE_WALLET) {
      inAmt += t.amount
    } else if (t.fromUserAccount === FEE_WALLET && t.toUserAccount && t.toUserAccount !== FEE_WALLET) {
      outAmt += t.amount
      if (t.amount > biggestOutAmt) {
        biggestOutAmt = t.amount
        biggestOutRecipient = t.toUserAccount
      }
    }
  }

  const netIn = inAmt - outAmt
  if (netIn > 0) {
    if (!tx.feePayer || tx.feePayer === FEE_WALLET) return null
    return { direction: 'in', counterparty: tx.feePayer, amount_lamports: netIn }
  }
  if (netIn < 0) {
    if (!biggestOutRecipient) return null
    return { direction: 'out', counterparty: biggestOutRecipient, amount_lamports: -netIn }
  }
  return null
}

interface PageResult { processed: number; stored: number }

// ---- Helius-enhanced processor (fast path) ----

async function processEnhancedPage(txs: EnhancedTx[]): Promise<PageResult> {
  const fresh = txs.filter((t) => !hasSignature(t.signature))
  if (fresh.length === 0) return { processed: 0, stored: 0 }

  const rows: TxRow[] = []
  for (const t of fresh) {
    const c = classifyEnhanced(t)
    if (!c) continue
    rows.push({
      signature: t.signature,
      slot: t.slot,
      block_time: t.timestamp ?? 0,
      direction: c.direction,
      counterparty: c.counterparty,
      amount_lamports: c.amount_lamports,
    })
  }
  if (rows.length > 0) insertTxs(rows)
  return { processed: fresh.length, stored: rows.length }
}

// ---- Fallback processor (generic RPC) ----

async function processSignaturesViaRpc(
  sigMetas: { signature: string; slot: number; blockTime: number | null }[]
): Promise<PageResult> {
  const fresh = sigMetas.filter((s) => !hasSignature(s.signature))
  if (fresh.length === 0) return { processed: 0, stored: 0 }

  const rows: TxRow[] = []
  const results = await getTransactionsBatch(fresh.map((s) => s.signature))
  for (let j = 0; j < results.length; j++) {
    const { signature, tx, error } = results[j]
    if (error) {
      console.warn(`[amp] rpc err for ${signature.slice(0, 10)}…:`, error.message)
      continue
    }
    const c = classifyParsedTx(tx)
    if (!c) continue
    rows.push({
      signature,
      slot: tx!.slot,
      block_time: tx!.blockTime ?? fresh[j].blockTime ?? 0,
      direction: c.direction,
      counterparty: c.counterparty,
      amount_lamports: c.amount_lamports,
    })
  }
  if (rows.length > 0) insertTxs(rows)
  return { processed: fresh.length, stored: rows.length }
}

// ---- Backfill ----

async function backfill(): Promise<void> {
  let before = getState('oldest_sig') ?? undefined
  let pages = 0

  for (;;) {
    try {
      if (HAS_HELIUS) {
        const txs = await getEnhancedTransactions(FEE_WALLET, { before, limit: ENHANCED_PAGE })
        if (!txs || txs.length === 0) break
        pages++
        const { processed, stored } = await processEnhancedPage(txs)
        const oldest = txs[txs.length - 1]
        setState('oldest_sig', oldest.signature)
        before = oldest.signature
        const oldestDate = oldest.timestamp ? new Date(oldest.timestamp * 1000).toISOString().slice(0, 10) : '—'
        console.log(
          `[amp] backfill page ${pages} (enhanced): ${txs.length} txs, ${stored}/${processed} stored. ` +
            `total=${countTxs()}. oldest=${oldest.signature.slice(0, 10)}… (${oldestDate})`
        )
        if (txs.length < ENHANCED_PAGE) break
      } else {
        const sigs = await getSignaturesForAddress(FEE_WALLET, { before, limit: SIG_PAGE })
        if (!sigs || sigs.length === 0) break
        pages++
        const { processed, stored } = await processSignaturesViaRpc(sigs)
        const oldest = sigs[sigs.length - 1]
        setState('oldest_sig', oldest.signature)
        before = oldest.signature
        const oldestDate = oldest.blockTime ? new Date(oldest.blockTime * 1000).toISOString().slice(0, 10) : '—'
        console.log(
          `[amp] backfill page ${pages}: ${sigs.length} sigs, ${stored}/${processed} stored. ` +
            `total=${countTxs()}. oldest=${oldest.signature.slice(0, 10)}… (${oldestDate})`
        )
        if (sigs.length < SIG_PAGE) break
      }
      await sleep(BETWEEN_PAGE_MS)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[amp] backfill page ${pages + 1} failed, retry in 10s:`, msg)
      await sleep(10_000)
    }
  }

  setState('backfill_done_at', Date.now())
  console.log(`[amp] backfill complete: pages=${pages} total=${countTxs()}`)
}

// ---- Tail ----

async function tailOnce(): Promise<void> {
  try {
    let stored = 0
    if (HAS_HELIUS) {
      const txs = await getEnhancedTransactions(FEE_WALLET, { limit: ENHANCED_PAGE })
      if (!txs || txs.length === 0) return
      stored = (await processEnhancedPage(txs)).stored
    } else {
      const sigs = await getSignaturesForAddress(FEE_WALLET, { limit: 100 })
      if (!sigs || sigs.length === 0) return
      stored = (await processSignaturesViaRpc(sigs)).stored
    }
    if (stored > 0) {
      const total = countTxs()
      console.log(`[amp] tail: +${stored} new txs. total=${total}`)
      // Notify SSE subscribers so the UI can refresh immediately.
      ampEvents.emit('tx', { stored, total, reason: 'tail' })
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[amp] tail failed:', msg)
  }
}

let started = false

export function startIndexer(): void {
  if (started) return
  started = true

  const run = async () => {
    console.log(
      `[amp] indexer starting. fee_wallet=${FEE_WALLET} existing_txs=${countTxs()} ` +
        `mode=${HAS_HELIUS ? 'helius-enhanced' : 'generic-rpc'}`
    )
    fetchSupplyOnce().catch((e) => console.error('[amp] supply fetch crashed:', e))
    backfill().catch((e) => console.error('[amp] backfill crashed:', e))
    for (;;) {
      await tailOnce()
      await sleep(TAIL_INTERVAL_MS)
    }
  }

  run().catch((e) => console.error('[amp] indexer fatal:', e))
}

// Token supply is fixed for a given mint. Fetch once, cache forever in
// amp_state. Re-runs only if the cached value is missing/zero.
async function fetchSupplyOnce(): Promise<void> {
  if (!TOKEN_MINT) return
  const cached = getState('token_supply')
  if (cached && Number(cached) > 0) return
  try {
    const supply = await getTokenSupply(TOKEN_MINT)
    if (supply > 0) {
      setState('token_supply', supply)
      console.log(`[amp] cached token supply: ${supply.toLocaleString()} (mint=${TOKEN_MINT.slice(0, 8)}…)`)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[amp] failed to fetch token supply:', msg)
  }
}
