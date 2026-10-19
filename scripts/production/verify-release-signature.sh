#!/usr/bin/env bash
# Verifies a downloaded release artifact offline before it is uploaded or applied.
# The Sigstore bundle carries the certificate, signature and transparency-log proof,
# so cosign checks it against its cached trust root without contacting Rekor.
set -euo pipefail
export LC_ALL=C
usage() { echo "Usage: $0 /path/to/downloaded/artifact-directory" >&2; exit 1; }
[[ $# -eq 1 && -d $1 ]] || usage
cd "$1"
repository=${TAYYN_SIGNING_REPOSITORY:-bagtyyarkovusov/tayyn-hyzmat-project}
cosign=${COSIGN:-cosign}
command -v "$cosign" >/dev/null || { echo 'cosign is required on the operator machine.' >&2; exit 1; }
for file in bundle-archives.sha256 bundle-archives.sha256.sigstore.json app-bundle.tar.gz monitor-bundle.tar.gz; do
  [[ -f $file && ! -L $file ]] || { echo "Missing $file; refusing an unsigned or incomplete artifact." >&2; exit 1; }
done
"$cosign" verify-blob --offline \
  --bundle bundle-archives.sha256.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp "^https://github\\.com/${repository//./\\.}/\\.github/workflows/offline-production-bundle\\.yml@refs/(heads|tags)/" \
  bundle-archives.sha256
# Only the two signed archive names may appear, each exactly once.
[[ $(awk '{print $2}' bundle-archives.sha256 | sort | tr '\n' ' ') == 'app-bundle.tar.gz monitor-bundle.tar.gz ' ]] \
  || { echo 'Unexpected entries in bundle-archives.sha256.' >&2; exit 1; }
if command -v sha256sum >/dev/null; then sha256sum --check --strict bundle-archives.sha256
else shasum -a 256 --check --strict bundle-archives.sha256; fi
echo 'Release signature and archive checksums verified.'
