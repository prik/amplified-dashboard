export const FEE_WALLET = 'AhPwaMET366kwGax3bLi2Pg81nJid5uUTRPMWwMQ8t7j'

function parseList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export const OPERATOR_WALLETS = new Set(parseList(process.env.AMP_OPERATOR_WALLETS))
export const POOL_WALLET = (process.env.AMP_POOL_WALLET ?? '').trim() || null

// Pre-launch activity (owner's own payments, testing, etc.) is excluded from
// every query. Parsed to a unix timestamp in seconds; defaults to 0 so when
// unset the filter is a no-op.
const rawLaunch = (process.env.AMP_LAUNCH_TS ?? '').trim()
export const LAUNCH_TS_SEC: number = rawLaunch ? Math.floor(Date.parse(rawLaunch) / 1000) || 0 : 0

// Amplified SPL token mint address. When set, the indexer fetches the on-chain
// total supply once on boot (or whenever the cached value is missing) and
// stores it in amp_state.token_supply — read by the summary endpoint.
export const TOKEN_MINT: string | null = (process.env.AMP_TOKEN_MINT ?? '').trim() || null

// Fallback supply if mint isn't configured. Solana memecoin convention is 1B.
const rawSupply = (process.env.AMP_TOTAL_SUPPLY ?? '').trim()
export const TOTAL_SUPPLY_FALLBACK: number =
  rawSupply ? Number(rawSupply) || 1_000_000_000 : 1_000_000_000

export type OutflowCategory = 'user_payout' | 'operator' | 'pool'

export function classifyOutflow(recipient: string): OutflowCategory {
  if (OPERATOR_WALLETS.has(recipient)) return 'operator'
  if (POOL_WALLET && recipient === POOL_WALLET) return 'pool'
  return 'user_payout'
}

export const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
