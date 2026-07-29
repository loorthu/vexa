#!/usr/bin/env bash
# browser-session — run the long-lived, human-authenticated browser that meeting bots attach to.
#
# A meeting bot requested with authenticated=true does NOT log into Google itself — it attaches over
# CDP to a browser you logged in ONCE here, over noVNC. This script runs that browser as a sidecar:
# the same bot image (BROWSER_IMAGE) launched in session mode (BOT_WORKER_ENTRY=dist/session.js), on
# the stack's compose network, named `vexa-browser-session-<user_id>` — the exact name meeting-api
# resolves to `http://vexa-browser-session-<user_id>:9222` (bot_spawn/service.py). The login profile
# lives on a per-user docker volume, so it survives restarts.
#
# It is a plain `docker run` (NOT a meeting-api /bots call): a browser_session is infra, not a meeting.
# Needs Docker access (sudo on hosts where Docker is root-only).
#
# Usage:
#   deploy/compose/bin/browser-session.sh [up]     Ensure the session is running; print noVNC + CDP. (default)
#   deploy/compose/bin/browser-session.sh status    Show the container + its noVNC/CDP endpoints.
#   deploy/compose/bin/browser-session.sh stop       Stop + remove the container (keeps the login volume).
#   deploy/compose/bin/browser-session.sh reset       Stop, DELETE the login volume, start fresh (re-login).
#   deploy/compose/bin/browser-session.sh logs         Follow the container logs.
#   deploy/compose/bin/browser-session.sh login-status  Probe whether the session is still signed in
#                                                        (prints logged_in|logged_out|error; exit 0|1|2).
#
# Which user? The container is per-user so its name matches the API key that will request bots.
#   USER_ID=<n>                explicit user id (skips lookup), OR
#   EMAIL + ADMIN_TOKEN        resolve the id from admin-api (default EMAIL self-host@vexa.ai — the
#                              same user provision-token mints for). ADMIN_TOKEN is the stack admin secret.
#
# Env knobs (all optional; defaults match deploy/compose/.env):
#   BROWSER_IMAGE (vexaai/vexa-bot:v012) · COMPOSE_PROJECT_NAME (vexa-v012) · SESSION_PLATFORM (google)
#   ADMIN_API_URL (http://127.0.0.1:18057) · VNC_HOST_PORT (host port for noVNC; default auto-assigned)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$COMPOSE_DIR/.env" ] && set -a && . "$COMPOSE_DIR/.env" && set +a

PROJECT="${COMPOSE_PROJECT_NAME:-vexa-v012}"
NETWORK="${PROJECT}_vexa"
IMAGE="${BROWSER_IMAGE:-vexaai/vexa-bot:v012}"
PLATFORM="${SESSION_PLATFORM:-google}"
ADMIN_API="${ADMIN_API_URL:-http://127.0.0.1:18057}"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker not found / not accessible (try sudo)." >&2; exit 1; }

# Help before anything that needs Docker or the stack.
case "${1:-up}" in -h|--help|help) sed -n '10,30p' "$0"; exit 0 ;; esac

# Resolve the user id: explicit USER_ID wins; else look it up from EMAIL via admin-api (same call
# provision-token uses). We need the id, not the email, because the container name IS the id.
resolve_uid() {
  if [ -n "${USER_ID:-}" ]; then echo "$USER_ID"; return; fi
  local email="${EMAIL:-self-host@vexa.ai}"
  : "${ADMIN_TOKEN:?set USER_ID=<n>, or EMAIL + ADMIN_TOKEN so the id can be resolved from admin-api}"
  local uid
  uid="$(curl -fsS -H "X-Admin-API-Key: ${ADMIN_TOKEN}" "${ADMIN_API}/admin/users/email/${email}" 2>/dev/null \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' 2>/dev/null || true)"
  [ -n "$uid" ] || { echo "ERROR: could not resolve a user id for '${email}' — run provision-token first, or pass USER_ID." >&2; exit 1; }
  echo "$uid"
}

UID_="$(resolve_uid)"
NAME="vexa-browser-session-${UID_}"
VOLUME="${NAME}-data"

_exists()  { docker inspect "$NAME" >/dev/null 2>&1; }
_running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" = "true" ]; }
_ip()      { docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$NAME" 2>/dev/null; }

print_endpoints() {
  local ip host_port
  ip="$(_ip)"
  # noVNC: prefer the published host port if we published one; else the container IP on the stack net
  # (reachable from the docker host — tunnel to it if you're remote).
  host_port="$(docker inspect -f '{{range $p,$c := .NetworkSettings.Ports}}{{if eq $p "6080/tcp"}}{{(index $c 0).HostPort}}{{end}}{{end}}' "$NAME" 2>/dev/null || true)"
  echo "  Container : ${NAME}  (user ${UID_}, network ${NETWORK})"
  if [ -n "$host_port" ]; then
    echo "  noVNC     : http://localhost:${host_port}/vnc.html    (log into ${PLATFORM} here)"
  fi
  [ -n "$ip" ] && echo "  noVNC (IP): http://${ip}:6080/vnc.html    (from the docker host)"
  # Bots attach on :9223 — a socat relay (session.ts) forwards it to Chrome's loopback-only :9222.
  echo "  CDP       : ${ip:+http://$ip:9223}  — bots attach here as http://${NAME}:9223 on ${NETWORK}"
}

start_container() {
  echo "Starting ${NAME} (image ${IMAGE}, network ${NETWORK})..."
  docker network inspect "$NETWORK" >/dev/null 2>&1 || {
    echo "ERROR: network '${NETWORK}' not found — is the stack up? (make -C deploy/compose up)" >&2; exit 1; }
  # Publish noVNC to the host so the login page is reachable without knowing the container IP. A fixed
  # VNC_HOST_PORT if set, else a bare container port so Docker auto-assigns one (avoids clashes when
  # several users each run a session — read the actual port back from `status`).
  local publish=()
  if [ -n "${VNC_HOST_PORT:-}" ]; then publish=(-p "${VNC_HOST_PORT}:6080"); else publish=(-p 6080); fi
  docker run -d --name "$NAME" \
    --network "$NETWORK" \
    "${publish[@]}" \
    -v "${VOLUME}:/tmp/browser-data" \
    -e BOT_WORKER_ENTRY=dist/session.js \
    -e SESSION_PLATFORM="$PLATFORM" \
    -e BROWSER_DATA_DIR=/tmp/browser-data \
    --restart unless-stopped \
    "$IMAGE" >/dev/null
  # Give session.ts a moment to launch Chromium + bring up VNC.
  for _ in $(seq 1 15); do _running && [ -n "$(_ip)" ] && break; sleep 1; done
  _running || { echo "ERROR: ${NAME} did not stay up — check: docker logs ${NAME}" >&2; exit 1; }
}

case "${1:-up}" in
  up|"")
    if _running; then echo "Already running:"; else
      _exists && docker rm -f "$NAME" >/dev/null 2>&1 || true
      start_container
      echo "Ready:"
    fi
    print_endpoints
    ;;
  status|list|ls)
    if _exists; then
      echo "State: $(docker inspect -f '{{.State.Status}}' "$NAME")"
      print_endpoints
    else
      echo "No session for user ${UID_} (${NAME}). Start one: $0 up"
    fi
    ;;
  stop)
    if _exists; then docker rm -f "$NAME" >/dev/null && echo "Stopped ${NAME} (login volume ${VOLUME} kept)."; else echo "Nothing to stop (${NAME})."; fi
    ;;
  reset)
    _exists && docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 && echo "Deleted login volume ${VOLUME}." || true
    start_container
    echo "Fresh session (you must log in again):"
    print_endpoints
    ;;
  logs)
    _exists || { echo "No container ${NAME}." >&2; exit 1; }
    exec docker logs -f "$NAME"
    ;;
  login-status)
    _running || { echo "error"; echo "Session ${NAME} is not running (start it: $0 up)." >&2; exit 2; }
    # Delegate the CDP probe to login-watch.py, scoped to this session's container + platform.
    exec env BROWSER_SESSION_CONTAINER="$NAME" SESSION_PLATFORM="$PLATFORM" \
      python3 "$SCRIPT_DIR/login-watch.py" --check
    ;;
  *)
    echo "Unknown command '${1}'. Try: up | status | stop | reset | logs | login-status | help" >&2; exit 1 ;;
esac
