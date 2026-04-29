#!/usr/bin/env bash
# Rebuild the amp-dash Docker image and recreate the running container so that
# source edits become live on ampsrev.xyz. The Next.js standalone build is
# baked at image-build time, so file edits on disk are invisible until this
# runs. Caddy auto-reconnects to the new container.
#
# Typical downtime: ~5-15s while the new container becomes healthy.
# Build time: ~1-2 min.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> rebuilding amp-dash"
docker compose up --build -d

echo "==> waiting for healthcheck"
for i in $(seq 1 24); do
  status=$(docker inspect -f '{{.State.Health.Status}}' amp-dash 2>/dev/null || echo missing)
  printf '  [%02d/24] %s\n' "$i" "$status"
  case "$status" in
    healthy)   echo "==> live on ampsrev.xyz"; exit 0 ;;
    unhealthy) echo "container unhealthy — check: docker compose logs amp-dash" >&2; exit 1 ;;
  esac
  sleep 5
done

echo "timed out before healthy — check: docker compose logs amp-dash" >&2
exit 1
