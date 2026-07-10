#!/usr/bin/env bash
# Bake this host's corporate CA certificates into the vexa-bot image so the
# bot's Chromium (and node/curl) trust TLS-intercepting proxies like Netskope /
# Fireglass. Needed when authenticated Google login shows "Your connection is
# not private" because the proxy re-signs accounts.google.com with a corporate CA.
#
# Thin overlay on the existing vexaai/vexa-bot:<tag> image — no full rebuild,
# no npm/Playwright/apt downloads. Chromium on Linux trusts user roots via the
# NSS db (~/.pki/nssdb), which we build HERE with the host's certutil and COPY
# in (the container can't apt-install certutil on an air-gapped host).
#
# Requires: base vexaai/vexa-bot:<tag> present, corporate CA anchors in
# /etc/pki/ca-trust/source/anchors, docker, and `certutil` (nss-tools) on the
# host. Run with sudo where docker needs root.
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
command -v certutil >/dev/null 2>&1 || {
    echo "ERROR: 'certutil' not found on host. Install it:  sudo dnf install -y nss-tools" >&2
    echo "       (Chromium needs the CA in an NSS db; we build that here and COPY it in.)" >&2
    exit 1; }

ANCHORS="/etc/pki/ca-trust/source/anchors"
BUILD="$(mktemp -d)"; trap 'rm -rf "$BUILD"' EXIT
mkdir -p "$BUILD/certs" "$BUILD/nssdb"

# Gather corporate anchors + the live interception chain, splitting any
# multi-cert file into one-cert PEM files (so both update-ca-certificates and
# certutil accept them).
shopt -s nullglob
for f in "$ANCHORS"/*.pem "$ANCHORS"/*.crt /tmp/fgcert-*.pem; do
    [ -f "$f" ] || continue
    grep -q "BEGIN CERTIFICATE" "$f" 2>/dev/null || continue
    awk -v d="$BUILD/certs" -v b="$(basename "${f%.*}")" '
        /-----BEGIN CERTIFICATE-----/{n++; o=d"/"b"-"n".crt"}
        o{print > o}
        /-----END CERTIFICATE-----/{close(o); o=""}' "$f"
done
CERT_COUNT="$(ls -1 "$BUILD/certs" 2>/dev/null | wc -l | tr -d ' ')"
[ "$CERT_COUNT" -gt 0 ] || { echo "ERROR: no PEM CA certs found in $ANCHORS" >&2; exit 1; }
echo "==> $CERT_COUNT CA cert(s) gathered"

# Build the NSS trust db on the host.
certutil -d "sql:$BUILD/nssdb" -N --empty-password
for c in "$BUILD"/certs/*.crt; do
    certutil -d "sql:$BUILD/nssdb" -A -t "C,," -n "$(basename "$c")" -i "$c" 2>/dev/null || true
done
echo "==> NSS db built ($(ls "$BUILD/nssdb" | tr '\n' ' ')); baking into $BASE"

cat > "$BUILD/Dockerfile" <<'EOF'
ARG BASE
FROM ${BASE}
# System trust store (curl / node / openssl).
COPY certs/*.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates
# Chromium user-trusted roots (the one it actually reads on Linux).
COPY nssdb/ /root/.pki/nssdb/
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
EOF

DOCKER_BUILDKIT=0 docker build --build-arg BASE="$BASE" -t "$BASE" "$BUILD"

echo ""
echo "==> Done — $BASE trusts the corporate CAs (system store + Chromium NSS db)."
echo "    Spawn a fresh session to pick it up:"
echo "      sudo ./docker/airgap/browser-session.sh reset"
