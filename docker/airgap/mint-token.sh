#!/usr/bin/env bash
# Mint a Vexa API token (scopes: bot,browser,tx) via the admin API and, by
# default, write it into VEXA_API_KEY in the repo-root .env.
#
# Use this when smoke.sh reports ".env VEXA_API_KEY -> 401 (not registered)":
# the token string in .env came from another Vexa's database and doesn't exist
# in this deployment's postgres, so you need to mint one here.
#
# Usage:
#   ./docker/airgap/mint-token.sh                      # user prod@example.com, writes .env
#   ./docker/airgap/mint-token.sh me@example.com "Me"  # custom user
#   ./docker/airgap/mint-token.sh --print-only         # just print, don't touch .env
#
# Only needs curl + network access to the gateway (no docker).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$ROOT/.env"

WRITE=1
POS=()
for a in "$@"; do
  case "$a" in
    --print-only) WRITE=0 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) POS+=("$a") ;;
  esac
done
EMAIL="${POS[0]:-prod@example.com}"
NAME="${POS[1]:-prod}"
SCOPES="bot,browser,tx"

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found" >&2; exit 1; }
getenv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]'; }

PORT="$(getenv API_GATEWAY_HOST_PORT)"; PORT="${PORT:-8056}"
GW="http://localhost:${PORT}"

# Pick the admin key the admin API actually accepts (ADMIN_TOKEN or ADMIN_API_TOKEN).
admincode() { curl -s -o /dev/null -w '%{http_code}' "$GW/admin/users" -H "X-Admin-API-Key: $1" 2>/dev/null || echo 000; }
ADMIN="$(getenv ADMIN_TOKEN)"
if [ "$(admincode "$ADMIN")" != 200 ]; then
  ALT="$(getenv ADMIN_API_TOKEN)"
  if [ -n "$ALT" ] && [ "$(admincode "$ALT")" = 200 ]; then
    ADMIN="$ALT"
  else
    echo "ERROR: no working admin key (tried ADMIN_TOKEN, ADMIN_API_TOKEN) at $GW/admin/users." >&2
    echo "       Is the Vexa stack up? Check the port and admin token in $ENV_FILE." >&2
    exit 1
  fi
fi

echo "==> Creating/looking up user: $EMAIL"
USER_JSON="$(curl -s -X POST "$GW/admin/users" -H "X-Admin-API-Key: $ADMIN" \
  -H "Content-Type: application/json" -d "{\"email\":\"$EMAIL\",\"name\":\"$NAME\"}")"
USER_ID="$(printf '%s' "$USER_JSON" \
  | grep -oE '"id"[[:space:]]*:[[:space:]]*"?[A-Za-z0-9_-]+' | head -1 \
  | sed -E 's/.*[^A-Za-z0-9_-]([A-Za-z0-9_-]+)$/\1/')"
[ -n "$USER_ID" ] || { echo "ERROR: could not create/find user. Response: $USER_JSON" >&2; exit 1; }

echo "==> Minting token (scopes: $SCOPES)"
TOKEN_JSON="$(curl -s -X POST "$GW/admin/users/$USER_ID/tokens?scopes=$SCOPES&name=airgap" \
  -H "X-Admin-API-Key: $ADMIN")"
TOKEN="$(printf '%s' "$TOKEN_JSON" \
  | grep -oE '"token"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 \
  | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "$TOKEN" ] || { echo "ERROR: could not mint token. Response: $TOKEN_JSON" >&2; exit 1; }

echo ""
echo "  user id: $USER_ID"
echo "  token:   $TOKEN"
echo ""

if [ "$WRITE" -eq 1 ]; then
  cp "$ENV_FILE" "$ENV_FILE.bak"
  if grep -qE '^VEXA_API_KEY=' "$ENV_FILE"; then
    sed -i "s|^VEXA_API_KEY=.*|VEXA_API_KEY=$TOKEN|" "$ENV_FILE"
  else
    printf 'VEXA_API_KEY=%s\n' "$TOKEN" >> "$ENV_FILE"
  fi
  echo "  Wrote VEXA_API_KEY into $ENV_FILE  (backup: $ENV_FILE.bak)"
  echo "  Verify:  ./docker/airgap/smoke.sh"
else
  echo "  (--print-only) .env not modified. To use this token, set:"
  echo "    VEXA_API_KEY=$TOKEN   in $ENV_FILE"
fi
