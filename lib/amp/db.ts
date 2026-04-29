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
}
let _stmts: Stmts | null = null
function stmts(): Stmts {
  if (_stmts) return _stmts
  const d = open()
  const insertTx = d.prepare<TxRow>(`
    INSERT OR IGNORE INTO amp_txs (signature, slot, block_time, direction, counterparty, amount_lamports)
    VALUES (@signature, @slot, @block_time, @direction, @counterparty, @amount_lamports)
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
