#!/usr/bin/env bash
# Restrict host ports 80/443 to Cloudflare edge IPs only. SSH (22022) stays
# open from anywhere. Run with sudo. Re-run after Cloudflare updates their
# IP list (rare — maybe yearly; check https://www.cloudflare.com/ips/).
set -euo pipefail

CF_V4_URL="https://www.cloudflare.com/ips-v4"
CF_V6_URL="https://www.cloudflare.com/ips-v6"

[[ $EUID -eq 0 ]] || { echo "run with sudo"; exit 1; }
command -v ufw >/dev/null || { echo "ufw not installed"; exit 1; }

# SSH must already be allowed before we touch anything else; otherwise this
# script could lock the operator out if a typo elsewhere drops their session.
if ! ufw status | grep -qE '22022/tcp.*ALLOW'; then
  echo "abort: 22022/tcp not in ufw allow list — fix that first or you'll lock yourself out"
  exit 1
fi

V4=$(curl -fsS "$CF_V4_URL")
V6=$(curl -fsS "$CF_V6_URL")
[[ -n "$V4" && -n "$V6" ]] || { echo "failed to fetch CF IP list"; exit 1; }

echo "==> removing broad 80/443 rules (origin will be reachable from CF only)"
ufw --force delete allow 80/tcp 2>/dev/null || true
ufw --force delete allow 443/tcp 2>/dev/null || true
ufw --force delete allow 443/udp 2>/dev/null || true

# Also remove any prior CF rules so re-running is idempotent.
while read -r num; do
  [[ -n "$num" ]] && ufw --force delete "$num"
done < <(ufw status numbered | awk -F'[][]' '/CF (http|https|http3)/{print $2}' | sort -rn)

echo "==> adding Cloudflare-only rules"
while read -r ip; do
  [[ -z "$ip" ]] && continue
  ufw allow from "$ip" to any port 80  proto tcp comment 'CF http'
  ufw allow from "$ip" to any port 443 proto tcp comment 'CF https'
  ufw allow from "$ip" to any port 443 proto udp comment 'CF http3'
done <<< "$V4
$V6"

echo "==> done"
ufw status verbose
