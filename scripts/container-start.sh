#!/bin/sh
# Single-container entry for hosts without separate worker services: migrate, bootstrap the first administrator once
# (when BOOTSTRAP_ADMIN_EMAIL/PASSWORD are set), run the background worker alongside the web application.
set -e
npm run db:migrate
if [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ] && [ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  npm run auth:bootstrap || echo "auth:bootstrap: not run (an administrator already exists or the input is invalid)"
fi
npm run worker &
exec npx next start --hostname 0.0.0.0 --port "${PORT:-3000}"
