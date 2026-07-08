#!/usr/bin/env bash
# Build every Vexa image needed for an air-gapped deployment.
# Run this on a machine WITH internet (base images + pip/npm pulled here).
#
# Produces (all tagged :$TAG, default = contents of VERSION):
#   vexaai/api-gateway  vexaai/admin-api  vexaai/runtime-api  vexaai/meeting-api
#   vexaai/mcp  vexaai/dashboard  vexaai/tts-service          (core compose stack)
#   vexaai/vexa-bot                                           (spawned on demand by runtime-api)
#   vexaai/vexa-transcription                                 (GPU Whisper worker)
#
# Usage:
#   ./docker/airgap/build.sh            # tag = VERSION
#   ./docker/airgap/build.sh 0.10.6.3   # explicit tag
#
# Next step:  ./docker/airgap/save.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < VERSION)"
TAG="${1:-${AIRGAP_TAG:-$VERSION}}"
DATE="$(date +%Y-%m-%d)"
PLATFORM="linux/amd64"   # prod server is x86_64 Linux

echo "==> Building Vexa air-gap images (tag: $TAG, platform: $PLATFORM)"
echo ""

# 1) Core compose services. The compose file carries the correct build
#    contexts and build-args (e.g. the dashboard VEXA_VERSION guard), so we
#    let compose build them. Shell IMAGE_TAG overrides the value in .env.
echo "==> [1/3] core services (api-gateway, admin-api, runtime-api, meeting-api, mcp, dashboard, tts-service)"
IMAGE_TAG="$TAG" VEXA_VERSION="$VERSION" VEXA_RELEASE_DATE="$DATE" \
  docker compose --env-file .env -f deploy/compose/docker-compose.yml build

# 2) Bot image. NOT a compose service — runtime-api launches it on demand via
#    the Docker socket (BROWSER_IMAGE). Must be built & shipped separately.
echo ""
echo "==> [2/3] vexa-bot"
docker build --platform "$PLATFORM" \
  -t "vexaai/vexa-bot:$TAG" \
  -f services/vexa-bot/Dockerfile services/vexa-bot

# 3) GPU transcription worker (CUDA base — builds fine without a GPU present).
echo ""
echo "==> [3/3] vexa-transcription (CUDA worker)"
docker build --platform "$PLATFORM" \
  -t "vexaai/vexa-transcription:$TAG" \
  -f services/transcription-service/Dockerfile services/transcription-service

echo ""
echo "Build complete. All images tagged :$TAG"
echo "Next:  ./docker/airgap/save.sh $TAG"
