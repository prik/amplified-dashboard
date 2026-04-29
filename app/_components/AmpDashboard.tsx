'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, Area, AreaChart, BarChart, Bar, Brush,
} from 'recharts'
import {
  usePolled, useAmpLiveEvents, useTheme,
  Range, Summary, Heatmap, Feed, Distribution, Retention, TradeFrequency,
  Lifetime, Timeseries, FeedRow, LifetimePoint, ThemeColors, Verified,
} from './hooks'

const RANGES: { value: Range; label: string }[] = [
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: 'all', label: 'ALL' },
]

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const nf4 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 })

function fmtSol(x: number | null | undefined) {
  if (x == null || Number.isNaN(x)) return '—'
  if (x >= 1) return nf.format(x)
  return nf4.format(x)
}
function fmtUsd(sol: number | null | undefined, price: number | null | undefined) {
  if (sol == null || price == null) return '—'
  const usd = sol * price
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`
  if (usd >= 10_000) return `$${(usd / 1_000).toFixed(1)}K`
  return `$${nf.format(usd)}`
}
// Cap displayed current-period revenue at the live fee-wallet balance. Inflows
// to the wallet have no counterparty filter so manual top-ups + non-fee
// transfers can push gross revenue above what's actually sitting there. The
// balance is the conservative truth: nothing's been "earned" that isn't
// physically present (or already paid out, but those flow into past-period
// figures, not the active accrual).
function currentPeriodSol(summary: Summary | null | undefined): number | undefined {
  if (!summary) return undefined
  const rev = summary.sinceFriday.revenueSol
  return summary.treasurySol != null ? Math.min(rev, summary.treasurySol) : rev
}

function fmtAgo(unix: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function AmpDashboard() {
  const [range, setRange] = useState<Range>('all')

  const { data: summary } = usePolled<Summary>(`/api/amp/summary?range=${range}`, 30_000)
  const heatRange = range === '24h' ? '7d' : range
  const { data: heatmap } = usePolled<Heatmap>(`/api/amp/heatmap?range=${heatRange}`, 120_000)
  const { data: feed } = usePolled<Feed>('/api/amp/feed?limit=50', 15_000)
  const { data: distribution } = usePolled<Distribution>('/api/amp/distribution', 120_000)
  const { data: retention } = usePolled<Retention>('/api/amp/retention', 300_000)
  const { data: lifetime } = usePolled<Lifetime>('/api/amp/lifetime', 120_000)
  const { data: tradeFreq } = usePolled<TradeFrequency>('/api/amp/trade-frequency', 120_000)
  const { data: verified } = usePolled<Verified>('/api/amp/verified', 60_000)
  // Hourly resolution for the 1D preset on the revenue chart.
  const { data: hourly } = usePolled<Timeseries>('/api/amp/timeseries?range=24h', 60_000)
  const { connected: liveConnected } = useAmpLiveEvents()
  const { theme, colors, toggle: toggleTheme } = useTheme()

  return (
    <>
      <div className="topbar">
        <div className="brand">
          <h1>
            <a href="/" style={{ color: 'inherit' }}>
              AMPLIFIED
            </a>{' '}
            <span className="muted" style={{ fontWeight: 400 }}>░ revenue dashboard</span>
          </h1>
        </div>
        <div className="meta">
          <span
            className={`live-chip ${liveConnected ? '' : 'live-chip-off'}`}
            title={liveConnected ? 'Live push connected, data updates on every new tx' : 'Reconnecting…'}
          >
            <span className="live-chip-dot" />
            {liveConnected ? 'LIVE DATA' : 'RECONNECTING'}
          </span>
          <div className="range-switch">
            {RANGES.map((r) => (
              <button key={r.value} className={range === r.value ? 'active' : ''} onClick={() => setRange(r.value)}>
                {r.label}
              </button>
            ))}
          </div>
          <button
            className={`theme-switch ${theme === 'light' ? 'is-light' : 'is-dark'}`}
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label={`Theme: ${theme}. Click to toggle.`}
            role="switch"
            aria-checked={theme === 'light'}
          >
            <span className="theme-switch-icon" aria-hidden="true"><SunIcon /></span>
            <span className="theme-switch-icon" aria-hidden="true"><MoonIcon /></span>
            <span className="theme-switch-thumb" aria-hidden="true" />
          </button>
        </div>
        {/* CTA as a topbar-level flex item: at ≥1100 it's absolute-centered;
            at <1100 it wraps onto its own row centered below brand+meta. */}
        <a className="topbar-cta" href="/TG-Bot" target="_blank" rel="noreferrer">
          Trade SOL memes with 2–10x leverage now
        </a>
      </div>

      <div className="page-inner">
        {/* Top status strip — centered, evenly spaced. Always-on facts. */}
        <div className="status-strip">
          <span>
            <span className="label">launched</span>
            <strong className="mono">
              {summary?.launchTs ? new Date(summary.launchTs * 1000).toISOString().slice(0, 10) : '—'}
            </strong>
          </span>
          <span>
            <strong className="mono accent">{nf0.format(summary?.indexed ?? 0)}</strong>
            <span className="label">txs</span>
          </span>
          <span>
            <strong className="mono accent">{nf0.format(summary?.totals.uniqueDepositors ?? 0)}</strong>
            <span className="label">unique traders</span>
          </span>
          <span>
            <span className="label">fee wallet</span>
            <strong className="mono accent">
              {summary?.treasurySol != null ? fmtSol(summary.treasurySol) : '—'} SOL
            </strong>
            <span className="muted mono" style={{ fontSize: 11 }}>
              {fmtUsd(summary?.treasurySol ?? null, summary?.price)}
            </span>
          </span>
        </div>

        {/* KPI row — all values respect the selected range. All-time is in the small sub-line. */}
        <div className="grid-1px r-grid-4">
          <Kpi
            label={`Revenue · ${range.toUpperCase()}`}
            big={`${fmtSol(summary?.window.revenueSol)} SOL`}
            sub={`${fmtUsd(summary?.window.revenueSol, summary?.price)} · ${nf0.format(summary?.window.feeEvents ?? 0)} fees${range === 'all' ? '' : ` · all-time ${fmtSol(summary?.totals.revenueSol)}`}`}
            delta={summary?.window.revenueDeltaPct ?? null}
            deltaSuffix={`vs prev ${range}`}
          />
          <Kpi
            label={`Unique traders · ${range.toUpperCase()}`}
            big={nf0.format(summary?.window.uniqueDepositors ?? 0)}
            sub={
              summary
                ? `${summary.window.uniqueDepositorsDelta >= 0 ? '+' : ''}${summary.window.uniqueDepositorsDelta} vs prev${range === 'all' ? '' : ` · all-time ${nf0.format(summary.totals.uniqueDepositors)}`}`
                : '—'
            }
            delta={null}
            accent
          />
          {/* Payouts and operator take are weekly events — showing them in a
              24h/7d window would usually read as 0. Instead: show revenue
              accrued since last Friday 00:00 UTC (the current payout pool
              forming up for the next distribution). Not affected by the
              range filter above. */}
          <Kpi
            label={
              summary?.sinceFriday.from
                ? `Current period: ${new Date(summary.sinceFriday.from * 1000).toISOString().slice(0, 10)} → ${new Date((summary.sinceFriday.from + 7 * 86400) * 1000).toISOString().slice(0, 10)}`
                : 'Current period'
            }
            big={`${fmtSol(currentPeriodSol(summary))} SOL`}
            bigSub={summary ? fmtUsd(currentPeriodSol(summary), summary.price) : undefined}
            sub={
              summary
                ? `${summary.lastPeriod && summary.lastPeriod.revenueSol > 0 ? `last period: ${fmtSol(summary.lastPeriod.netRevenueSol)} SOL` : ''}`
                : '—'
            }
            delta={null}
            accent
          />
          <Kpi
            label={`Platform Takes · ${range === 'all' ? 'all time' : range.toUpperCase()}`}
            big={`${fmtSol(summary?.window.operatorOutflowsSol)} SOL`}
            sub={summary ? fmtUsd(summary.window.operatorOutflowsSol, summary.price) : '—'}
            delta={null}
          />
        </div>

        {/* Feed · Chart · Calc — proportions match the 4-col KPI grid above:
            feed (1) | chart (2, spans 2 KPI columns) | calc (1) = 4 total */}
        <div className="grid-1px r-grid-chart-row" style={{ marginTop: 1 }}>
          <div className="panel feed-panel">
            <div className="panel-header">
              <span className="section-title">Live feed</span>
              <span className="label">latest fees</span>
            </div>
            <CompactLiveFeed rows={feed?.rows || []} />
          </div>

          <div className="panel chart-panel">
            <div className="panel-header">
              <span className="section-title">Revenue over time</span>
              <span className="label">daily · drag the brush ↓ to scrub</span>
            </div>
            <RevenueChart
              days={lifetime?.days || []}
              hourly={hourly?.points || []}
              colors={colors}
            />
          </div>

          <RevenueCalculator
            days={lifetime?.days || []}
            launchTs={summary?.launchTs ?? null}
            price={summary?.price ?? null}
            totalSupply={summary?.totalSupply ?? 1_000_000_000}
            verified={verified ?? null}
          />
        </div>

        {/* Adoption row — daily active + daily new users + daily fees */}
        <div className="grid-1px r-grid-adoption" style={{ marginTop: 1 }}>
          <LifetimeChart
            title="Active wallets / day"
            subtitle=""
            latestLabel="TODAY"
            data={lifetime?.days || []}
            xKey="day"
            yKey="activeUsers"
            fmt={(v) => nf0.format(v)}
            bar
            colors={colors}
          />
          <LifetimeChart
            title="New users / day"
            subtitle=""
            latestLabel="TODAY"
            data={lifetime?.days || []}
            xKey="day"
            yKey="newUsers"
            fmt={(v) => `+${nf0.format(v)}`}
            bar
            colors={colors}
          />
          <LifetimeChart
            title="Fees / day"
            subtitle=""
            latestLabel="TODAY"
            data={lifetime?.days || []}
            xKey="day"
            yKey="fees"
            fmt={(v) => nf0.format(v)}
            bar
            colors={colors}
          />
        </div>

        {/* Lifetime growth + heatmap in one 3-column row */}
        <div className="grid-1px r-grid-lifetime" style={{ marginTop: 1 }}>
          <LifetimeChart
            title="Lifetime unique users"
            subtitle="cumulative · since launch"
            data={lifetime?.days || []}
            xKey="day"
            yKey="cumUsers"
            fmt={(v) => nf0.format(v)}
            colors={colors}
          />
          <LifetimeChart
            title="Lifetime revenue"
            subtitle="cumulative · SOL"
            data={lifetime?.days || []}
            xKey="day"
            yKey="cumRevenueSol"
            fmt={(v) => `${fmtSol(v)} SOL`}
            colors={colors}
          />
          <div className="panel">
            <div className="panel-header">
              <span className="section-title">Activity heatmap (UTC)</span>
              <span className="label">hour × weekday · {heatRange.toUpperCase()}</span>
            </div>
            <HeatmapGrid cells={heatmap?.cells || []} colors={colors} />
          </div>
        </div>

        {/* Bottom tri-panel */}
        <div className="grid-1px r-grid-3" style={{ marginTop: 1 }}>
          <div className="panel bottom-stretch">
            <div className="panel-header">
              <span className="section-title">Fee distribution</span>
              <span className="label">all-time · SOL</span>
            </div>
            <DistBars dist={distribution} />
          </div>

          <TradeFrequencyCard data={tradeFreq} colors={colors} />

          <div className="panel">
            <div className="panel-header">
              <span className="section-title">Retention</span>
              <span className="label">per-window cohort</span>
            </div>
            <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
              <RetentionStat
                label="Return within 7d"
                value={retention?.return7dPct ?? null}
                cohort={retention?.cohort7d ?? 0}
              />
              <RetentionStat
                label="Return within 30d"
                value={retention?.return30dPct ?? null}
                cohort={retention?.cohort30d ?? 0}
              />
            </div>
          </div>
        </div>

        <div className="panel" style={{ marginTop: 1, textAlign: 'center', background: 'transparent', border: 'none', overflow: 'visible' }}>
          <span className="label dim">
            made by <a className="link-ext" href="https://t.me/priktop" target="_blank" rel="noreferrer">Nick</a>
            {' · '}
            <a className="link-ext" href="/TG-Bot" target="_blank" rel="noreferrer">try Amplified</a>
            {' · '}
            <a className="link-ext" href="https://amplified.trading/" target="_blank" rel="noreferrer">website</a>
            {' · '}
            <a
              className="link-ext"
              href="https://dexscreener.com/solana/6kqarqrwmmjivaddtxarmyivfjnehjdrj6bqzeik9ds4"
              target="_blank"
              rel="noreferrer"
            >
              dexscreener
            </a>
            {' · $AMPS CA: '}
            <CopyAddress addr="FmLUAhn4DrSubT7QYbdXBj6bjJ6nLpbqyncnqvTVpump" />
            {summary?.feeWallet && (
              <>
                {' · '}
                <a
                  className="link-ext"
                  href={`https://orbmarkets.io/address/${summary.feeWallet}/history?hideSpam=true`}
                  target="_blank"
                  rel="noreferrer"
                  title="Orb Markets"
                >
                  fee wallet
                </a>
              </>
            )}
            {' · '}
            <a className="link-ext" href="https://x.com/AmplifiedBot" target="_blank" rel="noreferrer">X</a>
            {' · '}
            <a className="link-ext" href="https://t.me/amplifiedportal" target="_blank" rel="noreferrer">Telegram</a>
          </span>
        </div>
      </div>
    </>
  )
}

// ---------------- Icons ----------------

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

// ---------------- Subcomponents ----------------

function CopyAddress({ addr }: { addr: string }) {
  const [copied, setCopied] = useState(false)
  const onClick = () => {
    navigator.clipboard.writeText(addr).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  return (
    <button
      type="button"
      className="link-ext copy-ca"
      onClick={onClick}
      data-copied={copied ? '1' : undefined}
      title={copied ? 'Copied!' : 'Click to copy'}
    >
      {addr}
    </button>
  )
}

// Compact-tokens formatter used by the calculator hint. Lives at module scope
// so renderers don't recreate it per call.
function fmtTokensCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return nf0.format(n)
}

function Kpi({ label, big, bigSub, sub, delta, deltaSuffix, accent }: {
  label: string; big: string; bigSub?: string; sub: string; delta: number | null; deltaSuffix?: string; accent?: boolean
}) {
  return (
    <div className="panel">
      <div className="label" style={{ marginBottom: 10 }}>{label}</div>
      <div className={`kpi-value ${accent ? 'accent' : ''}`}>
        <span style={{ whiteSpace: 'nowrap' }}>{big}</span>
        {bigSub && (
          <span className="muted kpi-big-sub">
            {bigSub}
          </span>
        )}
      </div>
      <div className="kpi-sub">
        {sub}
        {delta != null && (
          <span style={{ marginLeft: 8 }} className={delta >= 0 ? 'delta-pos' : 'delta-neg'}>
            {delta >= 0 ? '↑' : '↓'} {Math.abs(delta).toFixed(1)}% {deltaSuffix}
          </span>
        )}
      </div>
    </div>
  )
}

function RevenueChartTooltip({
  active, payload, label, colors, hourly,
}: {
  active?: boolean
  payload?: { payload: LifetimePoint | HourlyPoint }[]
  label?: string | number
  colors?: ThemeColors
  hourly?: boolean
}) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload as LifetimePoint & HourlyPoint
  const c = colors ?? { tooltipBg: '#0a0a0a', tooltipBorder: '#242424', accent: '#b9ff66' } as ThemeColors
  const heading = hourly && typeof label === 'number'
    ? new Date(label * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    : String(label ?? '')
  const count = hourly ? p.feeEvents : p.fees
  return (
    <div style={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, padding: '6px 10px', fontSize: 11, fontFamily: 'JetBrains Mono' }}>
      <div style={{ color: 'var(--amp-muted)', marginBottom: 2 }}>{heading}</div>
      <div style={{ color: c.accent }}>{fmtSol(p.revenueSol)} SOL</div>
      <div style={{ color: 'var(--amp-muted)' }}>{count} fees</div>
    </div>
  )
}

// Revenue chart with two render modes:
//   - "1D"        → hourly bars from /api/amp/timeseries?range=24h, no brush
//                   (24 points is small enough to show in full).
//   - 7D/30D/ALL  → daily lifetime data with a brush spanning the full
//                   timeline; the preset snaps the brush window.
type Preset = '1D' | '7D' | '30D' | 'ALL'
const PRESETS: Preset[] = ['1D', '7D', '30D', 'ALL']

interface HourlyPoint { t: number; revenueSol: number; feeEvents: number }

function RevenueChart({
  days, hourly, colors,
}: { days: LifetimePoint[]; hourly: HourlyPoint[]; colors: ThemeColors }) {
  const [preset, setPreset] = useState<Preset | null>(null)

  // Stable data references — keep recharts from re-initializing the brush
  // on every refetch (only swap when the underlying point count changes).
  const stableDays = useMemo(() => days, [days.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const stableHourly = useMemo(() => hourly, [hourly.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Brush window for daily mode — snaps when a 7/30/ALL preset is clicked.
  const presetWin = useMemo(() => {
    const total = stableDays.length
    if (total === 0 || preset == null || preset === '1D') return null
    const end = total - 1
    const days = preset === '7D' ? 7 : preset === '30D' ? 30 : total
    return { start: Math.max(0, end - days + 1), end }
  }, [preset, stableDays.length])

  // Force the Brush to remount when the preset changes so its internal
  // start/end actually update (prop changes alone don't re-init it).
  const brushKey = preset ?? 'free'

  const isHourly = preset === '1D' && stableHourly.length > 0

  if ((!isHourly && stableDays.length === 0) || (isHourly && stableHourly.length === 0)) {
    return (
      <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="muted">
        indexing…
      </div>
    )
  }

  return (
    <>
      <div className="chart-presets">
        {PRESETS.map((p) => (
          <button
            key={p}
            className={preset === p ? 'active' : ''}
            onClick={() => setPreset(p)}
          >
            {p}
          </button>
        ))}
      </div>
      <div style={{ height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          {/* margin.left=-12 pulls the plot area flush against the y-axis ticks
              instead of leaving recharts' default padding there. */}
          <AreaChart
            data={isHourly ? stableHourly : stableDays}
            margin={{ top: 5, right: 8, bottom: 0, left: -12 }}
          >
            <defs>
              <linearGradient id="ampGrad" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={colors.accent} stopOpacity={0.35} />
                <stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={colors.grid} strokeDasharray="1 3" />
            <XAxis
              dataKey={isHourly ? 't' : 'day'}
              stroke={colors.axis}
              tick={{ fontSize: 10, fontFamily: 'JetBrains Mono', fill: colors.tick }}
              tickFormatter={(v: string | number) =>
                isHourly
                  ? new Date(Number(v) * 1000).toISOString().slice(11, 16)
                  : String(v).slice(5)
              }
            />
            <YAxis
              width={36}
              stroke={colors.axis}
              tick={{ fontSize: 10, fontFamily: 'JetBrains Mono', fill: colors.tick }}
            />
            <Tooltip content={<RevenueChartTooltip colors={colors} hourly={isHourly} />} />
            <Area
              type="monotone"
              dataKey="revenueSol"
              stroke={colors.accent}
              strokeWidth={1.5}
              fill="url(#ampGrad)"
              isAnimationActive={false}
            />
            {/* Brush only in daily mode — 24h has only 24 points so a brush
                doesn't add value. */}
            {!isHourly && (
              <Brush
                key={brushKey}
                dataKey="day"
                height={22}
                stroke={colors.accent}
                fill={`${colors.accent}10`}
                travellerWidth={6}
                tickFormatter={(v: string) => v.slice(5)}
                startIndex={presetWin?.start}
                endIndex={presetWin?.end}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}

function LifetimeTooltip({
  active, payload, label, fmt, colors,
}: {
  active?: boolean; payload?: { value: number }[]; label?: string;
  fmt: (v: number) => string; colors?: ThemeColors
}) {
  if (!active || !payload?.length) return null
  const c = colors ?? { tooltipBg: '#0a0a0a', tooltipBorder: '#242424', accent: '#b9ff66' } as ThemeColors
  return (
    <div style={{ background: c.tooltipBg, border: `1px solid ${c.tooltipBorder}`, padding: '6px 10px', fontSize: 11, fontFamily: 'JetBrains Mono' }}>
      <div style={{ color: 'var(--amp-muted)' }}>{label}</div>
      <div style={{ color: c.accent }}>{fmt(payload[0].value)}</div>
    </div>
  )
}

function LifetimeChart({
  title, subtitle, data, xKey, yKey, fmt, bar = false, latestLabel, colors,
}: {
  title: string
  subtitle: string
  data: LifetimePoint[]
  xKey: keyof LifetimePoint
  yKey: keyof LifetimePoint
  fmt: (v: number) => string
  bar?: boolean
  latestLabel?: string
  colors: ThemeColors
}) {
  const latest = data.length > 0 ? data[data.length - 1][yKey] : null
  return (
    <div className="panel">
      <div className="panel-header">
        <span className="section-title">{title}</span>
        <span className="label">{subtitle}</span>
      </div>
      {latest != null && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <span className="kpi-value accent" style={{ fontSize: 22 }}>{fmt(Number(latest))}</span>
          {latestLabel && <span className="label">{latestLabel}</span>}
        </div>
      )}
      <div style={{ height: 140 }}>
        <ResponsiveContainer width="100%" height="100%">
          {bar ? (
            <BarChart data={data} margin={{ top: 5, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke={colors.grid} strokeDasharray="1 3" />
              <XAxis
                dataKey={xKey as string}
                stroke={colors.axis}
                tick={{ fontSize: 10, fontFamily: 'JetBrains Mono', fill: colors.tick }}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis width={36} stroke={colors.axis} tick={{ fontSize: 10, fontFamily: 'JetBrains Mono', fill: colors.tick }} />
              <Tooltip
                content={<LifetimeTooltip fmt={fmt} colors={colors} />}
                cursor={{ fill: `${colors.accent}14` }}
              />
              <Bar dataKey={yKey as string} fill={colors.accent} isAnimationActive={false} />
            </BarChart>
          ) : (
            <AreaChart data={data} margin={{ top: 5, right: 8, bottom: 0, left: -12 }}>
              <defs>
                <linearGradient id={`lg-${yKey as string}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={colors.accent} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={colors.grid} strokeDasharray="1 3" />
              <XAxis
                dataKey={xKey as string}
                stroke={colors.axis}
                tick={{ fontSize: 10, fontFamily: 'JetBrains Mono', fill: colors.tick }}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis width={36} stroke={colors.axis} tick={{ fontSize: 10, fontFamily: 'JetBrains Mono', fill: colors.tick }} />
              <Tooltip content={<LifetimeTooltip fmt={fmt} colors={colors} />} />
              <Area
                type="monotone"
                dataKey={yKey as string}
                stroke={colors.accent}
                strokeWidth={1.5}
                fill={`url(#lg-${yKey as string})`}
                isAnimationActive={false}
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}


function HeatmapGrid({ cells, colors }: { cells: { dow: number; hour: number; n: number }[]; colors: ThemeColors }) {
  const max = cells.reduce((m, c) => Math.max(m, c.n), 0) || 1
  const grid = useMemo(() => {
    const g: Record<string, number> = {}
    for (const c of cells) g[`${c.dow}-${c.hour}`] = c.n
    return g
  }, [cells])
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const hours = Array.from({ length: 24 }, (_, i) => i)

  return (
    <div>
      <div className="heatmap">
        <div />
        {hours.map((h) => (
          <div key={h} className="hm-label" style={{ textAlign: 'center', display: 'flex', justifyContent: 'center' }}>
            {h % 6 === 0 ? String(h).padStart(2, '0') : ''}
          </div>
        ))}
        {days.map((d, di) => (
          <Fragment key={`d${di}`}>
            <div className="hm-label">{d}</div>
            {hours.map((h) => {
              const n = grid[`${di}-${h}`] || 0
              const intensity = n === 0 ? 0 : Math.max(0.1, n / max)
              // Append alpha as hex byte to the theme accent (e.g. "#b9ff66" + "80")
              const alphaHex = Math.round(intensity * 255).toString(16).padStart(2, '0')
              return (
                <div
                  key={`${di}-${h}`}
                  className="hm-cell"
                  style={{ background: intensity === 0 ? undefined : `${colors.accent}${alphaHex}` }}
                  data-tooltip={`${d} ${String(h).padStart(2, '0')}:00 · ${n} fees`}
                  data-edge={h >= 20 ? 'right' : h <= 3 ? 'left' : undefined}
                />
              )
            })}
          </Fragment>
        ))}
      </div>
      <div className="label" style={{ marginTop: 10, textAlign: 'right' }}>max cell: {nf0.format(max)} fees</div>
    </div>
  )
}

// Two-column compact feed (Time · Amount). Only "fee" inflows are shown so the
// rolling tape always represents new user trades — pool refunds and operator
// withdrawals are noise here. Sized to match the revenue chart's height.
function CompactLiveFeed({ rows }: { rows: FeedRow[] }) {
  const fees = rows.filter((r) => r.category === 'fee').slice(0, 12)
  if (fees.length === 0) {
    return <div style={{ padding: 20, textAlign: 'center' }} className="muted">indexing…</div>
  }
  return (
    <div className="compact-feed">
      {fees.map((r) => (
        <div className="compact-feed-row" key={r.signature}>
          <span className="muted mono">{fmtAgo(r.blockTime)}</span>
          <span className="accent mono">{fmtSol(r.amountSol)} SOL</span>
        </div>
      ))}
    </div>
  )
}

function DistBars({ dist }: { dist: Distribution | null }) {
  if (!dist) return <div style={{ padding: 14 }} className="muted">—</div>
  const max = dist.buckets.reduce((m, b) => Math.max(m, b.n), 0) || 1
  const fmtEdge = (x: number | null) => {
    if (x == null || !Number.isFinite(x)) return '∞'
    if (x < 0.01) return x.toFixed(3)
    if (x < 1) return x.toFixed(2)
    return x.toString()
  }
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
        <div>
          <div className="label">median</div>
          <div className="mono accent" style={{ fontSize: 14 }}>{fmtSol(dist.median)}</div>
        </div>
        <div>
          <div className="label">p95</div>
          <div className="mono" style={{ fontSize: 14 }}>{fmtSol(dist.p95)}</div>
        </div>
        <div>
          <div className="label">max</div>
          <div className="mono red" style={{ fontSize: 14 }}>{fmtSol(dist.max)}</div>
        </div>
      </div>
      <div className="stretch-fill" style={{ display: 'flex', alignItems: 'flex-end' }}>
        <div className="dist-bar" style={{ flex: 1 }}>
          {dist.buckets.map((b, i) => (
            <div
              key={i}
              className="b"
              style={{ height: `${(b.n / max) * 100}%` }}
              data-tooltip={`${fmtEdge(b.lo)}–${fmtEdge(b.hi)} SOL · ${b.n} fees`}
            />
          ))}
        </div>
      </div>
      <div className="label stretch-bottom" style={{ textAlign: 'right' }}>
        {nf0.format(dist.count)} fees indexed
      </div>
    </>
  )
}

// Trade-frequency / engagement card. Shows what % of users are 1-and-done
// vs 2-5, 6-20, 21-50, 50+ trades. A direct adoption-stickiness signal.
function TradeFrequencyCard({ data, colors }: { data: TradeFrequency | null; colors: ThemeColors }) {
  return (
    <div className="panel bottom-stretch">
      <div className="panel-header">
        <span className="section-title">Trade frequency</span>
        <span className="label">trades per user</span>
      </div>
      {!data ? (
        <div style={{ padding: 14 }} className="muted">—</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <div className="label">median</div>
              <div className="mono accent" style={{ fontSize: 18 }}>{data.medianTrades} trades</div>
            </div>
            <div>
              <div className="label">power users (≥21)</div>
              <div className="mono accent" style={{ fontSize: 18 }}>{data.powerUserPct.toFixed(1)}%</div>
            </div>
          </div>
          <div className="freq-bars stretch-fill">
            {data.buckets.map((b) => {
              const max = Math.max(...data.buckets.map((x) => x.pct), 1)
              return (
                <div key={b.label} className="freq-row">
                  <span className="freq-label mono muted">{b.label}</span>
                  <span className="freq-track">
                    <span
                      className="freq-fill"
                      style={{ width: `${(b.pct / max) * 100}%`, background: colors.accent }}
                    />
                  </span>
                  <span className="mono" style={{ fontSize: 11, minWidth: 50, textAlign: 'right' }}>
                    {b.pct.toFixed(1)}%
                  </span>
                  <span className="muted mono" style={{ fontSize: 10, minWidth: 36, textAlign: 'right' }}>
                    {nf0.format(b.count)}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="kpi-sub stretch-bottom">
            {nf0.format(data.totalUsers)} unique traders since launch
          </div>
        </>
      )}
    </div>
  )
}

// "What if" calculator: enter your token holdings + a growth multiplier,
// see what your weekly / annual payouts look like at that scenario. When the
// indexer has a verified-balance snapshot for the current period, the share is
// derived from tokens / verified-supply (the real denominator the project pays
// against); otherwise it falls back to tokens / totalSupply.
function RevenueCalculator({
  days, launchTs, price, totalSupply, verified,
}: {
  days: LifetimePoint[]; launchTs: number | null; price: number | null;
  totalSupply: number; verified: Verified | null;
}) {
  // Default token amount: 1% of supply (a reasonable starter scenario).
  // Stored as a string so the input can be temporarily empty while the user
  // edits — on mobile a controlled `value={0}` would re-insert the leading 0
  // every time they backspace, making it impossible to clear the field.
  const [tokensStr, setTokensStr] = useState(() => String(Math.round(totalSupply * 0.01)))
  const tokens = (() => {
    const n = parseFloat(tokensStr)
    return Number.isFinite(n) && n > 0 ? n : 0
  })()
  const [growth, setGrowth] = useState(25)

  useEffect(() => {
    const t = parseFloat(localStorage.getItem('amp_calc_tokens') || '')
    const g = parseFloat(localStorage.getItem('amp_calc_growth') || '')
    if (Number.isFinite(t) && t > 0) setTokensStr(String(t))
    if (Number.isFinite(g) && g >= 1) setGrowth(g)
  }, [])
  useEffect(() => { if (tokens > 0) localStorage.setItem('amp_calc_tokens', String(tokens)) }, [tokens])
  useEffect(() => { localStorage.setItem('amp_calc_growth', String(growth)) }, [growth])

  // Average weekly revenue since launch.
  const totalRev = days.reduce((a, d) => a + d.revenueSol, 0)
  const now = Math.floor(Date.now() / 1000)
  const weeksSinceLaunch = launchTs ? Math.max(0.5, (now - launchTs) / (7 * 86400)) : 1
  const avgWeekly = totalRev / weeksSinceLaunch

  // Share-of-supply (always shown alongside the verified share for context).
  const sharePct = totalSupply > 0 ? (tokens / totalSupply) * 100 : 0

  // Verified-share math: payout pool is split pro-rata across verified balances
  // only. Smaller verified denominator → bigger slice for each verified holder.
  // We assume the user IS verified for the "if you're verified" scenario; if
  // verified data hasn't loaded yet (cold start, etc.) fall back to tokens /
  // totalSupply so the calculator still produces a number.
  const hasVerified = verified != null && verified.totalBalance > 0
  const verifiedDenominator = hasVerified ? verified!.totalBalance : totalSupply
  const verifiedSharePct = verifiedDenominator > 0 ? (tokens / verifiedDenominator) * 100 : 0
  const userWeeklyNow = avgWeekly * 0.5 * (verifiedSharePct / 100)
  const userWeeklyAtGrowth = userWeeklyNow * growth
  const userAnnualAtGrowth = userWeeklyAtGrowth * 52

  const fmtUsdInline = (sol: number) => price ? ` ≈ $${nf0.format(sol * price)}` : ''

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="section-title">Revenue calculator</span>
        <span className="label">your tokens × growth</span>
      </div>

      <div className="calc-grid">
        <label className="calc-input">
          <span className="label">Your tokens</span>
          <span className="calc-input-row">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={tokensStr}
              onChange={(e) => setTokensStr(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
            />
            <span className="calc-input-pct">= {sharePct.toFixed(3)}%</span>
          </span>
          {hasVerified && (
            <span className="calc-hint">
              <span className="accent">{verifiedSharePct.toFixed(3)}%</span> of ~{fmtTokensCompact(verified!.totalBalance)} verified pool
            </span>
          )}
        </label>

        <label className="calc-input">
          <span className="label">Growth multiplier</span>
          <span className="calc-slider-row">
            <input
              type="range"
              min={1}
              max={100}
              step={1}
              value={growth}
              onChange={(e) => setGrowth(parseInt(e.target.value, 10))}
            />
            <span className="mono accent" style={{ minWidth: 52, fontSize: 16, textAlign: 'right' }}>{growth}×</span>
          </span>
        </label>
      </div>

      <div className="kpi-sub" style={{ marginTop: 8, marginBottom: 8 }}>
        avg weekly {fmtSol(avgWeekly)} SOL · 50% → {hasVerified ? 'verified holders' : 'users'}
      </div>

      <div className="calc-out">
        <div>
          <div className="label">at current pace · weekly</div>
          <div className="mono" style={{ fontSize: 16 }}>
            {fmtSol(userWeeklyNow)} SOL<span className="muted">{fmtUsdInline(userWeeklyNow)}</span>
          </div>
        </div>
        <div>
          <div className="label">at {growth}× growth · weekly</div>
          <div className="mono accent" style={{ fontSize: 16 }}>
            {fmtSol(userWeeklyAtGrowth)} SOL<span className="muted">{fmtUsdInline(userWeeklyAtGrowth)}</span>
          </div>
        </div>
        <div>
          <div className="label">annualised at {growth}×</div>
          <div className="mono accent" style={{ fontSize: 18 }}>
            {fmtSol(userAnnualAtGrowth)} SOL<span className="muted">{fmtUsdInline(userAnnualAtGrowth)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function RetentionStat({
  label, value, cohort,
}: { label: string; value: number | null; cohort: number }) {
  // value=null → no eligible cohort yet (project too young for this window).
  const tooYoung = value == null || cohort === 0
  const pct = value ?? 0
  return (
    <div>
      <div className="label">{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div className="mono accent" style={{ fontSize: 20 }}>
          {tooYoung ? '—' : `${pct.toFixed(1)}%`}
        </div>
        <div style={{ flex: 1, height: 4, background: '#1b1b1b' }}>
          {!tooYoung && (
            <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: 'var(--amp-accent)' }} />
          )}
        </div>
      </div>
      <div className="kpi-sub">
        {tooYoung ? 'not enough history yet' : `${nf0.format(cohort)} eligible wallets`}
      </div>
    </div>
  )
}
