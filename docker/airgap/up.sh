#!/usr/bin/env bash
# Start the full Vexa stack on the air-gapped prod server from pre-loaded
# images. Never builds, never pulls.
#
# Order matters: the core stack creates the `vexa_vexa` network that the
# transcription load-balancer attaches to.
#
# Requires on prod: docker, an NVIDIA GPU + nvidia-container-toolkit, and a
# populated repo-root .env (copy your working .env over, or start from
# deploy/env-example).
#
# Usage:  ./docker/airgap/up.sh [tag]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < VERSION)"
TAG="${1:-${AIRGAP_TAG:-$(cat "$SCRIPT_DIR/dist/AIRGAP_TAG" 2>/dev/null || echo "$VERSION")}}"

if [ ! -f .env ]; then
  echo "Error: repo-root .env not found. Copy your working .env here, or:" >&2
  echo "  cp deploy/env-example .env  &&  edit it" >&2
  exit 1
fi

# Pin the tag of the loaded images and the on-demand bot image. Exported env
# overrides whatever IMAGE_TAG/BROWSER_IMAGE are set to in .env.
export IMAGE_TAG="$TAG"
export BROWSER_IMAGE="vexaai/vexa-bot:$TAG"
echo "==> Using IMAGE_TAG=$IMAGE_TAG  BROWSER_IMAGE=$BROWSER_IMAGE"

# 1) Core stack. dns.prod.yml disables the corporate DNS search-domain suffix so
#    single-label service names (e.g. redis) resolve to the internal containers
#    instead of colliding with corporate records (e.g. redis.spimageworks.com).
echo "==> Starting core stack..."
# tts-service (Piper TTS) is disabled via --scale tts-service=0: it downloads
# voice models from the internet at startup (fails + crash-loops on an
# air-gapped host) and DNA does not use text-to-speech. Nothing depends_on it.
# To enable TTS later: pre-seed the Piper voices into the tts-voices volume and
# drop the --scale flag.
docker compose --env-file .env \
  -f deploy/compose/docker-compose.yml \
  -f docker/airgap/dns.prod.yml \
  up -d --no-build --scale tts-service=0

# 2) Transcription needs two external networks. `vexa_vexa` was just created by
#    the core stack; `vexa-network` is external too — create it if missing.
docker network inspect vexa-network >/dev/null 2>&1 || docker network create vexa-network >/dev/null

echo "==> Starting GPU transcription workers..."
# Pinned project name so up/down manage the same stack regardless of the repo
# directory name (which would otherwise become the default project).
docker compose -p vexa-transcription --env-file .env \
  -f services/transcription-service/docker-compose.yml \
  -f docker/airgap/transcription.prod.yml \
  up -d --no-build

echo ""
echo "==> Vexa stack is up."
echo "    API gateway:  http://localhost:${API_GATEWAY_HOST_PORT:-8056}"
echo "    Dashboard:    http://localhost:${DASHBOARD_HOST_PORT:-3001}"
echo "    Logs:         docker compose -f deploy/compose/docker-compose.yml logs -f"
echo "    Stop:         ./docker/airgap/down.sh"
