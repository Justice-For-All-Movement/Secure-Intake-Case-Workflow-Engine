#!/usr/bin/env bash
# One-command local start without Docker: migrate, bootstrap the first
# administrator, build, then run the web app and the background worker.
# Reads .env.local (or .env) when present. Stop with Ctrl-C.
set -euo pipefail
cd "$(dirname "$0")/.."

for file in .env.local .env; do
  if [ -f "$file" ]; then
    set -a; . "./$file"; set +a
    break
  fi
done

: "${DATABASE_URL:?Set DATABASE_URL (see .env.example)}"
export PORT="${PORT:-3100}"
export APP_BASE_URL="${APP_BASE_URL:-http://127.0.0.1:${PORT}}"
export DOCUMENT_STORAGE_ROOT="${DOCUMENT_STORAGE_ROOT:-.data/documents}"

[ -d node_modules ] || npm ci
npm run db:migrate
if [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ] && [ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  npm run auth:bootstrap
fi
if [ "${SKIP_BUILD:-0}" != "1" ] || [ ! -f .next/BUILD_ID ]; then
  npm run build
fi

npm run worker &
worker_pid=$!
trap 'kill "$worker_pid" 2>/dev/null || true' EXIT INT TERM
npx next start --hostname "${HOST:-127.0.0.1}" --port "$PORT"
