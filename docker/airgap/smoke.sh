#!/usr/bin/env bash
# Smoke-test the running Vexa API on this host.
#
# Exercises: gateway root, admin-api (through the gateway), a user+token
# bootstrap (DB write), two authenticated endpoints, and the transcription
# service's health from inside the network. Creates one throwaway user
# (smoke@test.local); safe to re-run.
#
# Usage:  ./docker/airgap/smoke.sh
# Exit 0 = all checks passed, non-zero = at least one failed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

[ -f .env ] || { echo "Error: .env not found in $ROOT" >&2; exit 1; }

getenv() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '[:space:]'; }

GWPORT="$(getenv API_GATEWAY_HOST_PORT)"; GWPORT="${GWPORT:-8056}"
GW="http://localhost:${GWPORT}"
ADMIN="$(getenv ADMIN_TOKEN)"
ADMIN_ALT="$(getenv ADMIN_API_TOKEN)"

# color only when attached to a terminal
if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; Z=$'\033[0m'; else G=; R=; Z=; fi
pass=0; fail=0
report() { # ok label detail
  if [ "$1" = ok ]; then printf "  ${G}PASS${Z}  %-24s %s\n" "$2" "${3:-}"; pass=$((pass+1))
  else printf "  ${R}FAIL${Z}  %-24s %s\n" "$2" "${3:-}"; fail=$((fail+1)); fi
}
code() { curl -sS -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo 000; }
expect() { [ "$1" = "$2" ] && report ok "$3" "$1" || report no "$3" "got $1 (want $2)"; }

echo "== Vexa API smoke test =="
echo "   gateway: $GW"

# 1) gateway alive
expect "$(code "$GW/")" 200 "GET /"

# 2) admin-api reachable (auto-pick the working admin key)
AC="$(code "$GW/admin/users" -H "X-Admin-API-Key: $ADMIN")"
if [ "$AC" != 200 ] && [ -n "$ADMIN_ALT" ]; then
  ALT="$(code "$GW/admin/users" -H "X-Admin-API-Key: $ADMIN_ALT")"
  [ "$ALT" = 200 ] && { ADMIN="$ADMIN_ALT"; AC="$ALT"; }
fi
expect "$AC" 200 "GET /admin/users"

# 3) create throwaway user + scoped token.
#    - email must use a real TLD (email-validator rejects reserved ones like .local)
#    - parse with grep/sed so we don't depend on python3 being installed
#    - note: UID is readonly in bash, hence USER_ID
USER_JSON="$(curl -sS -X POST "$GW/admin/users" -H "X-Admin-API-Key: $ADMIN" \
               -H "Content-Type: application/json" \
               -d '{"email":"smoke@example.com","name":"smoke"}' 2>/dev/null)"
USER_ID="$(printf '%s' "$USER_JSON" \
           | grep -oE '"id"[[:space:]]*:[[:space:]]*"?[A-Za-z0-9_-]+' | head -1 \
           | sed -E 's/.*[^A-Za-z0-9_-]([A-Za-z0-9_-]+)$/\1/')"
TOKEN_JSON="$(curl -sS -X POST "$GW/admin/users/$USER_ID/tokens?scopes=bot,browser,tx&name=smoke" \
               -H "X-Admin-API-Key: $ADMIN" 2>/dev/null)"
TOKEN="$(printf '%s' "$TOKEN_JSON" \
         | grep -oE '"token"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 \
         | sed -E 's/.*"([^"]+)"$/\1/')"
if [ -n "$USER_ID" ] && [ -n "$TOKEN" ]; then
  report ok "create user+token" "id=$USER_ID token=${TOKEN:0:12}..."
else
  report no "create user+token" "resp: $(printf '%s' "$USER_JSON" | head -c 160)"
fi

# 4) authenticated endpoints
if [ -n "$TOKEN" ]; then
  expect "$(code "$GW/meetings"    -H "X-API-Key: $TOKEN")" 200 "GET /meetings"
  expect "$(code "$GW/bots/status" -H "X-API-Key: $TOKEN")" 200 "GET /bots/status"
else
  report no "GET /meetings"    "skipped (no token)"
  report no "GET /bots/status" "skipped (no token)"
fi

# 5) the VEXA_API_KEY already in .env — what browser-session.sh and API clients
#    use. GET /meetings needs the 'browser' scope; an unregistered key -> 401,
#    a valid-but-under-scoped (e.g. bot-only) key -> 403.
EKEY="$(getenv VEXA_API_KEY)"
if [ -n "$EKEY" ]; then
  EC="$(code "$GW/meetings" -H "X-API-Key: $EKEY")"
  case "$EC" in
    200) report ok ".env VEXA_API_KEY" "valid (browser scope)";;
    401) report no ".env VEXA_API_KEY" "401 — key not registered / invalid";;
    403) report no ".env VEXA_API_KEY" "403 — valid but missing 'browser' scope";;
    *)   report no ".env VEXA_API_KEY" "got $EC (want 200)";;
  esac
else
  report no ".env VEXA_API_KEY" "not set in .env"
fi

# 6) transcription LB reachable from inside the stack
TX="$(docker compose --env-file .env -f deploy/compose/docker-compose.yml exec -T meeting-api \
        python -c "import urllib.request as u;print(u.urlopen('http://transcription-service/health',timeout=5).status)" 2>/dev/null || echo ERR)"
expect "$TX" 200 "transcription /health"

echo ""
echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
