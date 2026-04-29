import {
  getSignaturesForAddress, getTransactionsBatch,
  getTokenSupply, getTokenAccountsByOwner, getTokenBalanceRaw, sleep,
  type ParsedTx,
} from './rpc'
import {
  insertTxs, getState, setState, hasSignature, countTxs,
  insertVerifications, hasVerification, countVerifications, allVerifiedWallets,
  upsertVerifiedBalance, getVerifiedBalances,
  updateTxKind, getInflowSignaturesMissingKind,
  updateTxTradeMeta, getInflowSignaturesMissingTradeMeta,
  upsertWalletPair,
  insertTradeOpen, getActiveTradeForTrading, applyTradeClose,
  type TxRow, type VerifRow, type FeeKind, type TradeMetaUpdate,
} from './db'
import { resolveTokenMeta } from './tokens'
import {
  FEE_WALLET, TOKEN_MINT, POOL_WALLET, VERIFICATION_WALLET, VERIFICATION_LAMPORTS,
  LAUNCH_TS_SEC,
} from './config'
import { lastFridayUtcSec } from './queries'
import { ampEvents } from './events'

const SIG_PAGE = 1000
const TAIL_INTERVAL_MS = 60_000
const BETWEEN_PAGE_MS = 50

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
  kind: FeeKind | null
}

// Liquidation threshold for closes. ATA-rent reclaim on close is bounded at
// ~0.005-0.010 SOL regardless of trade size (it reflects physical account
// closures, not trade economics). For small trades we need an absolute floor
// to distinguish rent from a real refund; for large trades we need a relative
// threshold so a 1 SOL collateral trade returning 0.05 SOL isn't classified as
// REKT despite recovering only 5% of stake.
//
// Final rule: REKT iff dep_refund ≤ max(LIQ_FLOOR_LAM, collat × LIQ_FRAC).
// Floor of 0.015 SOL absorbs observed rent-only refunds; fraction of 10% means
// any trade returning <10% of original collateral counts as a wipe.
const LIQ_FLOOR_LAM = 15_000_000
const LIQ_FRAC = 0.1
function isLiquidation(depRefundLam: number, collatLam: number): 0 | 1 {
  const threshold = Math.max(LIQ_FLOOR_LAM, Math.floor(collatLam * LIQ_FRAC))
  return depRefundLam <= threshold ? 1 : 0
}

// Common collateral steps used by Amplified's UI. We snap raw on-chain
// collateral estimates to these to recover the user's *intended* size.
const COLLAT_STEPS_LAM = [
  5_000_000,    // 0.005
  10_000_000,   // 0.01
  25_000_000,   // 0.025
  50_000_000,   // 0.05
  75_000_000,   // 0.075
  100_000_000,  // 0.1
  150_000_000,  // 0.15
  200_000_000,  // 0.2
  250_000_000,  // 0.25
  500_000_000,  // 0.5
  1_000_000_000,// 1.0
  2_000_000_000,// 2.0
]
function snapCollat(rawLam: number): number {
  let best = COLLAT_STEPS_LAM[0]
  let bestDiff = Math.abs(rawLam - best)
  for (const s of COLLAT_STEPS_LAM) {
    const d = Math.abs(rawLam - s)
    if (d < bestDiff) { best = s; bestDiff = d }
  }
  return best
}

// Compute market-cap-in-SOL given:
//   solLam            — SOL paid in (or received from) the swap, in lamports
//   tokensRaw         — tokens moved in/out of the trading wallet, raw units
//   totalSupplyRaw    — total supply of the mint, raw units (decimals same as tokensRaw)
// Decimals cancel: mcap_sol = solLam × supplyRaw / (1e9 × tokensRaw)
// We use BigInt for the multiplication step to avoid Number overflow on the
// (10^9 × 10^15) intermediate; final divide returns a Number for storage.
function computeMcapSol(solLam: number, tokensRaw: number, totalSupplyRaw: number | null): number | null {
  if (!totalSupplyRaw || tokensRaw <= 0 || solLam <= 0) return null
  const num = BigInt(solLam) * BigInt(totalSupplyRaw)
  const denom = BigInt(tokensRaw) * 1_000_000_000n
  if (denom === 0n) return null
  // Scale by 1e6 before truncation to preserve micro-SOL precision, then
  // divide back at the end.
  const scaled = (num * 1_000_000n) / denom
  return Number(scaled) / 1_000_000
}

// Side-effect for a close-settle event. Looks up the matching active trade
// for the trading wallet, queries the wallet's current token balance to detect
// whether this is a partial or final close, computes per-event exit mcap, and
// records both an amp_trade_close row and an amp_trade aggregate update.
async function applyCloseSideEffect(args: {
  closeSig: string
  closeTrading: string
  blockTime: number
  depRefundLam: number
  closeFeeLam: number
  poolCloseLam: number
  tradingSettleDelta: number
}): Promise<void> {
  const open = getActiveTradeForTrading(args.closeTrading)
  if (!open) {
    // No matching open. Best-effort: mark amp_txs as a close, with the absolute
    // liquidation floor since we don't know the collat. Trade is invisible to
    // amp_trade — pre-launch / pre-index opener.
    const isLiq = args.depRefundLam <= LIQ_FLOOR_LAM ? 1 : 0
    updateTxTradeMeta(args.closeSig, {
      pool_delta_lam: args.poolCloseLam, is_open: 0, is_liquidation: isLiq,
      token_mint: null, leverage: null, collat_lam: null,
    })
    return
  }

  // Tokens still held by the trading wallet for this position's mint, RIGHT
  // NOW. tokens_sold_this_close = previous_remaining - current_balance.
  // Note: in backfill this reflects current state, not historical state at
  // close time. For trades that have already fully closed by the time we
  // backfill, current balance is 0 and we treat the close as final.
  let currentBalance = 0n
  try {
    currentBalance = await getTokenBalanceRaw(open.trading_wallet, open.token_mint)
  } catch (e) {
    console.warn('[amp] balance lookup failed for close', args.closeSig.slice(0, 10), e instanceof Error ? e.message : e)
  }
  const prevRemaining = BigInt(open.tokens_remaining_raw)
  let soldThisClose = prevRemaining - currentBalance
  if (soldThisClose < 0n) soldThisClose = 0n   // shouldn't happen, but clamp
  if (soldThisClose > prevRemaining) soldThisClose = prevRemaining
  const isFinal: 0 | 1 = currentBalance === 0n ? 1 : 0

  // Exit mcap for THIS event. Swap proceeds = -trading_settle_delta (trading
  // wallet sent that SOL out as pool_back + fee + dep_refund + small overhead).
  // Per-event mcap = (proceeds / tokens_sold) × supply. We need the mint's
  // total supply (from amp_token_meta). Fetch lazily — supply doesn't change.
  const meta = await resolveTokenMeta(open.token_mint).catch(() => null)
  const proceedsLam = Math.max(0, -args.tradingSettleDelta)
  const exitMcap = soldThisClose > 0n
    ? computeMcapSol(proceedsLam, Number(soldThisClose), meta?.total_supply_raw ?? null)
    : null

  // Liquidation only meaningful at FINAL close (a partial profit-take isn't
  // "REKT" even if a small refund). On final, scale threshold against the
  // ORIGINAL collateral.
  const isLiqFinal: 0 | 1 = isFinal
    ? isLiquidation(open.dep_refund_total_lam + args.depRefundLam, open.collat_lam)
    : 0

  // Mirror onto amp_txs so the live feed pill renders correctly. Token /
  // leverage / collat copy from the open; is_liquidation only flips on the
  // final close.
  updateTxTradeMeta(args.closeSig, {
    pool_delta_lam: args.poolCloseLam, is_open: 0,
    is_liquidation: isFinal ? isLiqFinal : 0,
    token_mint: open.token_mint, leverage: open.leverage, collat_lam: open.collat_lam,
  })

  applyTradeClose({
    open_signature: open.open_signature,
    pool_open_lam: open.pool_open_lam,
    is_liquidation_final: isFinal ? isLiqFinal : null,
    partial: {
      close_signature: args.closeSig,
      closed_at: args.blockTime,
      tokens_sold_raw: Number(soldThisClose),
      pool_close_lam: args.poolCloseLam,
      dep_refund_lam: args.depRefundLam,
      fee_close_lam: args.closeFeeLam,
      exit_mcap_sol: exitMcap,
      is_final: isFinal,
    },
  })
}

// Trade meta extracted from a parsed open/close fee tx. See
// /home/kode/.claude/projects/-home-kode-amplified-dashboard/memory/project_amplified_tx_anatomy.md
// for the full anatomy and the unified leverage formula.
//
// `pool_delta_lam` sign tells us direction:
//   < 0 → OPEN (pool fronted SOL out)
//   > 0 → CLOSE (pool reclaimed SOL)
//   == 0 / null → not a trade event (e.g. dust spam, weekly distribution slice)
//
// On opens, we identify the trading wallet (the position holder) and stash an
// `amp_open_state` entry so the eventual close-settle tx can be enriched with
// the same token + leverage. On closes, we pop the entry — that resolves the
// token mint without needing to re-fetch the swap-leg tx.
interface ExtractedTrade {
  meta: TradeMetaUpdate
  // Inputs to side-effects (wallet pair upsert, trade open insert).
  // Filled only on opens; null on closes / non-trades.
  open_side: {
    deposit_wallet: string
    trading_wallet: string
    token_mint: string
    leverage: number
    collat_lam: number
    // Raw token amount the trading wallet received in this open (NEW scheme:
    // present in this tx; OLD scheme: 0 here, the swap leg has it — handled
    // by a follow-up balance check).
    tokens_received_raw: number
  } | null
  // Filled only on closes.
  close_side: {
    trading_wallet: string
    deposit_refund_lam: number
    // Trading wallet's net SOL delta in the close-settle tx. Negative means
    // the trading wallet sent out SOL (sum of pool_back + fee + dep_refund +
    // small overhead). |value| ≈ swap proceeds for *this* close event,
    // letting us compute exit mcap = (proceeds / tokens_sold) × supply.
    trading_settle_delta_lam: number
  } | null
}

function extractTradeMeta(tx: ParsedTx, classified: Classified): ExtractedTrade {
  const empty: ExtractedTrade = {
    meta: { pool_delta_lam: null, is_open: null, is_liquidation: null,
            token_mint: null, leverage: null, collat_lam: null },
    open_side: null, close_side: null,
  }
  if (classified.direction === 'out') return empty
  if (!POOL_WALLET) return empty
  if (!tx.meta) return empty

  const keys = tx.transaction?.message?.accountKeys
  if (!keys) return empty
  const keyPubkey = (k: (typeof keys)[number]) => (typeof k === 'string' ? k : k.pubkey)
  const keyIsSigner = (k: (typeof keys)[number]) => (typeof k === 'string' ? false : k.signer)

  const poolIdx = keys.findIndex((k) => keyPubkey(k) === POOL_WALLET)
  if (poolIdx < 0) return empty  // pool not in tx → not a trade event

  const pre = tx.meta.preBalances, post = tx.meta.postBalances
  if (!pre || !post || pre.length !== post.length) return empty
  const poolDelta = post[poolIdx] - pre[poolIdx]
  if (poolDelta === 0) return empty

  // Direction follows pool delta sign.
  if (poolDelta < 0) {
    // ---- OPEN ----
    const deposit = classified.counterparty   // the fee payer = deposit wallet
    // Trading wallet identification:
    //   NEW scheme: trading is the 2nd non-fee-wallet, non-pool signer
    //   OLD scheme: trading isn't a signer; it's the account that receives
    //     the largest non-pool/fee/deposit positive SOL delta (the position SOL)
    let trading: string | null = null
    // Try NEW first: look for another signer
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      if (!keyIsSigner(k)) continue
      const pk = keyPubkey(k)
      if (pk === FEE_WALLET || pk === POOL_WALLET || pk === deposit) continue
      trading = pk
      break
    }
    if (!trading) {
      // OLD scheme: largest positive SOL delta among non-pool/fee/deposit accts
      let bestIdx = -1, bestDelta = 0
      for (let i = 0; i < keys.length; i++) {
        const pk = keyPubkey(keys[i])
        if (pk === FEE_WALLET || pk === POOL_WALLET || pk === deposit) continue
        const d = post[i] - pre[i]
        if (d > bestDelta) { bestDelta = d; bestIdx = i }
      }
      if (bestIdx >= 0) trading = keyPubkey(keys[bestIdx])
    }
    if (!trading) return { ...empty, meta: { ...empty.meta, pool_delta_lam: poolDelta, is_open: 1 } }

    // Token mint + amount: the trading wallet's positive token-balance delta
    // in this tx (NEW scheme only; OLD scheme has no token movement here — the
    // swap leg lives in a separate tx, and tokens_received_raw stays 0 here).
    let token_mint: string | null = null
    let tokens_received_raw_big = 0n
    const preTb = tx.meta.preTokenBalances ?? []
    const postTb = tx.meta.postTokenBalances ?? []
    const tradingTokens = new Map<string, { pre: bigint; post: bigint }>()
    for (const b of preTb) {
      if (b.owner !== trading) continue
      if (b.mint === 'So11111111111111111111111111111111111111112') continue
      const cur = tradingTokens.get(b.mint) ?? { pre: 0n, post: 0n }
      cur.pre += BigInt(b.uiTokenAmount.amount)
      tradingTokens.set(b.mint, cur)
    }
    for (const b of postTb) {
      if (b.owner !== trading) continue
      if (b.mint === 'So11111111111111111111111111111111111111112') continue
      const cur = tradingTokens.get(b.mint) ?? { pre: 0n, post: 0n }
      cur.post += BigInt(b.uiTokenAmount.amount)
      tradingTokens.set(b.mint, cur)
    }
    for (const [mint, v] of tradingTokens) {
      const d = v.post - v.pre
      if (d > 0n) { token_mint = mint; tokens_received_raw_big = d; break }
    }

    // Leverage formula (unified across schemes):
    //   collat ≈ -dep_delta - fee_delta - trading_topup (NEW) or - rent_overhead (OLD)
    //   leverage = round(pool_outflow / collat) + 1
    const depIdx = keys.findIndex((k) => keyPubkey(k) === deposit)
    const feeIdx = keys.findIndex((k) => keyPubkey(k) === FEE_WALLET)
    const tradingIdx = keys.findIndex((k) => keyPubkey(k) === trading)
    const depDelta = depIdx >= 0 ? post[depIdx] - pre[depIdx] : 0
    const feeDelta = feeIdx >= 0 ? post[feeIdx] - pre[feeIdx] : 0
    const tradDelta = tradingIdx >= 0 ? post[tradingIdx] - pre[tradingIdx] : 0
    // NEW scheme: trading_topup is small (positive). OLD: trading received the
    // full position; subtract a rent overhead estimate instead.
    const isNew = !!token_mint
    const overhead = isNew ? Math.max(0, tradDelta) : 11_000_000  // 0.011 SOL rent estimate
    const rawCollatLam = -depDelta - feeDelta - overhead
    if (rawCollatLam < 1_000_000) {
      // Doesn't look right; bail out with just direction info.
      return { ...empty, meta: { ...empty.meta, pool_delta_lam: poolDelta, is_open: 1 } }
    }
    const collatLam = snapCollat(rawCollatLam)
    const lev = Math.max(2, Math.min(10, Math.round(-poolDelta / collatLam) + 1))

    return {
      meta: {
        pool_delta_lam: poolDelta, is_open: 1, is_liquidation: null,
        token_mint, leverage: lev, collat_lam: collatLam,
      },
      open_side: token_mint ? {
        deposit_wallet: deposit, trading_wallet: trading,
        token_mint, leverage: lev, collat_lam: collatLam,
        // tokens_received_raw fits in Number for pump.fun-shape tokens; bigint
        // → number conversion is safe up to 2^53. For larger mints precision
        // may slip; mcap math tolerates it.
        tokens_received_raw: Number(tokens_received_raw_big),
      } : null,
      close_side: null,
    }
  } else {
    // ---- CLOSE ----
    // counterparty is the trading wallet (sole signer on close-settle txs).
    const trading = classified.counterparty
    // deposit refund: the deposit wallet's SOL inflow in this same tx. We
    // pick the largest non-pool / non-fee / non-trading positive delta as a
    // best-guess deposit address.
    let depRefundLam = 0
    for (let i = 0; i < keys.length; i++) {
      const pk = keyPubkey(keys[i])
      if (pk === POOL_WALLET || pk === FEE_WALLET || pk === trading) continue
      const d = post[i] - pre[i]
      if (d > depRefundLam) depRefundLam = d
    }
    // Trading wallet's net SOL delta (negative — it's distributing swap
    // proceeds out). Used to derive swap proceeds for exit-mcap math.
    const tradingIdx = keys.findIndex((k) => keyPubkey(k) === trading)
    const tradingDelta = tradingIdx >= 0 ? post[tradingIdx] - pre[tradingIdx] : 0

    // Don't pre-classify is_liquidation here — the threshold scales with the
    // matched open's collateral, which we only know after the side-effect's
    // getActiveTradeForTrading lookup. NULL means "deferred"; the side-effect
    // overwrites with the right value, or falls back to the absolute floor if
    // there's no matching open (legacy / pre-launch opener).
    return {
      meta: {
        pool_delta_lam: poolDelta, is_open: 0, is_liquidation: null,
        token_mint: null, leverage: null, collat_lam: null,
      },
      open_side: null,
      close_side: {
        trading_wallet: trading,
        deposit_refund_lam: depRefundLam,
        trading_settle_delta_lam: tradingDelta,
      },
    }
  }
}

// Bucket the counterparty's net SPL-token movement in this tx into entry/exit.
// 'entry' = user gained tokens (opened a position / bought via Amplified)
// 'exit'  = user lost tokens   (closed a position / sold)
// 'other' = no token movement, or both gains and losses (route swaps, etc.)
function classifyKind(tx: ParsedTx, counterparty: string): FeeKind {
  const pre = tx.meta?.preTokenBalances ?? []
  const post = tx.meta?.postTokenBalances ?? []
  const byMint = new Map<string, { pre: bigint; post: bigint }>()
  const get = (mint: string) => {
    let cur = byMint.get(mint)
    if (!cur) { cur = { pre: 0n, post: 0n }; byMint.set(mint, cur) }
    return cur
  }
  for (const b of pre) {
    if (b.owner !== counterparty) continue
    get(b.mint).pre += BigInt(b.uiTokenAmount.amount)
  }
  for (const b of post) {
    if (b.owner !== counterparty) continue
    get(b.mint).post += BigInt(b.uiTokenAmount.amount)
  }
  let hasGain = false
  let hasLoss = false
  for (const v of byMint.values()) {
    const d = v.post - v.pre
    if (d > 0n) hasGain = true
    else if (d < 0n) hasLoss = true
  }
  if (hasGain && !hasLoss) return 'entry'
  if (hasLoss && !hasGain) return 'exit'
  return 'other'
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
    return {
      direction: 'in',
      counterparty: payer,
      amount_lamports: ourDelta,
      kind: classifyKind(tx, payer),
    }
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
  return { direction: 'out', counterparty, amount_lamports: Math.abs(ourDelta), kind: null }
}

interface PageResult { processed: number; stored: number }

async function processSignaturesViaRpc(
  sigMetas: { signature: string; slot: number; blockTime: number | null }[]
): Promise<PageResult> {
  // Sort ascending by blockTime so opens are processed before their closes
  // when both fall in the same fetch window — without this the close-side
  // side-effect can run before the open-side has written amp_trade, breaking
  // the partial-close pairing.
  const fresh = sigMetas
    .filter((s) => !hasSignature(s.signature))
    .sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0))
  if (fresh.length === 0) return { processed: 0, stored: 0 }

  const rows: TxRow[] = []
  const sideEffects: Array<() => Promise<void>> = []
  const results = await getTransactionsBatch(fresh.map((s) => s.signature))
  for (let j = 0; j < results.length; j++) {
    const { signature, tx, error } = results[j]
    if (error) {
      console.warn(`[amp] rpc err for ${signature.slice(0, 10)}…:`, error.message)
      continue
    }
    const c = classifyParsedTx(tx)
    if (!c) continue
    const trade = tx ? extractTradeMeta(tx, c) : null
    const blockTime = tx!.blockTime ?? fresh[j].blockTime ?? 0
    rows.push({
      signature,
      slot: tx!.slot,
      block_time: blockTime,
      direction: c.direction,
      counterparty: c.counterparty,
      amount_lamports: c.amount_lamports,
      kind: c.kind,
      pool_delta_lam: trade?.meta.pool_delta_lam ?? null,
      is_open: trade?.meta.is_open ?? null,
      is_liquidation: trade?.meta.is_liquidation ?? null,
      token_mint: trade?.meta.token_mint ?? null,
      leverage: trade?.meta.leverage ?? null,
      collat_lam: trade?.meta.collat_lam ?? null,
    })
    if (trade?.open_side) {
      const o = trade.open_side
      const openFeeLam = c.amount_lamports
      const txKeys = tx?.transaction?.message?.accountKeys ?? []
      const depIdx = txKeys.findIndex((k) => (typeof k === 'string' ? k : k.pubkey) === o.deposit_wallet)
      const depDelta = depIdx >= 0 && tx?.meta
        ? tx.meta.postBalances[depIdx] - tx.meta.preBalances[depIdx]
        : 0
      const depOpenLam = -depDelta
      const poolOpenLam = trade.meta.pool_delta_lam != null ? -trade.meta.pool_delta_lam : 0
      const positionLam = o.leverage * o.collat_lam

      sideEffects.push(async () => {
        upsertWalletPair({
          trading_wallet: o.trading_wallet,
          deposit_wallet: o.deposit_wallet,
          first_seen: blockTime,
        })
        // Resolve token meta (symbol + decimals + supply) — used for entry
        // mcap. Falls through to null mcap if supply not yet known; future
        // call will fill via the COALESCE upsert.
        const meta = await resolveTokenMeta(o.token_mint).catch(() => null)
        const entryMcap = computeMcapSol(positionLam, o.tokens_received_raw, meta?.total_supply_raw ?? null)

        insertTradeOpen({
          open_signature: signature,
          deposit_wallet: o.deposit_wallet,
          trading_wallet: o.trading_wallet,
          token_mint: o.token_mint,
          leverage: o.leverage,
          collat_lam: o.collat_lam,
          position_lam: positionLam,
          opened_at: blockTime,
          pool_open_lam: poolOpenLam,
          dep_open_lam: depOpenLam,
          fee_open_lam: openFeeLam,
          tokens_received_raw: o.tokens_received_raw,
          entry_mcap_sol: entryMcap,
        })
      })
    }
    if (trade?.close_side) {
      const closeSig = signature
      const closeTrading = trade.close_side.trading_wallet
      const depRefundLam = trade.close_side.deposit_refund_lam
      const closeFeeLam = c.amount_lamports
      const poolCloseLam = trade.meta.pool_delta_lam ?? 0
      const tradingSettleDelta = trade.close_side.trading_settle_delta_lam
      sideEffects.push(() => applyCloseSideEffect({
        closeSig, closeTrading, blockTime,
        depRefundLam, closeFeeLam, poolCloseLam, tradingSettleDelta,
      }))
    }
  }
  if (rows.length > 0) insertTxs(rows)
  for (const fn of sideEffects) {
    try { await fn() } catch (e) {
      console.warn('[amp] trade side-effect failed:', e instanceof Error ? e.message : e)
    }
  }
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

// ---- Kind backfill ----
// `kind` (entry/exit/other) was added later, so legacy inflow rows have it as
// NULL. The feed surfaces the latest 50 inflows with a pill, so this one-shot
// pass at startup re-fetches the most recent inflows that are missing kind and
// patches them in. Older rows naturally fill in over subsequent restarts as
// the unfilled-window slides forward.
const KIND_BACKFILL_LIMIT = 200

async function backfillKindsOnce(): Promise<void> {
  const sigs = getInflowSignaturesMissingKind(KIND_BACKFILL_LIMIT)
  if (sigs.length === 0) return
  console.log(`[amp] kind backfill: classifying ${sigs.length} inflows`)
  const results = await getTransactionsBatch(sigs)
  let patched = 0
  for (const { signature, tx } of results) {
    if (!tx) continue
    const c = classifyParsedTx(tx)
    if (!c || c.direction !== 'in' || !c.kind) continue
    updateTxKind(signature, c.kind)
    patched++
  }
  console.log(`[amp] kind backfill: patched ${patched}/${sigs.length} inflows`)
}

// ---- Trade-meta backfill ----
// Same idea as kind backfill — fills pool_delta_lam / is_open / is_liquidation
// / token_mint / leverage / collat_lam on legacy inflow rows. Feed pill,
// deduped user counts, and any leverage/token UI all depend on these fields.
//
// Runs in chunks of TRADE_META_BACKFILL_CHUNK newest-first, looping until no
// NULL rows remain. Async + non-blocking; doesn't gate the server boot. Each
// chunk has a small inter-chunk pause so we don't monopolise the RPC budget.
const TRADE_META_BACKFILL_CHUNK = 500
const TRADE_META_BACKFILL_PAUSE_MS = 500

async function backfillTradeMetaOnce(): Promise<void> {
  let pass = 0
  for (;;) {
    const did = await backfillTradeMetaChunk(TRADE_META_BACKFILL_CHUNK)
    if (did === 0) break
    pass++
    await sleep(TRADE_META_BACKFILL_PAUSE_MS)
  }
  if (pass > 0) console.log(`[amp] trade-meta backfill: complete (${pass} chunks)`)
}

async function backfillTradeMetaChunk(limit: number): Promise<number> {
  const sigs = getInflowSignaturesMissingTradeMeta(limit)
  if (sigs.length === 0) return 0
  console.log(`[amp] trade-meta backfill: re-fetching ${sigs.length} inflows`)
  // Walk OLDEST first so the open→close ordering used by amp_trade matches.
  const oldestFirst = [...sigs].reverse()
  const results = await getTransactionsBatch(oldestFirst)
  let patched = 0
  for (let i = 0; i < results.length; i++) {
    const { signature, tx } = results[i]
    if (!tx) continue
    const c = classifyParsedTx(tx)
    if (!c) continue
    const trade = extractTradeMeta(tx, c)
    if (trade.meta.pool_delta_lam == null) continue
    updateTxTradeMeta(signature, trade.meta)
    patched++
    const blockTime = tx.blockTime ?? 0
    if (trade.open_side) {
      const o = trade.open_side
      const openFeeLam = c.amount_lamports
      const txKeys = tx.transaction?.message?.accountKeys ?? []
      const depIdx = txKeys.findIndex((k) => (typeof k === 'string' ? k : k.pubkey) === o.deposit_wallet)
      const depDelta = depIdx >= 0 && tx.meta
        ? tx.meta.postBalances[depIdx] - tx.meta.preBalances[depIdx]
        : 0
      const depOpenLam = -depDelta
      const poolOpenLam = -(trade.meta.pool_delta_lam ?? 0)
      const positionLam = o.leverage * o.collat_lam
      try {
        upsertWalletPair({
          trading_wallet: o.trading_wallet,
          deposit_wallet: o.deposit_wallet,
          first_seen: blockTime,
        })
        const meta = await resolveTokenMeta(o.token_mint).catch(() => null)
        const entryMcap = computeMcapSol(positionLam, o.tokens_received_raw, meta?.total_supply_raw ?? null)
        insertTradeOpen({
          open_signature: signature,
          deposit_wallet: o.deposit_wallet,
          trading_wallet: o.trading_wallet,
          token_mint: o.token_mint,
          leverage: o.leverage,
          collat_lam: o.collat_lam,
          position_lam: positionLam,
          opened_at: blockTime,
          pool_open_lam: poolOpenLam,
          dep_open_lam: depOpenLam,
          fee_open_lam: openFeeLam,
          tokens_received_raw: o.tokens_received_raw,
          entry_mcap_sol: entryMcap,
        })
      } catch (e) {
        console.warn('[amp] backfill open side-effect failed:', e instanceof Error ? e.message : e)
      }
    }
    if (trade.close_side) {
      try {
        await applyCloseSideEffect({
          closeSig: signature,
          closeTrading: trade.close_side.trading_wallet,
          blockTime,
          depRefundLam: trade.close_side.deposit_refund_lam,
          closeFeeLam: c.amount_lamports,
          poolCloseLam: trade.meta.pool_delta_lam ?? 0,
          tradingSettleDelta: trade.close_side.trading_settle_delta_lam,
        })
      } catch (e) {
        console.warn('[amp] backfill close side-effect failed:', e instanceof Error ? e.message : e)
      }
    }
  }
  console.log(`[amp] trade-meta backfill: patched ${patched}/${sigs.length} inflows`)
  return sigs.length
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
    backfillKindsOnce().catch((e) => console.error('[amp] kind backfill crashed:', e))
    backfillTradeMetaOnce().catch((e) => console.error('[amp] trade-meta backfill crashed:', e))
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
