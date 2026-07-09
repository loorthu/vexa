#!/usr/bin/env bash
# Ensure exactly one Vexa browser_session is running and print its VNC URL.
# If multiple active sessions exist, keeps the most recent and stops the rest.
#
# Use the printed URL to authenticate with Google — that Chrome session is then
# shared by all authenticated meeting bots via CDP.
#
# This is a pure Vexa client: it talks only to the Vexa API + Docker. It does
# NOT require the DNA stack. Works in dev and prod (air-gapped); all config is
# read from the repo-root .env, overridable via the environment:
#
#   VEXA_API_URL   default: http://localhost:<API_GATEWAY_HOST_PORT from .env, else 8056>
#   VEXA_API_KEY   default: VEXA_API_KEY from .env
#
# Docker access is required. On hosts where docker needs root, run with sudo.
# To override the key under sudo (which strips the environment):
#   sudo env VEXA_API_KEY=<token> ./docker/airgap/browser-session.sh
#
# Usage: ./docker/airgap/browser-session.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$ROOT/.env"

getenv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]'; }

# API URL: env override, else localhost:<gateway host port from .env>.
if [[ -z "${VEXA_API_URL:-}" ]]; then
    PORT="$(getenv API_GATEWAY_HOST_PORT)"; PORT="${PORT:-8056}"
    VEXA_API_URL="http://localhost:${PORT}"
fi

# API key: env override, else from .env.
if [[ -z "${VEXA_API_KEY:-}" ]]; then
    VEXA_API_KEY="$(getenv VEXA_API_KEY)"
fi
if [[ -z "$VEXA_API_KEY" ]]; then
    echo "ERROR: VEXA_API_KEY not set and not found in $ENV_FILE" >&2
    echo "       Export VEXA_API_KEY, or add VEXA_API_KEY=... to $ENV_FILE" >&2
    exit 1
fi

command -v python3 >/dev/null || { echo "ERROR: python3 is required by this script." >&2; exit 1; }

# Preflight: API reachable + token valid (clear error instead of a confusing
# "no sessions -> create fails" path on a bad/unregistered token).
if ! curl -sf -o /dev/null "$VEXA_API_URL/meetings" -H "X-API-Key: $VEXA_API_KEY"; then
    echo "ERROR: cannot reach $VEXA_API_URL/meetings with the given key." >&2
    echo "       Check the Vexa stack is up and VEXA_API_KEY is a valid, registered token." >&2
    echo "       On a fresh deploy, mint one via the admin API (see docker/airgap/smoke.sh)." >&2
    exit 1
fi

# Docker is required to read the session container's IP. On hosts where docker
# needs root, run this script with sudo — otherwise the session gets created
# but the IP lookup fails.
if ! docker info >/dev/null 2>&1; then
    echo "ERROR: cannot access Docker (needed to read the session container IP)." >&2
    echo "       Re-run with sudo:  sudo $0" >&2
    exit 1
fi

_get_sessions() {
    curl -sf "$VEXA_API_URL/meetings" -H "X-API-Key: $VEXA_API_KEY" 2>/dev/null \
    | python3 -c "
import sys, json
sessions = []
for m in json.load(sys.stdin).get('meetings', []):
    if m.get('platform') == 'browser_session' and m.get('status') == 'active' and m.get('bot_container_id'):
        sessions.append((m['id'], m['bot_container_id'], m.get('native_meeting_id', '')))
for s in sorted(sessions, key=lambda x: x[0], reverse=True):
    print(f'{s[0]}\t{s[1]}\t{s[2]}')
" 2>/dev/null || true
}

# --- Cull redundant sessions, keep most recent ---
echo "==> Checking for active browser_sessions..."
SESSIONS=$(_get_sessions)
if [[ -z "$SESSIONS" ]]; then
    SESSION_COUNT=0
else
    SESSION_COUNT=$(echo "$SESSIONS" | wc -l | tr -d ' ')
fi

if [[ "$SESSION_COUNT" -gt 1 ]]; then
    echo "    Found $SESSION_COUNT sessions — keeping most recent, stopping others..."
    while IFS=$'\t' read -r id container native_id; do
        [[ -z "$id" ]] && continue
        echo "    Stopping redundant session: meeting $id ($container)"
        curl -sf -X DELETE "$VEXA_API_URL/bots/browser_session/$native_id" \
            -H "X-API-Key: $VEXA_API_KEY" > /dev/null 2>&1 || true
        docker stop "$container" 2>/dev/null || true
    done <<< "$(echo "$SESSIONS" | tail -n +2)"
    SESSIONS=$(echo "$SESSIONS" | head -1)
    SESSION_COUNT=1
fi

# --- Use existing or create new ---
if [[ "$SESSION_COUNT" -eq 1 ]]; then
    CONTAINER=$(echo "$SESSIONS" | cut -f2)
    MEETING_ID=$(echo "$SESSIONS" | cut -f1)
    echo "    Using existing session: meeting $MEETING_ID ($CONTAINER)"
else
    echo "    None found. Creating browser_session..."
    curl -sf -X POST "$VEXA_API_URL/bots" \
        -H "X-API-Key: $VEXA_API_KEY" \
        -H "Content-Type: application/json" \
        -d '{"mode": "browser_session"}' > /dev/null

    echo "    Waiting for container to start..."
    for i in $(seq 1 20); do
        SESSIONS=$(_get_sessions)
        CONTAINER=$(echo "$SESSIONS" | head -1 | cut -f2)
        [[ -n "$CONTAINER" ]] && break
        sleep 2
    done

    if [[ -z "$CONTAINER" ]]; then
        echo "ERROR: browser_session did not become active after 40s."
        echo "       Check: docker logs \$(docker ps -q --filter name=browser-session | head -1)"
        exit 1
    fi
    echo "    Container started: $CONTAINER"
fi

# --- Get container IP ---
IP=$(docker inspect "$CONTAINER" 2>/dev/null | python3 -c "
import sys, json
nets = json.load(sys.stdin)[0]['NetworkSettings']['Networks']
for net in nets.values():
    ip = net.get('IPAddress', '')
    if ip:
        print(ip)
        break
" 2>/dev/null || true)

if [[ -z "$IP" ]]; then
    echo "ERROR: Could not get IP for container '$CONTAINER'."
    echo "       If docker needs root on this host, re-run: sudo $0"
    exit 1
fi

echo ""
echo "    VNC URL: http://$IP:6080/vnc_auto.html"
echo ""
echo "    This is a Docker-internal IP — open it from the Docker host (or a"
echo "    machine on the Docker network). Log into Google there; all"
echo "    authenticated meeting bots will share this Chrome session via CDP."
