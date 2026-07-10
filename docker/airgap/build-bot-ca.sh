#!/usr/bin/env bash
# Bake this host's corporate CA certificates into the vexa-bot image so the
# bot's Chromium (and node/curl) trust TLS-intercepting proxies like Netskope /
# Fireglass. Needed when authenticated Google login shows "Your connection is
# not private" because the proxy re-signs accounts.google.com with a corporate CA.
#
# This is a THIN overlay on the existing vexaai/vexa-bot:<tag> image — no full
# rebuild, no npm/Playwright downloads. It re-tags the same tag so runtime-api
# spawns the CA-enabled image with no further config change.
#
# Requires: the base vexaai/vexa-bot:<tag> already present, the corporate CA
# anchors in /etc/pki/ca-trust/source/anchors, and docker (run with sudo where
# docker needs root).
#
# Usage: sudo ./docker/airgap/build-bot-ca.sh [tag]   (tag defaults to VERSION)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"; cd "$ROOT"
VERSION="$(tr -d '[:space:]' < VERSION)"
TAG="${1:-$VERSION}"
BASE="vexaai/vexa-bot:$TAG"

docker image inspect "$BASE" >/dev/null 2>&1 || {
    echo "ERROR: base image $BASE not found. Load/build it first." >&2; exit 1; }

ANCHORS="/etc/pki/ca-trust/source/anchors"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
mkdir -p "$BUILD/certs"

# Gather corporate CA anchors (Netskope, Fireglass, SPI, ...) as PEM *.crt files.
shopt -s nullglob
for f in "$ANCHORS"/*.pem "$ANCHORS"/*.crt; do
    # only keep PEM certs; update-ca-certificates ignores non-PEM
    if grep -q "BEGIN CERTIFICATE" "$f" 2>/dev/null; then
        cp "$f" "$BUILD/certs/$(basename "${f%.*}").crt"
    fi
done
# Include the exact live interception chain if it was extracted to /tmp
# (root that signs accounts.google.com — see the openssl s_client step).
for c in /tmp/fgcert-*.pem; do
    [ -f "$c" ] && grep -q "BEGIN CERTIFICATE" "$c" && cp "$c" "$BUILD/certs/live-$(basename "${c%.*}").crt"
done

CERT_COUNT="$(ls -1 "$BUILD/certs" 2>/dev/null | wc -l | tr -d ' ')"
[ "$CERT_COUNT" -gt 0 ] || { echo "ERROR: no PEM CA certs found in $ANCHORS" >&2; exit 1; }
echo "==> Baking $CERT_COUNT CA cert(s) into $BASE"
ls "$BUILD/certs"

cat > "$BUILD/Dockerfile" <<'EOF'
ARG BASE
FROM ${BASE}
COPY certs/*.crt /usr/local/share/ca-certificates/
# System trust store (curl / node / openssl).
RUN update-ca-certificates
# Chromium on Linux reads user-trusted roots from the NSS db — add them there
# too. Best-effort: if libnss3-tools can't be installed, the system store still
# helps. The whole step is non-fatal so the image always builds.
RUN set +e; \
    command -v certutil >/dev/null 2>&1 || { apt-get update && apt-get install -y --no-install-recommends libnss3-tools && rm -rf /var/lib/apt/lists/*; }; \
    mkdir -p /root/.pki/nssdb; \
    certutil -d sql:/root/.pki/nssdb -N --empty-password 2>/dev/null; \
    for c in /usr/local/share/ca-certificates/*.crt; do \
        certutil -d sql:/root/.pki/nssdb -A -t "C,," -n "$(basename "$c")" -i "$c" 2>/dev/null; \
    done; \
    true
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
EOF

DOCKER_BUILDKIT=0 docker build --build-arg BASE="$BASE" -t "$BASE" "$BUILD"

echo ""
echo "==> Done — $BASE now trusts the corporate CAs (system store + NSS)."
echo "    Spawn a fresh session to pick it up:"
echo "      sudo ./docker/airgap/browser-session.sh reset"
