#!/usr/bin/env bash
# Stop the Vexa stack on prod (transcription first, then core).
# Add --volumes to also delete postgres/minio/recordings data (destructive).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

EXTRA=""
[ "${1:-}" = "--volumes" ] && EXTRA="--volumes"

echo "==> Stopping transcription workers..."
docker compose --env-file .env \
  -f services/transcription-service/docker-compose.yml \
  -f docker/airgap/transcription.prod.yml \
  down $EXTRA 2>/dev/null || true

echo "==> Stopping core stack..."
docker compose --env-file .env -f deploy/compose/docker-compose.yml down $EXTRA

echo "Done."
