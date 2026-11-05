#!/usr/bin/env bash
# mc-agent: load the fixed macOS signing certificate into a throwaway keychain.
# codesign is pointed at this keychain directly. On a developer's Mac the search
# list is left alone; on a CI runner the private key is only found through it.
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
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  # shellcheck disable=SC2046 # runner keychain paths contain no spaces
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
fi

# Not -v: a self-signed certificate is not "valid" to the trust store, and
# codesign does not need it to be.
IDENTITY="$(security find-identity -p codesigning "$KEYCHAIN" | awk '/mc-agent Code Signing/ { print $2; exit }')"
[ -n "$IDENTITY" ] || { echo "the certificate is not usable for code signing" >&2; exit 1; }

# Fail here, minutes before the build would, if codesign cannot use the key.
PROBE="$DIR/mc-signing-probe"
cp /usr/bin/true "$PROBE"
/usr/bin/codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" --timestamp=none "$PROBE" >&2
/usr/bin/codesign --verify --strict "$PROBE" >&2
rm -f "$PROBE"

echo "MC_MAC_SIGN_IDENTITY=$IDENTITY"
echo "MC_MAC_SIGN_KEYCHAIN=$KEYCHAIN"
