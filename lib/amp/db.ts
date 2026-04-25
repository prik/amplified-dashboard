import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

const DB_PATH = process.env.AMP_DB_PATH || path.join(process.cwd(), 'data', 'amp.db')
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

export const db: Database.Database = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

db.exec(`
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

const getStateStmt = db.prepare<[string]>('SELECT value FROM amp_state WHERE key = ?')
const setStateStmt = db.prepare<[string, string | null]>(
  'INSERT INTO amp_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
)

export function getState(key: string): string | null {
  const row = getStateStmt.get(key) as { value: string } | undefined
  return row ? row.value : null
}

export function setState(key: string, value: string | number | null): void {
  setStateStmt.run(key, value == null ? null : String(value))
}

export interface TxRow {
  signature: string
  slot: number
  block_time: number
  direction: 'in' | 'out'
  counterparty: string
  amount_lamports: number
}

const insertTxStmt = db.prepare<TxRow>(`
  INSERT OR IGNORE INTO amp_txs (signature, slot, block_time, direction, counterparty, amount_lamports)
  VALUES (@signature, @slot, @block_time, @direction, @counterparty, @amount_lamports)
`)

export const insertTxs: (rows: TxRow[]) => void = db.transaction((rows: TxRow[]) => {
  for (const r of rows) insertTxStmt.run(r)
})

export function countTxs(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM amp_txs').get() as { c: number }).c
}

export function hasSignature(signature: string): boolean {
  return db.prepare('SELECT 1 FROM amp_txs WHERE signature = ?').get(signature) != null
}
