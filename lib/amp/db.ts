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
  `)
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
    INSERT OR IGNORE INTO amp_txs (signature, slot, block_time, direction, counterparty, amount_lamports)
    VALUES (@signature, @slot, @block_time, @direction, @counterparty, @amount_lamports)
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

export interface TxRow {
  signature: string
  slot: number
  block_time: number
  direction: 'in' | 'out'
  counterparty: string
  amount_lamports: number
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
