#!/usr/bin/env bash
# Load Vexa images + Whisper weights on the air-gapped prod server.
# Run from the repo checkout on prod, with the transferred bundles sitting in
# docker/airgap/dist/.
#
# Usage:  ./docker/airgap/load.sh [tag]
# Next:   ./docker/airgap/up.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

DIST="$SCRIPT_DIR/dist"
VERSION="$(tr -d '[:space:]' < VERSION)"
TAG="${1:-${AIRGAP_TAG:-$(cat "$DIST/AIRGAP_TAG" 2>/dev/null || echo "$VERSION")}}"

IMG_BUNDLE="$DIST/vexa-images-$TAG.tar.gz"
MODELS_BUNDLE="$DIST/vexa-transcription-models.tar.gz"

if [ ! -f "$IMG_BUNDLE" ]; then
  echo "Error: image bundle not found: $IMG_BUNDLE" >&2
  echo "Copy dist/*.gz from the build machine first." >&2
  exit 1
fi

echo "==> Loading images from $IMG_BUNDLE ..."
gunzip -c "$IMG_BUNDLE" | docker load

if [ -f "$MODELS_BUNDLE" ]; then
  echo "==> Restoring Whisper weights into services/transcription-service/models ..."
  tar -C services/transcription-service -xzf "$MODELS_BUNDLE"
else
  echo "WARNING: $MODELS_BUNDLE not found — transcription workers will have no local model." >&2
fi

echo ""
echo "Load complete. Images now present:"
docker images | grep -E "vexaai/(api-gateway|admin-api|runtime-api|meeting-api|mcp|dashboard|tts-service|vexa-bot|vexa-transcription)" || true
echo ""
echo "Next:  ./docker/airgap/up.sh $TAG"
