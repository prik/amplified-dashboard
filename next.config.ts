import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'standalone',
  // better-sqlite3 is a native module — keep it external to the bundled output
  // so Next copies the compiled .node file alongside the standalone build.
  serverExternalPackages: ['better-sqlite3'],
}

export default config
