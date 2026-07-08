#!/usr/bin/env bash
# Save all Vexa images + the Whisper model weights into transferable bundles.
# Output lands in docker/airgap/dist/.
#
# Produces:
#   dist/vexa-images-<tag>.tar.gz          all docker images (core + bot + transcription + bases)
#   dist/vexa-transcription-models.tar.gz  Whisper weights (bind-mounted, NOT in any image)
#
# Usage:  ./docker/airgap/save.sh [tag]     (tag defaults to VERSION)
# Next:   copy dist/* to the prod server, then ./docker/airgap/load.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < VERSION)"
TAG="${1:-${AIRGAP_TAG:-$VERSION}}"
DIST="$SCRIPT_DIR/dist"
mkdir -p "$DIST"

# --- Assemble the exact image list -----------------------------------------
# `config --images` reports every image: field in the core compose, which is
# the 7 built services PLUS the pulled bases (postgres, redis, minio, mc).
echo "==> Resolving core compose image list..."
mapfile -t CORE < <(IMAGE_TAG="$TAG" docker compose --env-file .env \
  -f deploy/compose/docker-compose.yml config --images)

# Add the images compose does not list: the on-demand bot, the transcription
# worker, and the transcription nginx load-balancer base.
IMAGES=( "${CORE[@]}" \
  "vexaai/vexa-bot:$TAG" \
  "vexaai/vexa-transcription:$TAG" \
  "nginx:alpine" )

# Dedupe.
mapfile -t IMAGES < <(printf '%s\n' "${IMAGES[@]}" | sort -u)

echo "==> Images to save:"
printf '      %s\n' "${IMAGES[@]}"

# Fail early with a clear message if anything wasn't built/pulled.
missing=0
for img in "${IMAGES[@]}"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "    MISSING: $img"; missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "Error: image(s) above not found locally. Run ./docker/airgap/build.sh first" >&2
  echo "(base images like postgres/redis/minio are pulled during 'up' or 'docker compose pull')." >&2
  exit 1
fi

# --- Save images ------------------------------------------------------------
IMG_TAR="$DIST/vexa-images-$TAG.tar"
echo "==> Saving images -> $IMG_TAR(.gz)  (this is large; be patient)"
docker save -o "$IMG_TAR" "${IMAGES[@]}"
gzip -f "$IMG_TAR"

# --- Save Whisper model weights --------------------------------------------
# The transcription workers bind-mount ./models (1.6G). Weights are not baked
# into the image, so ship the directory separately.
MODELS_TAR="$DIST/vexa-transcription-models.tar.gz"
if [ -d services/transcription-service/models ]; then
  echo "==> Saving Whisper model weights -> $MODELS_TAR"
  tar -C services/transcription-service -czf "$MODELS_TAR" models
else
  echo "WARNING: services/transcription-service/models not found — skipping weights." >&2
  echo "         Transcription will try to download them (fails on an air-gapped host)." >&2
fi

echo "$TAG" > "$DIST/AIRGAP_TAG"
chmod 644 "$DIST"/*.gz "$DIST/AIRGAP_TAG" 2>/dev/null || true

echo ""
echo "Export complete. Transfer these to the prod server's docker/airgap/dist/:"
ls -lh "$DIST"/*.gz
echo ""
echo "On prod:  ./docker/airgap/load.sh  &&  ./docker/airgap/up.sh"
