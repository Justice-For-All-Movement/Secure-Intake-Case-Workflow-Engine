#!/bin/sh
# Single-container entry for hosts without separate worker services: migrate, bootstrap the first administrator once
# (when BOOTSTRAP_ADMIN_EMAIL/PASSWORD are set), run the background worker alongside the web application.
set -e
npm run db:migrate
if [ -n "${BOOTSTRAP_ADMIN_EMAIL:-}" ] && [ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  npm run auth:bootstrap || echo "auth:bootstrap: not run (an administrator already exists or the input is invalid)"
fi
npm run worker &
# Tor onion service (optional): TOR_ONION_SECRET_KEY is the base64 of the service's hs_ed25519_secret_key file, kept as a
# deployment secret so the onion address stays the same across deploys. Tor forwards onion port 80 to this application;
# no client address ever reaches the application over this route.
if [ -n "${TOR_ONION_SECRET_KEY:-}" ]; then (
  umask 077
  mkdir -p /tmp/tor/hs /tmp/tor/data
  echo "$TOR_ONION_SECRET_KEY" | base64 -d > /tmp/tor/hs/hs_ed25519_secret_key
  printf 'DataDirectory /tmp/tor/data\nSocksPort 0\nHiddenServiceDir /tmp/tor/hs\nHiddenServicePort 80 127.0.0.1:%s\nLog notice stdout\n' "${PORT:-3000}" > /tmp/tor/torrc
  echo "onion service: starting Tor"
  tor -f /tmp/tor/torrc &
) fi
exec npx next start --hostname 0.0.0.0 --port "${PORT:-3000}"
