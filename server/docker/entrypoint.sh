#!/usr/bin/env bash
set -euo pipefail

# Self-signed dev certificate in .local/tls unless TLS_KEY_FILE/TLS_CERT_FILE point elsewhere.
# Mount /app/server/.local/tls as a volume to share cert.pem with the frontend and client.
if [[ -z "${TLS_KEY_FILE:-}" && -z "${TLS_CERT_FILE:-}" ]]; then
  # a kept certificate that expired or lacks a TLS_DEV_HOSTS name fails validation: replace it
  npm run cert:dev || npm run cert:dev -- --force
fi

# dev wallets + API keys from /app/dev.env (idempotent)
if [[ "${SEED:-0}" == "1" ]]; then
  npm run seed
fi

exec "$@"
