#!/usr/bin/env bash
# Bring amp-dash up on a fresh host. Run from inside the cloned repo dir
# (e.g. amplified-dashboard/) after `git clone` and after copying .env.local
# into place. Optionally drop amp-db.tgz next to this script to seed the
# SQLite cache from a snapshot of the previous host's docker volume; without
# it, the indexer backfills from AMP_LAUNCH_TS over RPC.
#
# Idempotent: rerun safely. To force a clean rebuild, prefix with FRESH=1.
set -euo pipefail

cd "$(dirname "$0")"

PROJECT="$(basename "$PWD")"
VOLUME="${PROJECT}_amp-dash-data"
CONTAINER="amp-dash"

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

say "project=$PROJECT  volume=$VOLUME"

# --- 1. sanity checks --------------------------------------------------------
command -v docker >/dev/null \
  || die "docker not installed (apt install docker.io docker-compose-plugin && add user to docker group)"
docker compose version >/dev/null 2>&1 \
  || die "'docker compose' plugin missing — install docker-compose-plugin"
[[ -f .env.local ]] \
  || die ".env.local missing — scp it from the previous host before running this"

# --- 2. seed volume from snapshot, if provided -------------------------------
# Only seed when the volume doesn't already exist; restoring on top of an
# in-use volume would clobber whatever's been indexed since the snapshot.
if [[ -f amp-db.tgz ]]; then
  if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
    say "volume $VOLUME already exists; skipping restore"
    say "  to re-seed: docker compose down && docker volume rm $VOLUME && rerun this script"
  else
    say "restoring amp-db.tgz into volume $VOLUME"
    docker volume create "$VOLUME" >/dev/null
    docker run --rm \
      -v "$VOLUME":/data \
      -v "$PWD":/backup \
      alpine tar xzf /backup/amp-db.tgz -C /data
  fi
else
  say "no amp-db.tgz found; indexer will backfill from AMP_LAUNCH_TS"
fi

# --- 3. build & start --------------------------------------------------------
if [[ "${FRESH:-0}" == "1" ]]; then
  say "FRESH=1 set; tearing down existing containers (volume preserved)"
  docker compose down --remove-orphans || true
fi

say "docker compose up --build -d"
docker compose up --build -d

# --- 4. wait for healthcheck -------------------------------------------------
# Compose's healthcheck hits /api/amp/summary every 30s. start_period is 20s,
# so give it ~3 minutes total before declaring failure.
say "waiting for healthcheck (up to ~3 min)…"
for i in $(seq 1 36); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
  printf '  [%02d/36] %s\n' "$i" "$status"
  case "$status" in
    healthy)   break ;;
    unhealthy) die "container reports unhealthy — check: docker compose logs $CONTAINER" ;;
  esac
  sleep 5
done

[[ "$status" == "healthy" ]] || die "timed out before healthy — check: docker compose logs $CONTAINER"

say "up on :3100. tail logs with: docker compose logs -f"
