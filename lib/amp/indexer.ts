import {
  getSignaturesForAddress, getTransactionsBatch,
  getTokenSupply, getTokenAccountsByOwner, sleep,
  type ParsedTx,
} from './rpc'
import {
  insertTxs, getState, setState, hasSignature, countTxs,
  insertVerifications, hasVerification, countVerifications, allVerifiedWallets,
  upsertVerifiedBalance, getVerifiedBalances, type TxRow, type VerifRow,
} from './db'
import {
  FEE_WALLET, TOKEN_MINT, VERIFICATION_WALLET, VERIFICATION_LAMPORTS,
  LAUNCH_TS_SEC,
} from './config'
import { lastFridayUtcSec } from './queries'
import { ampEvents } from './events'

const SIG_PAGE = 1000
const TAIL_INTERVAL_MS = 60_000
const BETWEEN_PAGE_MS = 300

// Cadence for the verified-balance recompute job. Each tick walks every
// pinged wallet's AMP token-account history since the period start, so it's
// expensive (one getSignatures + N getTransaction per wallet). We don't need
// minute-level freshness here — verified balances change only when someone
// pings, transfers, or sells. 10 min keeps the dashboard responsive without
// hammering the RPC.
const VERIFIED_RECOMPUTE_MS = 10 * 60_000

// Skip recomputing a wallet whose snapshot was last checked within this window
// AND who hasn't pinged since. Avoids redundant per-wallet rescans on every
// recompute tick when nothing has happened.
const VERIFIED_PER_WALLET_FRESH_MS = 5 * 60_000

interface Classified {
  direction: 'in' | 'out'
  counterparty: string
  amount_lamports: number
}

// Classify a parsed Solana tx by comparing pre/post balances at the fee-wallet
// index. For INFLOWS the counterparty is the tx's fee payer (first signer),
// NOT the account with the largest opposite delta — on Amplified buys the pool
// co-signs the tx and moves SOL for trade settlement, so a naive largest-delta
// heuristic misattributes the fee source. The user's deposit wallet is always
// the fee payer.
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

interface PageResult { processed: number; stored: number }

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
    const sigs = await getSignaturesForAddress(FEE_WALLET, { limit: 100 })
    if (!sigs || sigs.length === 0) return
    const { stored } = await processSignaturesViaRpc(sigs)
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
      `[amp] indexer starting. fee_wallet=${FEE_WALLET} existing_txs=${countTxs()}`
    )
    fetchSupplyOnce().catch((e) => console.error('[amp] supply fetch crashed:', e))
    backfill().catch((e) => console.error('[amp] backfill crashed:', e))
    if (VERIFICATION_WALLET) {
      console.log(
        `[amp] verification indexer enabled. wallet=${VERIFICATION_WALLET} existing=${countVerifications()}`
      )
      backfillVerifications().catch((e) => console.error('[amp] verif backfill crashed:', e))
      runVerifiedRecomputeLoop().catch((e) => console.error('[amp] verif recompute loop crashed:', e))
    }
    for (;;) {
      await tailOnce()
      if (VERIFICATION_WALLET) await tailVerificationsOnce()
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

// ---------------------------------------------------------------------------
// Verification indexing — pings (~0.001 SOL) sent to VERIFICATION_WALLET.
// ---------------------------------------------------------------------------

interface ClassifiedPing {
  wallet: string
  amount_lamports: number
}

// A "ping" is a SOL inflow to VERIFICATION_WALLET equal to exactly
// VERIFICATION_LAMPORTS (default 0.001 SOL), signed by exactly one external
// wallet (which becomes the verified holder). Operational top-ups and other
// transfers at different sizes are ignored — the project's verification
// protocol uses an exact amount as its sentinel.
function classifyVerifPing(tx: ParsedTx | null): ClassifiedPing | null {
  if (!VERIFICATION_WALLET) return null
  if (!tx || !tx.meta || tx.meta.err) return null
  const keys = tx.transaction?.message?.accountKeys
  if (!keys) return null
  const keyPubkey = (k: (typeof keys)[number]) => (typeof k === 'string' ? k : k.pubkey)
  const keyIsSigner = (k: (typeof keys)[number]) => (typeof k === 'string' ? false : k.signer)

  const idx = keys.findIndex((k) => keyPubkey(k) === VERIFICATION_WALLET)
  if (idx < 0) return null
  const pre = tx.meta.preBalances, post = tx.meta.postBalances
  if (!pre || !post || pre.length !== post.length || idx >= pre.length) return null
  const delta = post[idx] - pre[idx]
  if (delta !== VERIFICATION_LAMPORTS) return null

  // Payer = the signer that isn't the verification wallet itself.
  const payerIdx = keys.findIndex((k) => keyIsSigner(k) && keyPubkey(k) !== VERIFICATION_WALLET)
  if (payerIdx < 0) return null
  const payer = keyPubkey(keys[payerIdx])
  if (!payer || payer === VERIFICATION_WALLET) return null
  return { wallet: payer, amount_lamports: delta }
}

async function processVerifSignatures(
  sigMetas: { signature: string; slot: number; blockTime: number | null }[]
): Promise<{ processed: number; stored: number }> {
  const fresh = sigMetas.filter((s) => !hasVerification(s.signature))
  if (fresh.length === 0) return { processed: 0, stored: 0 }

  const rows: VerifRow[] = []
  const results = await getTransactionsBatch(fresh.map((s) => s.signature))
  for (let j = 0; j < results.length; j++) {
    const { signature, tx, error } = results[j]
    if (error) {
      console.warn(`[amp] verif rpc err for ${signature.slice(0, 10)}…:`, error.message)
      continue
    }
    const c = classifyVerifPing(tx)
    if (!c) continue
    rows.push({
      signature,
      slot: tx!.slot,
      block_time: tx!.blockTime ?? fresh[j].blockTime ?? 0,
      wallet: c.wallet,
      amount_lamports: c.amount_lamports,
    })
  }
  if (rows.length > 0) insertVerifications(rows)
  return { processed: fresh.length, stored: rows.length }
}

async function backfillVerifications(): Promise<void> {
  if (!VERIFICATION_WALLET) return
  let before = getState('verif_oldest_sig') ?? undefined
  let pages = 0
  let stopReason = 'exhausted'
  outer: for (;;) {
    try {
      const sigs = await getSignaturesForAddress(VERIFICATION_WALLET, { before, limit: SIG_PAGE })
      if (!sigs || sigs.length === 0) break
      pages++
      // Cut off at LAUNCH_TS_SEC — pings older than launch can never affect a
      // current-period verification check, and the verification wallet may
      // have years of unrelated history. We process the page up to the cutoff,
      // then stop.
      const inWindow = LAUNCH_TS_SEC > 0
        ? sigs.filter((s) => s.blockTime == null || s.blockTime >= LAUNCH_TS_SEC)
        : sigs
      const { processed, stored } = await processVerifSignatures(inWindow)
      const oldest = sigs[sigs.length - 1]
      setState('verif_oldest_sig', oldest.signature)
      before = oldest.signature
      console.log(
        `[amp] verif backfill page ${pages}: ${sigs.length} sigs (${inWindow.length} in window), ` +
          `${stored}/${processed} stored. total=${countVerifications()}`
      )
      if (inWindow.length < sigs.length) { stopReason = 'pre-launch boundary'; break outer }
      if (sigs.length < SIG_PAGE) break
      await sleep(BETWEEN_PAGE_MS)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[amp] verif backfill page ${pages + 1} failed, retry in 10s:`, msg)
      await sleep(10_000)
    }
  }
  setState('verif_backfill_done_at', Date.now())
  console.log(`[amp] verif backfill complete (${stopReason}): pages=${pages} total=${countVerifications()}`)
}

async function tailVerificationsOnce(): Promise<void> {
  if (!VERIFICATION_WALLET) return
  try {
    const sigs = await getSignaturesForAddress(VERIFICATION_WALLET, { limit: 100 })
    if (!sigs || sigs.length === 0) return
    const { stored } = await processVerifSignatures(sigs)
    if (stored > 0) {
      console.log(`[amp] verif tail: +${stored} new pings. total=${countVerifications()}`)
      // Trigger an immediate verified-balance recompute pass — a fresh ping
      // means a new wallet (or a re-ping) needs its snapshot calculated.
      recomputeVerifiedBalancesOnce().catch((e) =>
        console.error('[amp] verif recompute (post-tail) failed:', e)
      )
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[amp] verif tail failed:', msg)
  }
}

// ---------------------------------------------------------------------------
// Verified-balance reconstruction. For every wallet that has pinged in the
// current period:
//   1. Read current AMP token balance(s) for the wallet (sum across token accts)
//   2. Walk every signature on each token account since period start
//   3. Sum pre/post deltas — any single negative delta = forfeit
//   4. Snapshot balance = current balance − sum of deltas (positive deltas only,
//      since a negative delta short-circuits to forfeit and balance=0)
// ---------------------------------------------------------------------------

async function runVerifiedRecomputeLoop(): Promise<void> {
  for (;;) {
    try {
      await recomputeVerifiedBalancesOnce()
    } catch (e) {
      console.error('[amp] verif recompute crashed:', e)
    }
    await sleep(VERIFIED_RECOMPUTE_MS)
  }
}

async function recomputeVerifiedBalancesOnce(): Promise<void> {
  if (!TOKEN_MINT || !VERIFICATION_WALLET) return
  const periodStart = lastFridayUtcSec()
  const wallets = allVerifiedWallets()
  if (wallets.length === 0) return

  // Build a lookup of wallets we've already checked this period so we can
  // skip ones whose last_checked is fresh AND that haven't re-pinged since.
  const cached = new Map<string, { lastChecked: number; forfeited: number }>()
  for (const r of getVerifiedBalances(periodStart)) {
    cached.set(r.wallet, { lastChecked: r.last_checked, forfeited: r.forfeited })
  }
  const freshCutoffSec = Math.floor((Date.now() - VERIFIED_PER_WALLET_FRESH_MS) / 1000)

  const nowSec = Math.floor(Date.now() / 1000)
  let computed = 0, skipped = 0, forfeited = 0
  for (const { wallet, lastPing } of wallets) {
    const prev = cached.get(wallet)
    // Skip recompute if we checked this wallet recently AND nothing fresh has
    // happened since (no new ping). Forfeited wallets are sticky for the
    // period — once flagged, no need to re-check.
    if (prev && prev.forfeited === 1) { skipped++; continue }
    if (prev && prev.lastChecked >= freshCutoffSec && prev.lastChecked >= lastPing) {
      skipped++
      continue
    }
    try {
      const result = await reconstructWalletSnapshot(wallet, periodStart)
      if (!result) continue
      upsertVerifiedBalance({
        period_start: periodStart,
        wallet,
        snapshot_raw: result.snapshotRaw,
        current_raw: result.currentRaw,
        decimals: result.decimals,
        forfeited: result.forfeited ? 1 : 0,
        last_checked: nowSec,
      })
      computed++
      if (result.forfeited) forfeited++
    } catch (e) {
      console.warn(
        `[amp] verif snapshot failed for ${wallet.slice(0, 8)}…:`,
        e instanceof Error ? e.message : String(e)
      )
    }
    // Tiny pause between wallets to keep RPC pressure bounded.
    await sleep(100)
  }
  console.log(
    `[amp] verif recompute: period=${new Date(periodStart * 1000).toISOString().slice(0, 10)} ` +
      `wallets=${wallets.length} computed=${computed} forfeited=${forfeited} skipped=${skipped}`
  )
  if (computed > 0) ampEvents.emit('tx', { reason: 'verif-recompute' })
}

interface SnapshotResult {
  snapshotRaw: string
  currentRaw: string
  decimals: number
  forfeited: boolean
}

// Bigint-safe arithmetic — SPL token amounts can exceed Number.MAX_SAFE_INTEGER
// for high-decimal mints, so all delta math goes through BigInt and only the
// final sum is rendered to a string for storage.
async function reconstructWalletSnapshot(
  wallet: string, periodStart: number
): Promise<SnapshotResult | null> {
  if (!TOKEN_MINT) return null
  const tokenAccounts = await getTokenAccountsByOwner(wallet, TOKEN_MINT)
  if (tokenAccounts.length === 0) {
    // Wallet has no AMP token account at all — verified but holds nothing.
    return { snapshotRaw: '0', currentRaw: '0', decimals: 0, forfeited: false }
  }
  const decimals = tokenAccounts[0].decimals
  const currentRaw = tokenAccounts.reduce((a, t) => a + BigInt(t.amount), 0n)

  // Collect every signature touching ANY of this owner's AMP token accounts
  // since the period start, then dedupe — a single tx can touch multiple
  // accounts but should only contribute one owner-level delta.
  const sigSet = new Set<string>()
  for (const acct of tokenAccounts) {
    let before: string | undefined
    for (let page = 0; page < 10; page++) {
      const batch = await getSignaturesForAddress(acct.pubkey, { before, limit: 200 })
      if (!batch || batch.length === 0) break
      let crossed = false
      for (const s of batch) {
        if (s.blockTime != null && s.blockTime < periodStart) { crossed = true; break }
        sigSet.add(s.signature)
      }
      if (crossed) break
      before = batch[batch.length - 1].signature
      if (batch.length < 200) break
      await sleep(BETWEEN_PAGE_MS)
    }
  }
  const sigs = [...sigSet]

  // Owner-level per-tx delta. Internal transfers between the user's own
  // accounts net to zero and don't trigger a forfeit; only a true outflow
  // (delta < 0) does.
  let netDelta = 0n
  let forfeited = false
  if (sigs.length > 0) {
    const txs = await getTransactionsBatch(sigs)
    for (const { tx } of txs) {
      if (!tx?.meta) continue
      const pre = tx.meta.preTokenBalances ?? []
      const post = tx.meta.postTokenBalances ?? []
      const isOurs = (b: { mint: string; owner?: string }) =>
        b.mint === TOKEN_MINT && b.owner === wallet
      const preAmt = pre.filter(isOurs).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n)
      const postAmt = post.filter(isOurs).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n)
      const delta = postAmt - preAmt
      if (delta === 0n) continue
      if (delta < 0n) forfeited = true
      netDelta += delta
    }
  }

  // Forfeit takes precedence — snapshot is zero regardless of math. Otherwise
  // snapshot = current − any inflows received during the period (the user only
  // bought / received during the period; net is non-negative).
  let snapshotRaw = forfeited ? 0n : currentRaw - netDelta
  if (snapshotRaw < 0n) snapshotRaw = 0n

  return {
    snapshotRaw: snapshotRaw.toString(),
    currentRaw: currentRaw.toString(),
    decimals,
    forfeited,
  }
}
