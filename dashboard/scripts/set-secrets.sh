#!/usr/bin/env bash
# Read .env and set all secrets via wrangler in one shot.
# Usage: cd dashboard && bash scripts/set-secrets.sh
#
# The .env file should contain:
#   GOOGLE_CAL_ICS_URL=https://...
#   GOOGLE_CAL_PEOPLE={"Mom":"mom",...}
#   ADMIN_EMAIL=admin@example.com
#   GOOGLE_OAUTH_CLIENT_ID=xxx
#   GOOGLE_OAUTH_CLIENT_SECRET=xxx
#   AUTH_SECRET=xxx
#
# Lines starting with # are ignored. Empty lines are ignored.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "No .env file found at $ENV_FILE"
  echo "Copy .env.example to .env and fill in your values first."
  exit 1
fi

echo "Setting secrets from $ENV_FILE ..."
echo ""

# List of known secrets to look for in .env
SECRETS=(
  "GOOGLE_CAL_ICS_URL"
  "GOOGLE_CAL_PEOPLE"
  "ADMIN_EMAIL"
  "GOOGLE_OAUTH_CLIENT_ID"
  "GOOGLE_OAUTH_CLIENT_SECRET"
  "AUTH_SECRET"
)

set +e  # Don't exit on wrangler errors

for name in "${SECRETS[@]}"; do
  # Extract value for this variable from .env
  value=$(grep -E "^${name}=" "$ENV_FILE" | sed -E "s/^${name}=//" | head -1)

  if [ -z "$value" ]; then
    echo "  ⚠  $name — not set in .env, skipping"
    continue
  fi

  # Strip quotes if present (both single and double)
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"

  echo "  → $name"
  echo "$value" | wrangler secret put "$name" 2>&1 | sed 's/^/    /'
  echo ""
done

echo "Done."