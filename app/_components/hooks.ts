'use client'

import { useEffect, useRef, useState } from 'react'

// Global refresh token. Whenever it ticks, every usePolled() hook re-fetches
// immediately. The dashboard calls `bumpRefresh()` on SSE events so server-
// side indexer ticks propagate to all widgets within the same frame.
const subscribers = new Set<() => void>()
let refreshCounter = 0
export function bumpRefresh() {
  refreshCounter++
  for (const fn of subscribers) fn()
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`http ${res.status}`)
  return res.json()
}

export function usePolled<T>(url: string, intervalMs = 30_000): { data: T | null; err: string | null } {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    let timer: number | undefined

    const fetchOnce = async () => {
      try {
        const result = await apiGet<T>(url)
        if (mounted.current) { setData(result); setErr(null) }
      } catch (e) {
        if (mounted.current) setErr(e instanceof Error ? e.message : 'err')
      }
    }

    fetchOnce()
    timer = window.setInterval(fetchOnce, intervalMs)
    // Subscribe to the global refresh bus so SSE ticks trigger immediate fetch.
    subscribers.add(fetchOnce)
    return () => {
      mounted.current = false
      if (timer !== undefined) window.clearInterval(timer)
      subscribers.delete(fetchOnce)
    }
  }, [url, intervalMs])

  return { data, err }
}

// Active theme name + chart-friendly colors that swap with it. Reads the
// `data-theme` attribute on <html> (set in layout's pre-paint script and by
// the toggle), then watches via MutationObserver so all charts re-render on
// theme change.
export type Theme = 'dark' | 'light'

const DARK_COLORS = {
  grid: '#1b1b1b', axis: '#555555', tick: '#ededed',
  accent: '#b9ff66', accentDim: '#6b9f33',
  tooltipBg: '#0a0a0a', tooltipBorder: '#242424',
}
const LIGHT_COLORS = {
  grid: '#e5e5df', axis: '#a0a0a0', tick: '#1c1c1c',
  accent: '#3d8c00', accentDim: '#7ec02a',
  tooltipBg: '#ffffff', tooltipBorder: '#dcdcd5',
}
export type ThemeColors = typeof DARK_COLORS

export function useTheme(): { theme: Theme; colors: ThemeColors; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    const read = (): Theme => (
      document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
    )
    setTheme(read())
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    if (next === 'light') document.documentElement.setAttribute('data-theme', 'light')
    else document.documentElement.removeAttribute('data-theme')
    try { localStorage.setItem('amp_theme', next) } catch {}
  }

  return { theme, colors: theme === 'light' ? LIGHT_COLORS : DARK_COLORS, toggle }
}

// Open an EventSource to /api/amp/events with auto-reconnect + watchdog. The
// browser's built-in retry isn't always reliable behind reverse proxies that
// idle-close streams, so we also force a reconnect if no message has arrived
// within WATCHDOG_MS — `hello` + 10s keepalives mean a healthy stream always
// triggers something well inside that window.
const WATCHDOG_MS = 45_000

export function useAmpLiveEvents(): { connected: boolean } {
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    let es: EventSource | null = null
    let watchdog: number | undefined
    let cancelled = false

    const armWatchdog = () => {
      if (watchdog) window.clearTimeout(watchdog)
      watchdog = window.setTimeout(() => {
        // No traffic for too long — likely a stale connection that the proxy
        // dropped without the browser noticing. Force a reconnect.
        if (es) es.close()
        if (!cancelled) connect()
      }, WATCHDOG_MS)
    }

    const onAnyMessage = () => armWatchdog()

    const connect = () => {
      es = new EventSource('/api/amp/events')

      es.onopen = () => {
        setConnected(true)
        armWatchdog()
      }
      // Keepalive comments arrive as "message" events with empty data —
      // they're enough to reset the watchdog.
      es.onmessage = onAnyMessage
      es.addEventListener('hello', onAnyMessage)
      es.addEventListener('ping', onAnyMessage)
      es.addEventListener('tx', () => { bumpRefresh(); armWatchdog() })
      es.onerror = () => {
        setConnected(false)
        // Browser retries automatically; the watchdog covers cases where it
        // gets stuck in a half-open state.
      }
    }

    connect()

    return () => {
      cancelled = true
      if (watchdog) window.clearTimeout(watchdog)
      if (es) es.close()
    }
  }, [])

  return { connected }
}

export type Range = '24h' | '7d' | '30d' | 'all'

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
    range: Range
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
  sinceFriday: {
    from: number
    revenueSol: number
    userPayoutsSol: number
    operatorOutflowsSol: number
    poolOutflowsSol: number
    feeEvents: number
  }
  lastPeriod: {
    from: number
    to: number
    revenueSol: number
    poolOutflowsSol: number
    netRevenueSol: number
    feeEvents: number
  }
}

export interface TimePoint { t: number; revenueSol: number; payoutsSol: number; feeEvents: number; payoutEvents: number }
export interface Timeseries { bucket: number; points: TimePoint[] }

export interface LbRow { rank: number; wallet: string; feesSol: number; trades: number; firstSeen: number; lastSeen: number }
export interface Leaderboard { rows: LbRow[] }

export interface HeatmapCell { dow: number; hour: number; n: number }
export interface Heatmap { cells: HeatmapCell[] }

export interface FeedRow {
  signature: string
  slot: number
  blockTime: number
  direction: 'in' | 'out'
  counterparty: string
  amountSol: number
  category: 'fee' | 'user_payout' | 'operator' | 'pool'
}
export interface Feed { rows: FeedRow[] }

export interface DistBucket { lo: number; hi: number | null; n: number }
export interface Distribution { count: number; median: number; p95: number; max: number; buckets: DistBucket[] }

export interface WhaleShare { wallets: number; top1Pct: number; top5Pct: number; top10Pct: number }
export interface Retention {
  cohort7d: number
  cohort30d: number
  return7dPct: number | null
  return30dPct: number | null
}

export interface NewUsersDay { day: string; n: number }
export interface NewUsers { days: NewUsersDay[] }

export interface TradeFrequencyBucket { label: string; count: number; pct: number }
export interface TradeFrequency {
  totalUsers: number
  medianTrades: number
  powerUserPct: number
  buckets: TradeFrequencyBucket[]
}

export interface LifetimePoint {
  day: string
  revenueSol: number
  fees: number
  newUsers: number
  activeUsers: number
  cumRevenueSol: number
  cumUsers: number
  cumFees: number
}
export interface Lifetime { days: LifetimePoint[]; launchTs: number; now: number }

export interface Verified {
  periodStart: number
  totalBalance: number
  walletCount: number
  avgBalance: number
  forfeitedCount: number
  emptyCount: number
  lastChecked: number | null
}
