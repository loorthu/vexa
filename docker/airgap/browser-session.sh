#!/usr/bin/env bash
# Manage the Vexa browser_session used to authenticate meeting bots.
#
# The printed VNC URL is where you log into Google; that Chrome session is then
# shared by all authenticated meeting bots via CDP.
#
# Pure Vexa client: talks only to the Vexa API + Docker (no DNA dependency).
# Works in dev and prod (air-gapped). Config from the repo-root .env, overridable
# via the environment:
#   VEXA_API_URL   default: http://localhost:<API_GATEWAY_HOST_PORT from .env, else 8056>
#   VEXA_API_KEY   default: VEXA_API_KEY from .env
#
# Docker access is required. On hosts where docker needs root, run with sudo.
# To override the key under sudo (which strips the environment):
#   sudo env VEXA_API_KEY=<token> ./docker/airgap/browser-session.sh
#
# Usage:
#   ./browser-session.sh            Ensure one session is running; print its VNC URL (default).
#   ./browser-session.sh list [all] List bot containers (auth + meeting) with VNC/CDP links (all=incl. exited).
#   ./browser-session.sh reset      Stop ALL sessions (+ stray containers), then start a fresh one.
#   ./browser-session.sh stop       Stop ALL sessions without starting a new one.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$ROOT/.env"

# Help before any preflight so it works without a running stack.
case "${1:-}" in -h|--help|help) sed -n '17,21p' "$0"; exit 0 ;; esac

getenv() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]'; }

if [[ -z "${VEXA_API_URL:-}" ]]; then
    PORT="$(getenv API_GATEWAY_HOST_PORT)"; PORT="${PORT:-8056}"
    VEXA_API_URL="http://localhost:${PORT}"
fi
if [[ -z "${VEXA_API_KEY:-}" ]]; then
    VEXA_API_KEY="$(getenv VEXA_API_KEY)"
fi
if [[ -z "$VEXA_API_KEY" ]]; then
    echo "ERROR: VEXA_API_KEY not set and not found in $ENV_FILE" >&2
    echo "       Export VEXA_API_KEY, or add VEXA_API_KEY=... to $ENV_FILE" >&2
    exit 1
fi

command -v python3 >/dev/null || { echo "ERROR: python3 is required by this script." >&2; exit 1; }

# Preflight: API reachable + token valid.
if ! curl -sf -o /dev/null "$VEXA_API_URL/meetings" -H "X-API-Key: $VEXA_API_KEY"; then
    echo "ERROR: cannot reach $VEXA_API_URL/meetings with the given key." >&2
    echo "       Check the Vexa stack is up and VEXA_API_KEY is a valid, registered token." >&2
    echo "       On a fresh deploy, mint one via the admin API (see docker/airgap/mint-token.sh)." >&2
    exit 1
fi

# Docker is required to read/manage session containers. On hosts where docker
# needs root, run this script with sudo.
if ! docker info >/dev/null 2>&1; then
    echo "ERROR: cannot access Docker (needed to read/manage session containers)." >&2
    echo "       Re-run with sudo:  sudo $0 $*" >&2
    exit 1
fi

# --- helpers ---------------------------------------------------------------

# All active browser_sessions from the API, one per line: id<TAB>container<TAB>native_id
# (most-recent first).
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

_container_exists() { docker inspect "$1" >/dev/null 2>&1; }
_container_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]; }

_container_ip() {
    docker inspect "$1" 2>/dev/null | python3 -c "
import sys, json
try:
    nets = json.load(sys.stdin)[0]['NetworkSettings']['Networks']
except Exception:
    sys.exit(0)
for net in nets.values():
    ip = net.get('IPAddress', '')
    if ip:
        print(ip); break
" 2>/dev/null || true
}

# Stop a session: tell Vexa to end it (by native id), then force-remove the
# container (in case it lingers). Both are best-effort.
_stop_session() {  # $1=native_id  $2=container
    [[ -n "$1" ]] && curl -sf -X DELETE "$VEXA_API_URL/bots/browser_session/$1" \
        -H "X-API-Key: $VEXA_API_KEY" >/dev/null 2>&1 || true
    [[ -n "$2" ]] && docker rm -f "$2" >/dev/null 2>&1 || true
}

show_vnc() {  # $1=container
    local ip; ip="$(_container_ip "$1")"
    if [[ -z "$ip" ]]; then
        echo "ERROR: could not get IP for container '$1'." >&2
        echo "       If docker needs root on this host, re-run: sudo $0 $*" >&2
        exit 1
    fi
    echo ""
    echo "    VNC URL: http://$ip:6080/vnc_auto.html"
    echo ""
    echo "    Docker-internal IP — open it from the Docker host (or a machine on"
    echo "    the Docker network). Log into Google there; authenticated meeting"
    echo "    bots share this Chrome session via CDP."
}

create_and_show() {
    echo "    Creating browser_session..."
    curl -sf -X POST "$VEXA_API_URL/bots" \
        -H "X-API-Key: $VEXA_API_KEY" \
        -H "Content-Type: application/json" \
        -d '{"mode": "browser_session"}' > /dev/null
    echo "    Waiting for container to start..."
    local container=""
    for _ in $(seq 1 20); do
        container="$(_get_sessions | head -1 | cut -f2)"
        [[ -n "$container" ]] && _container_exists "$container" && break
        container=""
        sleep 2
    done
    if [[ -z "$container" ]]; then
        echo "ERROR: browser_session did not become active after 40s." >&2
        echo "       Check: docker logs \$(docker ps -q --filter name=browser-session | head -1)" >&2
        exit 1
    fi
    echo "    Container started: $container"
    show_vnc "$container"
}

# Stop sessions the API reports active but whose container is gone (ghosts).
clear_ghosts() {
    local sessions; sessions="$(_get_sessions)"
    [[ -z "$sessions" ]] && return 0
    while IFS=$'\t' read -r id container native_id; do
        [[ -z "$id" ]] && continue
        if ! _container_exists "$container"; then
            echo "    Clearing ghost session: meeting $id ($container — container missing)"
            _stop_session "$native_id" "$container"
        fi
    done <<< "$sessions"
}

stop_all() {
    local sessions; sessions="$(_get_sessions)"
    if [[ -n "$sessions" ]]; then
        while IFS=$'\t' read -r id container native_id; do
            [[ -z "$id" ]] && continue
            echo "    Stopping session: meeting $id ($container)"
            _stop_session "$native_id" "$container"
        done <<< "$sessions"
    fi
    # Sweep any stray browser-session containers not tracked by the API.
    local stray; stray="$(docker ps -aq --filter name=browser-session 2>/dev/null || true)"
    if [[ -n "$stray" ]]; then
        echo "    Removing stray browser-session containers..."
        docker rm -f $stray >/dev/null 2>&1 || true
    fi
}

# --- commands --------------------------------------------------------------

# VNC/CDP link helpers. A published host port (browser_session publishes 6080)
# -> localhost:<port>; otherwise the container's internal IP (meeting bots keep
# VNC on 6080 but don't publish it).
_port_pub() { docker port "$1" "$2" 2>/dev/null | head -1 | sed 's/.*://'; }
_vnc_url() {  # $1=id  $2=ip
    local p; p="$(_port_pub "$1" 6080/tcp)"
    if [[ -n "$p" ]]; then echo "http://localhost:${p}/vnc_auto.html"
    elif [[ -n "$2" ]]; then echo "http://${2}:6080/vnc_auto.html"
    else echo "-"; fi
}
_cdp_addr() {  # $1=id  $2=ip
    local p; p="$(_port_pub "$1" 9222/tcp)"
    if [[ -n "$p" ]]; then echo "localhost:${p}"
    elif [[ -n "$2" ]]; then echo "${2}:9222"
    else echo "-"; fi
}

# List ALL runtime-managed bot containers (auth browser_session + meeting bots)
# with their VNC + CDP links — for troubleshooting.
cmd_list() {
    local psq="-q"
    [[ "${1:-}" == "all" || "${1:-}" == "-a" ]] && psq="-aq"   # include exited bots
    local ids; ids="$(docker ps $psq --filter 'label=runtime.managed=true' 2>/dev/null)"
    if [[ -z "$ids" ]]; then echo "No bot containers."; return 0; fi
    printf "%-28s  %-15s  %-8s  %-38s  %s\n" "CONTAINER" "TYPE" "STATUS" "VNC" "CDP"
    local id name type status ip
    for id in $ids; do
        name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##')"
        status="$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null)"
        ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$id" 2>/dev/null | awk '{print $1}')"
        case "$name" in
            browser-session-*) type="browser_session";;
            meeting-*)         type="meeting";;
            *)                 type="other";;
        esac
        printf "%-28s  %-15s  %-8s  %-38s  %s\n" "$name" "$type" "$status" "$(_vnc_url "$id" "$ip")" "$(_cdp_addr "$id" "$ip")"
    done
    echo ""
    echo "  'localhost:<port>' links work from the Docker host; 'http://172.x:6080'"
    echo "  links are Docker-internal (open from the host or a machine on that network)."
}

cmd_reset() {
    echo "==> Clearing all browser_sessions..."
    stop_all
    echo "==> Starting a fresh browser_session..."
    create_and_show
}

cmd_stop() {
    echo "==> Stopping all browser_sessions..."
    stop_all
    echo "    Done."
}

cmd_ensure() {
    echo "==> Checking for active browser_sessions..."
    clear_ghosts
    # Reuse the most-recent session whose container actually exists; stop the rest.
    local chosen="" sessions; sessions="$(_get_sessions)"
    while IFS=$'\t' read -r id container native_id; do
        [[ -z "$id" ]] && continue
        if _container_exists "$container"; then
            if [[ -z "$chosen" ]]; then
                chosen="$id"$'\t'"$container"
            else
                echo "    Stopping redundant session: meeting $id ($container)"
                _stop_session "$native_id" "$container"
            fi
        fi
    done <<< "$sessions"

    if [[ -n "$chosen" ]]; then
        echo "    Using existing session: meeting $(cut -f1 <<< "$chosen") ($(cut -f2 <<< "$chosen"))"
        show_vnc "$(cut -f2 <<< "$chosen")"
    else
        echo "    None usable."
        create_and_show
    fi
}

case "${1:-ensure}" in
    ""|ensure)      cmd_ensure ;;
    list|ls)        cmd_list "${2:-}" ;;
    reset|fresh)    cmd_reset ;;
    stop|clear)     cmd_stop ;;
    -h|--help|help) sed -n '17,21p' "$0" ;;
    *) echo "Unknown command: $1" >&2; sed -n '17,21p' "$0" >&2; exit 1 ;;
esac
