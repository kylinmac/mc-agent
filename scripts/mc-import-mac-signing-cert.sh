#!/usr/bin/env bash
# mc-agent: load the fixed macOS signing certificate into a throwaway keychain.
# The login keychain and the keychain search list are left alone; codesign is
# pointed at this keychain directly.
#
# Input:  MC_MAC_CERT_P12_BASE64, MC_MAC_CERT_PASSWORD, and optionally
#         MC_MAC_KEYCHAIN_DIR (default: RUNNER_TEMP, else a new temp folder).
# Output: MC_MAC_SIGN_IDENTITY=<sha1> and MC_MAC_SIGN_KEYCHAIN=<path> lines on
#         stdout, ready for $GITHUB_ENV. Neither is a secret.
set -euo pipefail

: "${MC_MAC_CERT_P12_BASE64:?missing: add the repository secret MC_MAC_CERT_P12_BASE64}"
: "${MC_MAC_CERT_PASSWORD:?missing: add the repository secret MC_MAC_CERT_PASSWORD}"

DIR="${MC_MAC_KEYCHAIN_DIR:-${RUNNER_TEMP:-$(mktemp -d)}}"
KEYCHAIN="$DIR/mc-signing.keychain-db"
P12="$DIR/mc-signing.p12"
KEYCHAIN_PASSWORD="$(openssl rand -hex 24)"
trap 'rm -f "$P12"' EXIT

(umask 077; printf '%s' "$MC_MAC_CERT_P12_BASE64" | base64 --decode > "$P12")
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >&2
security set-keychain-settings -lut 21600 "$KEYCHAIN" >&2
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >&2
security import "$P12" -k "$KEYCHAIN" -P "$MC_MAC_CERT_PASSWORD" -T /usr/bin/codesign >&2
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null

# Not -v: a self-signed certificate is not "valid" to the trust store, and
# codesign does not need it to be.
IDENTITY="$(security find-identity -p codesigning "$KEYCHAIN" | awk '/mc-agent Code Signing/ { print $2; exit }')"
[ -n "$IDENTITY" ] || { echo "the certificate is not usable for code signing" >&2; exit 1; }

echo "MC_MAC_SIGN_IDENTITY=$IDENTITY"
echo "MC_MAC_SIGN_KEYCHAIN=$KEYCHAIN"
