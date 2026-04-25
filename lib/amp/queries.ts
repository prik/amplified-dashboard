import { db, getState } from './db'
import { OPERATOR_WALLETS, POOL_WALLET, FEE_WALLET, LAUNCH_TS_SEC, TOTAL_SUPPLY_FALLBACK } from './config'

export const LAMPORTS_PER_SOL = 1_000_000_000
export const lamToSol = (lam: number | bigint): number => Number(lam) / LAMPORTS_PER_SOL

export type Range = '24h' | '7d' | '30d' | 'all'

// Unix-seconds timestamp of the most recent Friday 00:00 UTC. The weekly
// revshare payout happens on Fridays, so this is the start of the current
// accrual window. If today is Friday, returns today 00:00 UTC.
export function lastFridayUtcSec(): number {
  const now = new Date()
  const utcMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const dow = new Date(utcMidnightMs).getUTCDay() // 0=Sun..5=Fri..6=Sat
  const daysSinceFriday = (dow - 5 + 7) % 7
  return Math.floor((utcMidnightMs - daysSinceFriday * 86400_000) / 1000)
}

// Time range windows are clamped to the launch timestamp. A range of "all"
// becomes "since launch", not "since epoch".
export function rangeToWindow(range: string): { from: number; to: number } {
  const now = Math.floor(Date.now() / 1000)
  const day = 86400
  let from: number
  switch (range) {
    case '24h': from = now - day; break
    case '7d':  from = now - 7 * day; break
    case '30d': from = now - 30 * day; break
    default:    from = 0
  }
  return { from: Math.max(from, LAUNCH_TS_SEC), to: now }
}

// Operator / pool exclusion helpers.
//   `payout` = outflows counted as user payouts (everything except operator + pool)
//   `trader` = inflow counterparties counted as real traders (exclude pool — it's not a person)
function excludedForPayouts(): string[] {
  const out: string[] = [...OPERATOR_WALLETS]
  if (POOL_WALLET) out.push(POOL_WALLET)
  return out
}
function excludedForTraders(): string[] {
  return POOL_WALLET ? [POOL_WALLET] : []
}

function notInClause(col: string, addresses: string[]): { sql: string; params: string[] } {
  if (addresses.length === 0) return { sql: '', params: [] }
  const placeholders = addresses.map(() => '?').join(',')
  return { sql: ` AND ${col} NOT IN (${placeholders})`, params: addresses }
}
function inClause(col: string, addresses: string[]): { sql: string; params: string[] } {
  if (addresses.length === 0) return { sql: '', params: [] }
  const placeholders = addresses.map(() => '?').join(',')
  return { sql: ` AND ${col} IN (${placeholders})`, params: addresses }
}

// ---- Summary ----

export interface Summary {
  feeWallet: string
  launchTs: number
  price: number | null
  totals: {
    revenueSol: number
    userPayoutsSol: number
    operatorOutflowsSol: number
    poolOutflowsSol: number
    feeEvents: number
    payoutEvents: number
    uniqueDepositors: number
    uniquePayees: number
  }
  window: {
    range: string
    from: number
    to: number
    revenueSol: number
    userPayoutsSol: number
    operatorOutflowsSol: number
    poolOutflowsSol: number
    feeEvents: number
    payoutEvents: number
    uniqueDepositors: number
    revenueDeltaPct: number | null
    uniqueDepositorsDelta: number
  }
  treasurySol: number | null
  indexed: number
  totalSupply: number
  lastPayout: { at: number; sol: number; recipients: number } | null
  // Revenue & outflow accrual since the most recent Friday 00:00 UTC. This is
  // the window during which the next weekly payout pool is accumulating.
  sinceFriday: {
    from: number
    revenueSol: number
    userPayoutsSol: number
    operatorOutflowsSol: number
    poolOutflowsSol: number
    feeEvents: number
  }
}

export function buildSummary(range: string, price: number | null, treasurySol: number | null): Summary {
  const { from, to } = rangeToWindow(range)

  const notPayout = notInClause('counterparty', excludedForPayouts())
  const notPool = notInClause('counterparty', excludedForTraders())
  const isOp = inClause('counterparty', [...OPERATOR_WALLETS])
  const isPool = POOL_WALLET ? ` AND counterparty=?` : ''

  // All-time (launch-constrained)
  const inAll = db.prepare(
    `SELECT COALESCE(SUM(amount_lamports),0) AS s, COUNT(*) AS n FROM amp_txs
     WHERE direction='in' AND block_time >= ?`
  ).get(LAUNCH_TS_SEC) as { s: number; n: number }

  const payoutsAll = db.prepare(
    `SELECT COALESCE(SUM(amount_lamports),0) AS s, COUNT(*) AS n FROM amp_txs
     WHERE direction='out' AND block_time >= ?${notPayout.sql}`
  ).get(LAUNCH_TS_SEC, ...notPayout.params) as { s: number; n: number }

  const operatorAll = OPERATOR_WALLETS.size === 0 ? { s: 0 } : (
    db.prepare(
      `SELECT COALESCE(SUM(amount_lamports),0) AS s FROM amp_txs
       WHERE direction='out' AND block_time >= ?${isOp.sql}`
    ).get(LAUNCH_TS_SEC, ...isOp.params) as { s: number }
  )

  const poolAll = !POOL_WALLET ? { s: 0 } : (
    db.prepare(
      `SELECT COALESCE(SUM(amount_lamports),0) AS s FROM amp_txs
       WHERE direction='out' AND block_time >= ?${isPool}`
    ).get(LAUNCH_TS_SEC, POOL_WALLET) as { s: number }
  )

  // Window
  const inWin = db.prepare(
    `SELECT COALESCE(SUM(amount_lamports),0) AS s, COUNT(*) AS n FROM amp_txs
     WHERE direction='in' AND block_time BETWEEN ? AND ?`
  ).get(from, to) as { s: number; n: number }

  const payoutsWin = db.prepare(
    `SELECT COALESCE(SUM(amount_lamports),0) AS s, COUNT(*) AS n FROM amp_txs
     WHERE direction='out' AND block_time BETWEEN ? AND ?${notPayout.sql}`
  ).get(from, to, ...notPayout.params) as { s: number; n: number }

  const operatorWin = OPERATOR_WALLETS.size === 0 ? { s: 0 } : (
    db.prepare(
      `SELECT COALESCE(SUM(amount_lamports),0) AS s FROM amp_txs
       WHERE direction='out' AND block_time BETWEEN ? AND ?${isOp.sql}`
    ).get(from, to, ...isOp.params) as { s: number }
  )

  const poolWin = !POOL_WALLET ? { s: 0 } : (
    db.prepare(
      `SELECT COALESCE(SUM(amount_lamports),0) AS s FROM amp_txs
       WHERE direction='out' AND block_time BETWEEN ? AND ?${isPool}`
    ).get(from, to, POOL_WALLET) as { s: number }
  )

  // Unique traders (excludes pool since pool isn't a trader)
  const uniqueIn = (
    db.prepare(
      `SELECT COUNT(DISTINCT counterparty) AS n FROM amp_txs
       WHERE direction='in' AND block_time >= ?${notPool.sql}`
    ).get(LAUNCH_TS_SEC, ...notPool.params) as { n: number }
  ).n

  const uniqueOut = (
    db.prepare(
      `SELECT COUNT(DISTINCT counterparty) AS n FROM amp_txs
       WHERE direction='out' AND block_time >= ?${notPayout.sql}`
    ).get(LAUNCH_TS_SEC, ...notPayout.params) as { n: number }
  ).n

  const uniqueInWin = (
    db.prepare(
      `SELECT COUNT(DISTINCT counterparty) AS n FROM amp_txs
       WHERE direction='in' AND block_time BETWEEN ? AND ?${notPool.sql}`
    ).get(from, to, ...notPool.params) as { n: number }
  ).n

  // Prior-window deltas for headline KPIs
  const winLen = to - from
  const prevTo = from
  const prevFrom = Math.max(LAUNCH_TS_SEC, from - winLen)
  const inPrev = (
    db.prepare(
      `SELECT COALESCE(SUM(amount_lamports),0) AS s FROM amp_txs
       WHERE direction='in' AND block_time BETWEEN ? AND ?`
    ).get(prevFrom, prevTo) as { s: number }
  ).s
  const uniqInPrev = (
    db.prepare(
      `SELECT COUNT(DISTINCT counterparty) AS n FROM amp_txs
       WHERE direction='in' AND block_time BETWEEN ? AND ?${notPool.sql}`
    ).get(prevFrom, prevTo, ...notPool.params) as { n: number }
  ).n

  const indexedPostLaunch = (
    db.prepare(`SELECT COUNT(*) AS c FROM amp_txs WHERE block_time >= ?`).get(LAUNCH_TS_SEC) as { c: number }
  ).c

  // Most-recent user-payout batch. Payouts happen weekly; group by block_time
  // rounded to the hour so a single Friday-distribution batch across several
  // txs reads as one event.
  const lastPayoutRow = db.prepare(
    `SELECT block_time FROM amp_txs
     WHERE direction='out' AND block_time >= ?${notPayout.sql}
     ORDER BY block_time DESC LIMIT 1`
  ).get(LAUNCH_TS_SEC, ...notPayout.params) as { block_time: number } | undefined

  // Accrual window since last Friday 00:00 UTC (never older than launch).
  const fridayFrom = Math.max(LAUNCH_TS_SEC, lastFridayUtcSec())
  const nowSec = Math.floor(Date.now() / 1000)
  const inSinceFri = db.prepare(
    `SELECT COALESCE(SUM(amount_lamports),0) AS s, COUNT(*) AS n FROM amp_txs
     WHERE direction='in' AND block_time BETWEEN ? AND ?`
  ).get(fridayFrom, nowSec) as { s: number; n: number }
  const payoutsSinceFri = db.prepare(
    `SELECT COALESCE(SUM(amount_lamports),0) AS s FROM amp_txs
     WHERE direction='out' AND block_time BETWEEN ? AND ?${notPayout.sql}`
  ).get(fridayFrom, nowSec, ...notPayout.params) as { s: number }
  const operatorSinceFri = OPERATOR_WALLETS.size === 0 ? { s: 0 } : (
    db.prepare(
      `SELECT COALESCE(SUM(amount_lamports),0) AS s FROM amp_txs
       WHERE direction='out' AND block_time BETWEEN ? AND ?${isOp.sql}`
    ).get(fridayFrom, nowSec, ...isOp.params) as { s: number }
  )
  const poolSinceFri = !POOL_WALLET ? { s: 0 } : (
    db.prepare(
      `SELECT COALESCE(SUM(amount_lamports),0) AS s FROM amp_txs
       WHERE direction='out' AND block_time BETWEEN ? AND ?${isPool}`
    ).get(fridayFrom, nowSec, POOL_WALLET) as { s: number }
  )

  let lastPayout: Summary['lastPayout'] = null
  if (lastPayoutRow) {
    const anchor = lastPayoutRow.block_time
    // Batch = anything within 6 hours of the anchor (covers distribution spread).
    const batch = db.prepare(
      `SELECT COALESCE(SUM(amount_lamports), 0) AS s,
              COUNT(DISTINCT counterparty) AS r,
              MAX(block_time) AS t
       FROM amp_txs
       WHERE direction='out' AND block_time BETWEEN ? AND ?${notPayout.sql}`
    ).get(anchor - 6 * 3600, anchor + 1, ...notPayout.params) as { s: number; r: number; t: number }
    lastPayout = { at: batch.t, sol: lamToSol(batch.s), recipients: batch.r }
  }

  return {
    feeWallet: FEE_WALLET,
    launchTs: LAUNCH_TS_SEC,
    price,
    totals: {
      revenueSol: lamToSol(inAll.s),
      userPayoutsSol: lamToSol(payoutsAll.s),
      operatorOutflowsSol: lamToSol(operatorAll.s),
      poolOutflowsSol: lamToSol(poolAll.s),
      feeEvents: inAll.n,
      payoutEvents: payoutsAll.n,
      uniqueDepositors: uniqueIn,
      uniquePayees: uniqueOut,
    },
    window: {
      range,
      from,
      to,
      revenueSol: lamToSol(inWin.s),
      userPayoutsSol: lamToSol(payoutsWin.s),
      operatorOutflowsSol: lamToSol(operatorWin.s),
      poolOutflowsSol: lamToSol(poolWin.s),
      feeEvents: inWin.n,
      payoutEvents: payoutsWin.n,
      uniqueDepositors: uniqueInWin,
      revenueDeltaPct: inPrev > 0 ? ((inWin.s - inPrev) / inPrev) * 100 : null,
      uniqueDepositorsDelta: uniqueInWin - uniqInPrev,
    },
    treasurySol,
    indexed: indexedPostLaunch,
    totalSupply: (() => {
      const cached = getState('token_supply')
      const n = cached ? Number(cached) : NaN
      return Number.isFinite(n) && n > 0 ? n : TOTAL_SUPPLY_FALLBACK
    })(),
    lastPayout,
    sinceFriday: {
      from: fridayFrom,
      revenueSol: lamToSol(inSinceFri.s),
      userPayoutsSol: lamToSol(payoutsSinceFri.s),
      operatorOutflowsSol: lamToSol(operatorSinceFri.s),
      poolOutflowsSol: lamToSol(poolSinceFri.s),
      feeEvents: inSinceFri.n,
    },
  }
}

// ---- Timeseries ----

export function buildTimeseries(range: string) {
  const { from, to } = rangeToWindow(range)
  // Hourly only for the 24h view; everything wider gets daily bars (less
  // noisy and a clearer at-a-glance read).
  const bucket = (to - from) <= 86400 ? 3600 : 86400

  const excludedPayout = excludedForPayouts()
  const outFilter = excludedPayout.length > 0
    ? `direction='out' AND counterparty NOT IN (${excludedPayout.map(() => '?').join(',')})`
    : `direction='out'`

  // Inline the bucket size as a literal (it's a local constant, not user input)
  // because bound `?` parameters were being treated as REAL by SQLite, turning
  // `block_time / ?` into floating-point division — which preserved sub-day
  // resolution instead of bucketing to day boundaries.
  const sql = `
    SELECT
      (block_time / ${bucket}) * ${bucket} AS bucket,
      SUM(CASE WHEN direction='in' THEN amount_lamports ELSE 0 END) AS in_lam,
      SUM(CASE WHEN ${outFilter} THEN amount_lamports ELSE 0 END) AS out_lam,
      SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) AS in_n,
      SUM(CASE WHEN ${outFilter} THEN 1 ELSE 0 END) AS out_n
    FROM amp_txs
    WHERE block_time BETWEEN ? AND ?
    GROUP BY bucket
    ORDER BY bucket
  `
  const params = [...excludedPayout, ...excludedPayout, from, to]
  const rows = db.prepare(sql).all(...params) as Array<{
    bucket: number; in_lam: number; out_lam: number; in_n: number; out_n: number
  }>

  return {
    bucket,
    points: rows.map((r) => ({
      t: r.bucket,
      revenueSol: lamToSol(r.in_lam),
      payoutsSol: lamToSol(r.out_lam),
      feeEvents: r.in_n,
      payoutEvents: r.out_n,
    })),
  }
}

// ---- Leaderboard ----
// Pool is excluded — it isn't an individual trader.

export function buildLeaderboard(limit: number) {
  const n = Math.min(Math.max(1, limit), 200)
  const notPool = notInClause('counterparty', excludedForTraders())
  const rows = db.prepare(
    `SELECT counterparty AS wallet, SUM(amount_lamports) AS total_lam, COUNT(*) AS trades,
            MIN(block_time) AS first_seen, MAX(block_time) AS last_seen
     FROM amp_txs
     WHERE direction='in' AND block_time >= ?${notPool.sql}
     GROUP BY counterparty ORDER BY total_lam DESC LIMIT ?`
  ).all(LAUNCH_TS_SEC, ...notPool.params, n) as Array<{
    wallet: string; total_lam: number; trades: number; first_seen: number; last_seen: number
  }>
  return {
    rows: rows.map((r, i) => ({
      rank: i + 1,
      wallet: r.wallet,
      feesSol: lamToSol(r.total_lam),
      trades: r.trades,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    })),
  }
}

// ---- Heatmap ----

export function buildHeatmap(range: string) {
  const { from, to } = rangeToWindow(range)
  const rows = db.prepare(
    `SELECT CAST(strftime('%w', block_time, 'unixepoch') AS INTEGER) AS dow,
            CAST(strftime('%H', block_time, 'unixepoch') AS INTEGER) AS hour,
            COUNT(*) AS n
     FROM amp_txs WHERE direction='in' AND block_time BETWEEN ? AND ?
     GROUP BY dow, hour`
  ).all(from, to) as Array<{ dow: number; hour: number; n: number }>
  return { cells: rows }
}

// ---- New users per day ----
// First-ever-deposit (post-launch) per wallet, excluding the pool.

export function buildNewUsers(range: string) {
  const { from, to } = rangeToWindow(range)
  const notPool = excludedForTraders()
  const notPoolFilter = notPool.length > 0 ? `AND counterparty NOT IN (${notPool.map(() => '?').join(',')})` : ''
  const rows = db.prepare(
    `SELECT day, COUNT(*) AS n FROM (
       SELECT counterparty, MIN(block_time) AS first_seen,
              DATE(MIN(block_time), 'unixepoch') AS day
       FROM amp_txs
       WHERE direction='in' AND block_time >= ? ${notPoolFilter}
       GROUP BY counterparty
     )
     WHERE first_seen BETWEEN ? AND ?
     GROUP BY day ORDER BY day`
  ).all(LAUNCH_TS_SEC, ...notPool, from, to) as Array<{ day: string; n: number }>
  return { days: rows }
}

// ---- Fee distribution ----

export function buildDistribution() {
  const notPool = excludedForTraders()
  const notPoolFilter = notPool.length > 0 ? `AND counterparty NOT IN (${notPool.map(() => '?').join(',')})` : ''
  const rows = db.prepare(
    `SELECT amount_lamports AS lam FROM amp_txs
     WHERE direction='in' AND block_time >= ? ${notPoolFilter} ORDER BY lam`
  ).all(LAUNCH_TS_SEC, ...notPool) as Array<{ lam: number }>
  const sols = rows.map((r) => lamToSol(r.lam))
  const n = sols.length
  const pct = (p: number) => (n === 0 ? 0 : sols[Math.min(n - 1, Math.floor(p * n))])
  const edges = [0, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, Infinity]
  const buckets = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1] === Infinity ? null : edges[i + 1], n: 0 }))
  for (const s of sols) {
    const idx = buckets.findIndex((b) => s >= b.lo && (b.hi === null || s < b.hi))
    if (idx >= 0) buckets[idx].n++
  }
  return {
    count: n,
    median: pct(0.5),
    p95: pct(0.95),
    max: n === 0 ? 0 : sols[n - 1],
    buckets,
  }
}

// ---- Whale share ----

export function buildWhaleShare() {
  const notPool = excludedForTraders()
  const notPoolFilter = notPool.length > 0 ? `AND counterparty NOT IN (${notPool.map(() => '?').join(',')})` : ''
  const rows = db.prepare(
    `SELECT counterparty, SUM(amount_lamports) AS s FROM amp_txs
     WHERE direction='in' AND block_time >= ? ${notPoolFilter}
     GROUP BY counterparty ORDER BY s DESC`
  ).all(LAUNCH_TS_SEC, ...notPool) as Array<{ counterparty: string; s: number }>
  const total = rows.reduce((a, r) => a + Number(r.s), 0)
  const share = (frac: number) => {
    const k = Math.max(1, Math.ceil(rows.length * frac))
    const slice = rows.slice(0, k).reduce((a, r) => a + Number(r.s), 0)
    return total > 0 ? slice / total : 0
  }
  return {
    wallets: rows.length,
    top1Pct: share(0.01),
    top5Pct: share(0.05),
    top10Pct: share(0.1),
  }
}

// ---- Retention ----

// Per-window retention. A wallet is "eligible" for the Nd cohort only if its
// first deposit is old enough that a full Nd return window could complete —
// otherwise we'd under-count. With separate cutoffs the 7d number stays
// meaningful even when the project itself is younger than 30 days.
export function buildRetention() {
  const now = Math.floor(Date.now() / 1000)
  const notPool = excludedForTraders()
  const notPoolFilter = notPool.length > 0 ? `AND counterparty NOT IN (${notPool.map(() => '?').join(',')})` : ''

  function cohortFor(windowDays: number) {
    const cutoff = now - windowDays * 86400
    const row = db.prepare(
      `WITH first AS (
         SELECT counterparty AS w, MIN(block_time) AS t0
         FROM amp_txs WHERE direction='in' AND block_time >= ? ${notPoolFilter}
         GROUP BY counterparty
       )
       SELECT COUNT(*) AS cohort,
              SUM(CASE WHEN EXISTS (
                SELECT 1 FROM amp_txs x WHERE x.direction='in' AND x.counterparty=first.w
                  AND x.block_time > first.t0 + 3600 AND x.block_time <= first.t0 + ? * 86400
              ) THEN 1 ELSE 0 END) AS ret
       FROM first WHERE first.t0 <= ?`
    ).get(LAUNCH_TS_SEC, ...notPool, windowDays, cutoff) as { cohort: number; ret: number }
    return { cohort: row.cohort || 0, ret: row.ret || 0 }
  }

  const r7 = cohortFor(7)
  const r30 = cohortFor(30)

  return {
    cohort7d: r7.cohort,
    cohort30d: r30.cohort,
    return7dPct: r7.cohort > 0 ? (r7.ret / r7.cohort) * 100 : null,
    return30dPct: r30.cohort > 0 ? (r30.ret / r30.cohort) * 100 : null,
  }
}

// ---- Trade-frequency distribution ----
// Histogram of "how many fees has each unique wallet paid?" — bucketed into
// engagement tiers. Tells us how sticky Amplified is: lots of 1-and-done
// wallets vs power users grinding 50+ trades.

export function buildTradeFrequency() {
  const notPool = excludedForTraders()
  const notPoolFilter = notPool.length > 0 ? `AND counterparty NOT IN (${notPool.map(() => '?').join(',')})` : ''

  const rows = db.prepare(
    `SELECT counterparty, COUNT(*) AS n FROM amp_txs
     WHERE direction='in' AND block_time >= ? ${notPoolFilter}
     GROUP BY counterparty`
  ).all(LAUNCH_TS_SEC, ...notPool) as Array<{ counterparty: string; n: number }>

  const buckets = [
    { label: '1', lo: 1,  hi: 1,        n: 0 },
    { label: '2–5', lo: 2,  hi: 5,      n: 0 },
    { label: '6–20', lo: 6, hi: 20,     n: 0 },
    { label: '21–50', lo: 21, hi: 50,   n: 0 },
    { label: '50+', lo: 51, hi: Infinity, n: 0 },
  ]
  for (const r of rows) {
    const b = buckets.find((b) => r.n >= b.lo && r.n <= b.hi)
    if (b) b.n++
  }
  const totalUsers = rows.length
  return {
    totalUsers,
    medianTrades: rows.length === 0
      ? 0
      : rows.map((r) => r.n).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
    powerUserPct: totalUsers === 0 ? 0 : (rows.filter((r) => r.n >= 21).length / totalUsers) * 100,
    buckets: buckets.map((b) => ({
      label: b.label,
      count: b.n,
      pct: totalUsers === 0 ? 0 : (b.n / totalUsers) * 100,
    })),
  }
}

// ---- Lifetime cumulative growth ----
// Returns one row per UTC-day since launch with both per-day and running-total
// figures for adoption charts. Cumulative user count is based on first-deposit
// day for each wallet (pool excluded).

export function buildLifetime() {
  const now = Math.floor(Date.now() / 1000)
  const notPool = excludedForTraders()
  const notPoolFilter = notPool.length > 0 ? `AND counterparty NOT IN (${notPool.map(() => '?').join(',')})` : ''

  // Daily revenue + fee count (counterparty-agnostic for inflows).
  const rev = db.prepare(
    `SELECT DATE(block_time, 'unixepoch') AS day,
            SUM(amount_lamports) AS lam,
            COUNT(*) AS n
     FROM amp_txs
     WHERE direction='in' AND block_time >= ?
     GROUP BY day ORDER BY day`
  ).all(LAUNCH_TS_SEC) as Array<{ day: string; lam: number; n: number }>

  // Daily new users (wallets whose first post-launch deposit is on that day).
  const newU = db.prepare(
    `SELECT day, COUNT(*) AS n FROM (
       SELECT counterparty, DATE(MIN(block_time), 'unixepoch') AS day
       FROM amp_txs
       WHERE direction='in' AND block_time >= ? ${notPoolFilter}
       GROUP BY counterparty
     ) GROUP BY day ORDER BY day`
  ).all(LAUNCH_TS_SEC, ...notPool) as Array<{ day: string; n: number }>

  // Daily active users (distinct depositing wallets that day, pool excluded).
  const dau = db.prepare(
    `SELECT DATE(block_time, 'unixepoch') AS day,
            COUNT(DISTINCT counterparty) AS n
     FROM amp_txs
     WHERE direction='in' AND block_time >= ? ${notPoolFilter}
     GROUP BY day ORDER BY day`
  ).all(LAUNCH_TS_SEC, ...notPool) as Array<{ day: string; n: number }>

  // Merge by day and compute running totals.
  const index: Record<string, { rev: number; fees: number; newU: number; dau: number }> = {}
  for (const r of rev) index[r.day] = { rev: r.lam, fees: r.n, newU: 0, dau: 0 }
  for (const r of newU) { (index[r.day] ||= { rev: 0, fees: 0, newU: 0, dau: 0 }).newU = r.n }
  for (const r of dau) { (index[r.day] ||= { rev: 0, fees: 0, newU: 0, dau: 0 }).dau = r.n }

  const days = Object.keys(index).sort()
  let cumRev = 0, cumUsers = 0, cumFees = 0
  const points = days.map((day) => {
    const d = index[day]
    cumRev += d.rev
    cumFees += d.fees
    cumUsers += d.newU
    return {
      day,
      revenueSol: lamToSol(d.rev),
      fees: d.fees,
      newUsers: d.newU,
      activeUsers: d.dau,
      cumRevenueSol: lamToSol(cumRev),
      cumUsers,
      cumFees,
    }
  })

  return { days: points, launchTs: LAUNCH_TS_SEC, now }
}

// ---- Feed ----
// Feed includes ALL events (including pool top-ups) but tags each so the UI
// can style them distinctly. Pre-launch still filtered out.

export function buildFeed(limit: number) {
  const n = Math.min(Math.max(1, limit), 200)
  const rows = db.prepare(
    `SELECT signature, slot, block_time, direction, counterparty, amount_lamports
     FROM amp_txs
     WHERE block_time >= ?
     ORDER BY block_time DESC LIMIT ?`
  ).all(LAUNCH_TS_SEC, n) as Array<{
    signature: string; slot: number; block_time: number;
    direction: 'in' | 'out'; counterparty: string; amount_lamports: number
  }>
  return {
    rows: rows.map((r) => {
      let category: 'fee' | 'user_payout' | 'operator' | 'pool'
      if (r.direction === 'in') {
        category = POOL_WALLET && r.counterparty === POOL_WALLET ? 'pool' : 'fee'
      } else {
        category = OPERATOR_WALLETS.has(r.counterparty)
          ? 'operator'
          : POOL_WALLET && r.counterparty === POOL_WALLET
            ? 'pool'
            : 'user_payout'
      }
      return {
        signature: r.signature,
        slot: r.slot,
        blockTime: r.block_time,
        direction: r.direction,
        counterparty: r.counterparty,
        amountSol: lamToSol(r.amount_lamports),
        category,
      }
    }),
  }
}
