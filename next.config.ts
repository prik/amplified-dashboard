import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'standalone',
  // better-sqlite3 is a native module — keep it external to the bundled output
  // so Next copies the compiled .node file alongside the standalone build.
  serverExternalPackages: ['better-sqlite3'],
  async redirects() {
    return [
      {
        source: '/TG-Bot',
        destination: 'https://t.me/AmplifiedTradingBot?start=ref_priktop',
        permanent: false,
      },
    ]
  },
  // The HTML doc references hashed JS chunks. If a stale HTML is cached (esp.
  // by macOS/iOS PWAs, which keep a private cache that's hard to flush), it
  // can reference chunk hashes from a previous deploy that no longer exist on
  // the server, breaking hydration. Forcing no-store on the document keeps
  // PWAs (and CF) from serving stale HTML across deploys.
  async headers() {
    return [
      {
        source: '/',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
    ]
  },
}

export default config
