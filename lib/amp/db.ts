import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

const DB_PATH = process.env.AMP_DB_PATH || path.join(process.cwd(), 'data', 'amp.db')

// Lazy singleton — opening the DB and running `pragma journal_mode = WAL`
// at module-import time races against itself when Next's build phase imports
// this module from multiple parallel workers, producing SQLITE_BUSY. Defer
// all side effects until first real use at runtime.
let _db: Database.Database | null = null

function open(): Database.Database {
  if (_db) return _db
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const d = new Database(DB_PATH)
  d.pragma('journal_mode = WAL')
  d.pragma('synchronous = NORMAL')
  d.exec(`
    CREATE TABLE IF NOT EXISTS amp_txs (
      signature TEXT PRIMARY KEY,
      slot INTEGER NOT NULL,
      block_time INTEGER NOT NULL,
      direction TEXT NOT NULL,
      counterparty TEXT NOT NULL,
      amount_lamports INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_amp_txs_time ON amp_txs(block_time);
    CREATE INDEX IF NOT EXISTS idx_amp_txs_dir_time ON amp_txs(direction, block_time);
    CREATE INDEX IF NOT EXISTS idx_amp_txs_cp ON amp_txs(counterparty);

    CREATE TABLE IF NOT EXISTS amp_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- One row per verification ping (~0.001 SOL → verification wallet). A wallet
    -- that pings multiple times in one period gets multiple rows; the queries
    -- collapse them by (wallet, period_start).
    CREATE TABLE IF NOT EXISTS amp_verifications (
      signature TEXT PRIMARY KEY,
      slot INTEGER NOT NULL,
      block_time INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      amount_lamports INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_amp_verif_time ON amp_verifications(block_time);
    CREATE INDEX IF NOT EXISTS idx_amp_verif_wallet ON amp_verifications(wallet);

    -- Reconstructed AMP-token balance at the period-start snapshot for each
    -- verified wallet. snapshot_raw / current_raw are stored as TEXT to avoid
    -- JS-number precision loss for big SPL amounts. forfeited=1 when the wallet
    -- has sent AMP out at any point during the period.
    CREATE TABLE IF NOT EXISTS amp_verified_balances (
      period_start INTEGER NOT NULL,
      wallet TEXT NOT NULL,
      snapshot_raw TEXT NOT NULL,
      current_raw TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      forfeited INTEGER NOT NULL,
      last_checked INTEGER NOT NULL,
      PRIMARY KEY (period_start, wallet)
    );
    CREATE INDEX IF NOT EXISTS idx_amp_verbal_period ON amp_verified_balances(period_start);

    -- Trading wallet → deposit wallet mapping. Built from open routing txs
    -- (3 signers in NEW scheme; deposit + pool sign + trading is identified by
    -- largest non-pool/dep positive SOL delta in OLD scheme). Lets us dedupe
    -- "unique users" on the dashboard, since closes have trading-wallet as
    -- counterparty but it's the same human as the deposit wallet.
    CREATE TABLE IF NOT EXISTS amp_wallet_pairs (
      trading_wallet TEXT PRIMARY KEY,
      deposit_wallet TEXT NOT NULL,
      first_seen INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_amp_wallet_pairs_dep ON amp_wallet_pairs(deposit_wallet);

    -- Trade-lifecycle rollup. One row per opened position; close information is
    -- aggregated across one OR MORE partial closes (users can take profit in
    -- pieces — e.g. sell 50% to recover initial). Each individual close event
    -- gets its own row in amp_trade_close, and amp_trade.tokens_remaining_raw
    -- counts down with each partial sale until it hits 0, at which point the
    -- position transitions to is_fully_closed=1.
    --
    -- Token amounts are stored as INTEGER; pump.fun-shaped tokens (1B × 10^6
    -- decimals = 10^15 raw) fit comfortably in INT64.
    CREATE TABLE IF NOT EXISTS amp_trade (
      open_signature TEXT PRIMARY KEY,
      deposit_wallet TEXT NOT NULL,
      trading_wallet TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      leverage INTEGER NOT NULL,
      collat_lam INTEGER NOT NULL,
      position_lam INTEGER NOT NULL,
      opened_at INTEGER NOT NULL,
      pool_open_lam INTEGER NOT NULL,
      dep_open_lam INTEGER NOT NULL,
      fee_open_lam INTEGER NOT NULL,
      tokens_received_raw INTEGER NOT NULL,
      entry_mcap_sol REAL,
      -- Aggregated across all partial closes:
      partial_close_count INTEGER NOT NULL DEFAULT 0,
      tokens_sold_raw INTEGER NOT NULL DEFAULT 0,
      tokens_remaining_raw INTEGER NOT NULL,   -- = received - sold; 0 = fully closed
      pool_close_total_lam INTEGER NOT NULL DEFAULT 0,
      dep_refund_total_lam INTEGER NOT NULL DEFAULT 0,
      fee_close_total_lam INTEGER NOT NULL DEFAULT 0,
      -- Set on the close that fully empties the position:
      is_fully_closed INTEGER NOT NULL DEFAULT 0,
      fully_closed_at INTEGER,
      final_close_signature TEXT,
      exit_mcap_sol REAL,
      is_liquidation INTEGER,
      pool_recovery_pct REAL
    );
    CREATE INDEX IF NOT EXISTS idx_amp_trade_deposit ON amp_trade(deposit_wallet);
    CREATE INDEX IF NOT EXISTS idx_amp_trade_trading ON amp_trade(trading_wallet);
    CREATE INDEX IF NOT EXISTS idx_amp_trade_token ON amp_trade(token_mint);
    CREATE INDEX IF NOT EXISTS idx_amp_trade_opened ON amp_trade(opened_at);
    CREATE INDEX IF NOT EXISTS idx_amp_trade_closed ON amp_trade(fully_closed_at);
    -- Hot-path: "find the active open trade for this trading wallet". Partial
    -- index keeps it tiny — only currently-open positions appear here.
    CREATE INDEX IF NOT EXISTS idx_amp_trade_active
      ON amp_trade(trading_wallet) WHERE is_fully_closed = 0;

    -- Per-partial-close event log. One row per close-settle tx that distributes
    -- swap proceeds out of the trading wallet. tokens_sold_raw is what was
    -- liquidated in *this* event (not the running total — that's on amp_trade).
    -- exit_mcap_sol is computed from this event's swap proceeds and tokens sold.
    CREATE TABLE IF NOT EXISTS amp_trade_close (
      close_signature TEXT PRIMARY KEY,
      open_signature TEXT NOT NULL,
      closed_at INTEGER NOT NULL,
      tokens_sold_raw INTEGER NOT NULL,
      pool_close_lam INTEGER NOT NULL,
      dep_refund_lam INTEGER NOT NULL,
      fee_close_lam INTEGER NOT NULL,
      exit_mcap_sol REAL,
      is_final INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_amp_trade_close_open ON amp_trade_close(open_signature);
    CREATE INDEX IF NOT EXISTS idx_amp_trade_close_at ON amp_trade_close(closed_at);

    -- Cached SPL token meta — symbol/name from pump.fun, decimals + total
    -- supply from getTokenSupply. Used by the live feed (symbol display) and
    -- by mcap calculations on each open/close event.
    CREATE TABLE IF NOT EXISTS amp_token_meta (
      mint TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      decimals INTEGER,
      total_supply_raw INTEGER,
      fetched_at INTEGER NOT NULL
    );
  `)

  // Idempotent column adds for schemas that predate the field. SQLite has no
  // ADD COLUMN IF NOT EXISTS, so we check via PRAGMA first.
  const cols = d.prepare(`PRAGMA table_info(amp_txs)`).all() as Array<{ name: string }>
  const has = (n: string) => cols.some((c) => c.name === n)
  if (!has('kind'))            d.exec(`ALTER TABLE amp_txs ADD COLUMN kind TEXT`)
  if (!has('pool_delta_lam'))  d.exec(`ALTER TABLE amp_txs ADD COLUMN pool_delta_lam INTEGER`)
  if (!has('is_open'))         d.exec(`ALTER TABLE amp_txs ADD COLUMN is_open INTEGER`)
  if (!has('is_liquidation'))  d.exec(`ALTER TABLE amp_txs ADD COLUMN is_liquidation INTEGER`)
  if (!has('token_mint'))      d.exec(`ALTER TABLE amp_txs ADD COLUMN token_mint TEXT`)
  if (!has('leverage'))        d.exec(`ALTER TABLE amp_txs ADD COLUMN leverage INTEGER`)
  if (!has('collat_lam'))      d.exec(`ALTER TABLE amp_txs ADD COLUMN collat_lam INTEGER`)

  _db = d
  return d
}

// Proxy lets existing `db.prepare(...)` / `db.transaction(...)` callers keep
// working with no changes — the underlying connection opens on first access.
export const db: Database.Database = new Proxy({} as Database.Database, {
  get(_, prop, receiver) {
    const target = open()
    const v = Reflect.get(target, prop, receiver)
    return typeof v === 'function' ? v.bind(target) : v
  },
})

interface Stmts {
  getState: Database.Statement<[string]>
  setState: Database.Statement<[string, string | null]>
  insertTx: Database.Statement<TxRow>
  insertTxs: (rows: TxRow[]) => void
  insertVerif: Database.Statement<VerifRow>
  insertVerifs: (rows: VerifRow[]) => void
  hasVerif: Database.Statement<[string]>
  upsertBalance: Database.Statement<VerifiedBalanceRow>
}
let _stmts: Stmts | null = null
function stmts(): Stmts {
  if (_stmts) return _stmts
  const d = open()
  const insertTx = d.prepare<TxRow>(`
    INSERT OR IGNORE INTO amp_txs
      (signature, slot, block_time, direction, counterparty, amount_lamports, kind,
       pool_delta_lam, is_open, is_liquidation, token_mint, leverage, collat_lam)
    VALUES
      (@signature, @slot, @block_time, @direction, @counterparty, @amount_lamports, @kind,
       @pool_delta_lam, @is_open, @is_liquidation, @token_mint, @leverage, @collat_lam)
  `)
  const insertVerif = d.prepare<VerifRow>(`
    INSERT OR IGNORE INTO amp_verifications (signature, slot, block_time, wallet, amount_lamports)
    VALUES (@signature, @slot, @block_time, @wallet, @amount_lamports)
  `)
  _stmts = {
    getState: d.prepare<[string]>('SELECT value FROM amp_state WHERE key = ?'),
    setState: d.prepare<[string, string | null]>(
      'INSERT INTO amp_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ),
    insertTx,
    insertTxs: d.transaction((rows: TxRow[]) => {
      for (const r of rows) insertTx.run(r)
    }),
    insertVerif,
    insertVerifs: d.transaction((rows: VerifRow[]) => {
      for (const r of rows) insertVerif.run(r)
    }),
    hasVerif: d.prepare<[string]>('SELECT 1 FROM amp_verifications WHERE signature = ?'),
    upsertBalance: d.prepare<VerifiedBalanceRow>(`
      INSERT INTO amp_verified_balances (period_start, wallet, snapshot_raw, current_raw, decimals, forfeited, last_checked)
      VALUES (@period_start, @wallet, @snapshot_raw, @current_raw, @decimals, @forfeited, @last_checked)
      ON CONFLICT(period_start, wallet) DO UPDATE SET
        snapshot_raw = excluded.snapshot_raw,
        current_raw = excluded.current_raw,
        decimals = excluded.decimals,
        forfeited = excluded.forfeited,
        last_checked = excluded.last_checked
    `),
  }
  return _stmts
}

export function getState(key: string): string | null {
  const row = stmts().getState.get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setState(key: string, value: string | number | null): void {
  stmts().setState.run(key, value == null ? null : String(value))
}

// `kind` only applies to inflows ('in'). For an inflow, it reflects what the
// counterparty (user) did with their tokens during the same tx:
//   'entry' → user gained DEX tokens (opened a position / bought)
//   'exit'  → user lost DEX tokens   (closed a position / sold)
//   'other' → ambiguous (no token movement, or both gains and losses)
// null on outflows, and null on legacy inflow rows that haven't been backfilled.
//
// Trade-meta cols (pool_delta_lam / is_open / is_liquidation / token_mint /
// leverage / collat_lam) are populated on inflow rows by the trade-meta
// extractor; null on outflows and on legacy un-backfilled inflows.
export type FeeKind = 'entry' | 'exit' | 'other'
export interface TxRow {
  signature: string
  slot: number
  block_time: number
  direction: 'in' | 'out'
  counterparty: string
  amount_lamports: number
  kind: FeeKind | null
  pool_delta_lam: number | null
  is_open: 0 | 1 | null
  is_liquidation: 0 | 1 | null
  token_mint: string | null
  leverage: number | null
  collat_lam: number | null
}

export function updateTxKind(signature: string, kind: FeeKind): void {
  open().prepare(`UPDATE amp_txs SET kind = ? WHERE signature = ?`).run(kind, signature)
}

export interface TradeMetaUpdate {
  pool_delta_lam: number | null
  is_open: 0 | 1 | null
  is_liquidation: 0 | 1 | null
  token_mint: string | null
  leverage: number | null
  collat_lam: number | null
}

export function updateTxTradeMeta(signature: string, m: TradeMetaUpdate): void {
  open().prepare(
    `UPDATE amp_txs SET
       pool_delta_lam = ?, is_open = ?, is_liquidation = ?,
       token_mint = ?, leverage = ?, collat_lam = ?
     WHERE signature = ?`
  ).run(
    m.pool_delta_lam, m.is_open, m.is_liquidation,
    m.token_mint, m.leverage, m.collat_lam, signature
  )
}

export function getInflowSignaturesMissingKind(limit: number): string[] {
  const rows = open().prepare(
    `SELECT signature FROM amp_txs
     WHERE direction='in' AND kind IS NULL
     ORDER BY block_time DESC LIMIT ?`
  ).all(limit) as Array<{ signature: string }>
  return rows.map((r) => r.signature)
}

export function getInflowSignaturesMissingTradeMeta(limit: number): string[] {
  const rows = open().prepare(
    `SELECT signature FROM amp_txs
     WHERE direction='in' AND pool_delta_lam IS NULL
     ORDER BY block_time DESC LIMIT ?`
  ).all(limit) as Array<{ signature: string }>
  return rows.map((r) => r.signature)
}

// ---- Wallet pair (trading → deposit) ----

export interface WalletPair {
  trading_wallet: string
  deposit_wallet: string
  first_seen: number
}

export function upsertWalletPair(p: WalletPair): void {
  open().prepare(
    `INSERT INTO amp_wallet_pairs (trading_wallet, deposit_wallet, first_seen)
     VALUES (?, ?, ?)
     ON CONFLICT(trading_wallet) DO UPDATE SET
       deposit_wallet = excluded.deposit_wallet,
       first_seen = MIN(amp_wallet_pairs.first_seen, excluded.first_seen)`
  ).run(p.trading_wallet, p.deposit_wallet, p.first_seen)
}

export function getDepositForTrading(trading: string): string | null {
  const r = open().prepare(
    `SELECT deposit_wallet FROM amp_wallet_pairs WHERE trading_wallet = ?`
  ).get(trading) as { deposit_wallet: string } | undefined
  return r ? r.deposit_wallet : null
}

// ---- Trade lifecycle ----
// Two-table model: amp_trade is the position (one row per open), amp_trade_close
// is the per-close-event log (N rows per amp_trade — supports partial closes).
//
// Per-user / per-token aggregates can be answered by amp_trade alone (it has
// running totals); per-close detail comes from amp_trade_close.

export interface TradeOpen {
  open_signature: string
  deposit_wallet: string
  trading_wallet: string
  token_mint: string
  leverage: number
  collat_lam: number
  position_lam: number
  opened_at: number
  pool_open_lam: number
  dep_open_lam: number
  fee_open_lam: number
  tokens_received_raw: number
  entry_mcap_sol: number | null
}

export interface PartialClose {
  close_signature: string
  closed_at: number
  tokens_sold_raw: number
  pool_close_lam: number
  dep_refund_lam: number
  fee_close_lam: number
  exit_mcap_sol: number | null
  is_final: 0 | 1
}

export interface TradeRow {
  open_signature: string
  deposit_wallet: string
  trading_wallet: string
  token_mint: string
  leverage: number
  collat_lam: number
  position_lam: number
  opened_at: number
  pool_open_lam: number
  dep_open_lam: number
  fee_open_lam: number
  tokens_received_raw: number
  entry_mcap_sol: number | null
  partial_close_count: number
  tokens_sold_raw: number
  tokens_remaining_raw: number
  pool_close_total_lam: number
  dep_refund_total_lam: number
  fee_close_total_lam: number
  is_fully_closed: 0 | 1
  fully_closed_at: number | null
  final_close_signature: string | null
  exit_mcap_sol: number | null
  is_liquidation: 0 | 1 | null
  pool_recovery_pct: number | null
}

export function insertTradeOpen(t: TradeOpen): void {
  open().prepare(
    `INSERT OR IGNORE INTO amp_trade
       (open_signature, deposit_wallet, trading_wallet, token_mint, leverage,
        collat_lam, position_lam, opened_at, pool_open_lam, dep_open_lam, fee_open_lam,
        tokens_received_raw, entry_mcap_sol, tokens_remaining_raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    t.open_signature, t.deposit_wallet, t.trading_wallet, t.token_mint, t.leverage,
    t.collat_lam, t.position_lam, t.opened_at, t.pool_open_lam, t.dep_open_lam, t.fee_open_lam,
    t.tokens_received_raw, t.entry_mcap_sol, t.tokens_received_raw  // remaining starts == received
  )
}

// Find the active (still-open) trade for a given trading wallet. Uses the
// partial index on (trading_wallet) WHERE is_fully_closed = 0.
export function getActiveTradeForTrading(trading: string): TradeRow | null {
  const r = open().prepare(
    `SELECT * FROM amp_trade
     WHERE trading_wallet = ? AND is_fully_closed = 0
     ORDER BY opened_at DESC LIMIT 1`
  ).get(trading) as TradeRow | undefined
  return r ?? null
}

// Apply a partial (or final) close event to a trade. Atomically:
//   1. INSERT amp_trade_close row
//   2. UPDATE amp_trade aggregates (tokens_sold, tokens_remaining, totals)
//   3. If is_final=1: also flip is_fully_closed and set final_* fields
// Wrapped in a transaction so partial state can't leak.
export function applyTradeClose(args: {
  open_signature: string
  partial: PartialClose
  pool_open_lam: number  // for pool_recovery_pct on final close
  is_liquidation_final: 0 | 1 | null  // null if not final
}): void {
  const d = open()
  const insertClose = d.prepare(
    `INSERT OR IGNORE INTO amp_trade_close
       (close_signature, open_signature, closed_at, tokens_sold_raw,
        pool_close_lam, dep_refund_lam, fee_close_lam, exit_mcap_sol, is_final)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const updateAggregate = d.prepare(
    `UPDATE amp_trade SET
       partial_close_count = partial_close_count + 1,
       tokens_sold_raw = tokens_sold_raw + ?,
       tokens_remaining_raw = tokens_remaining_raw - ?,
       pool_close_total_lam = pool_close_total_lam + ?,
       dep_refund_total_lam = dep_refund_total_lam + ?,
       fee_close_total_lam = fee_close_total_lam + ?
     WHERE open_signature = ?`
  )
  const updateFinal = d.prepare(
    `UPDATE amp_trade SET
       is_fully_closed = 1,
       fully_closed_at = ?,
       final_close_signature = ?,
       exit_mcap_sol = ?,
       is_liquidation = ?,
       pool_recovery_pct = CASE WHEN ? > 0 THEN (CAST(pool_close_total_lam AS REAL) / ?) * 100 ELSE NULL END
     WHERE open_signature = ?`
  )
  d.transaction((p: PartialClose) => {
    insertClose.run(
      p.close_signature, args.open_signature, p.closed_at, p.tokens_sold_raw,
      p.pool_close_lam, p.dep_refund_lam, p.fee_close_lam, p.exit_mcap_sol, p.is_final
    )
    updateAggregate.run(
      p.tokens_sold_raw, p.tokens_sold_raw,
      p.pool_close_lam, p.dep_refund_lam, p.fee_close_lam,
      args.open_signature
    )
    if (p.is_final === 1) {
      updateFinal.run(
        p.closed_at, p.close_signature, p.exit_mcap_sol,
        args.is_liquidation_final ?? 0,
        args.pool_open_lam, args.pool_open_lam,
        args.open_signature
      )
    }
  })(args.partial)
}

// ---- Token meta cache ----

export interface TokenMeta {
  mint: string
  symbol: string | null
  name: string | null
  decimals: number | null
  total_supply_raw: number | null
  fetched_at: number
}

export function upsertTokenMeta(m: TokenMeta): void {
  // COALESCE merges in any newly-known fields without clobbering existing
  // non-null ones (resolveTokenMeta calls separately for symbol vs supply).
  open().prepare(
    `INSERT INTO amp_token_meta (mint, symbol, name, decimals, total_supply_raw, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET
       symbol = COALESCE(excluded.symbol, amp_token_meta.symbol),
       name = COALESCE(excluded.name, amp_token_meta.name),
       decimals = COALESCE(excluded.decimals, amp_token_meta.decimals),
       total_supply_raw = COALESCE(excluded.total_supply_raw, amp_token_meta.total_supply_raw),
       fetched_at = excluded.fetched_at`
  ).run(m.mint, m.symbol, m.name, m.decimals, m.total_supply_raw, m.fetched_at)
}

export function getTokenMeta(mint: string): TokenMeta | null {
  const r = open().prepare(`SELECT * FROM amp_token_meta WHERE mint = ?`).get(mint) as TokenMeta | undefined
  return r ?? null
}

export function getTokenMetaBatch(mints: string[]): Map<string, TokenMeta> {
  if (mints.length === 0) return new Map()
  const placeholders = mints.map(() => '?').join(',')
  const rows = open().prepare(
    `SELECT * FROM amp_token_meta WHERE mint IN (${placeholders})`
  ).all(...mints) as TokenMeta[]
  return new Map(rows.map((r) => [r.mint, r]))
}

export function insertTxs(rows: TxRow[]): void {
  stmts().insertTxs(rows)
}

export function countTxs(): number {
  return (open().prepare('SELECT COUNT(*) AS c FROM amp_txs').get() as { c: number }).c
}

export function hasSignature(signature: string): boolean {
  return open().prepare('SELECT 1 FROM amp_txs WHERE signature = ?').get(signature) != null
}

export interface VerifRow {
  signature: string
  slot: number
  block_time: number
  wallet: string
  amount_lamports: number
}

export function insertVerifications(rows: VerifRow[]): void {
  stmts().insertVerifs(rows)
}

export function hasVerification(signature: string): boolean {
  return stmts().hasVerif.get(signature) != null
}

export function countVerifications(): number {
  return (open().prepare('SELECT COUNT(*) AS c FROM amp_verifications').get() as { c: number }).c
}

// Every wallet that has ever pinged the verification address. A single ping
// opts a wallet in for all subsequent periods — they only lose eligibility
// for a given week by selling/transferring during that week. Returns the
// most recent ping timestamp per wallet so the recompute job can decide
// whether a freshness skip is allowed.
export function allVerifiedWallets(): Array<{ wallet: string; lastPing: number }> {
  const rows = open().prepare(
    `SELECT wallet, MAX(block_time) AS last_ping
     FROM amp_verifications GROUP BY wallet`
  ).all() as Array<{ wallet: string; last_ping: number }>
  return rows.map((r) => ({ wallet: r.wallet, lastPing: r.last_ping }))
}

export interface VerifiedBalanceRow {
  period_start: number
  wallet: string
  snapshot_raw: string
  current_raw: string
  decimals: number
  forfeited: number
  last_checked: number
}

export function upsertVerifiedBalance(row: VerifiedBalanceRow): void {
  stmts().upsertBalance.run(row)
}

export function getVerifiedBalances(periodStart: number): VerifiedBalanceRow[] {
  return open().prepare(
    `SELECT period_start, wallet, snapshot_raw, current_raw, decimals, forfeited, last_checked
     FROM amp_verified_balances WHERE period_start = ?`
  ).all(periodStart) as VerifiedBalanceRow[]
}
