#!/bin/bash
# Build the two installables and dist/release.json (URLs + sha256 that invites embed).
#   MPR_DIST_BASE=https://<public files base>  npm run dist
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
: "${MPR_DIST_BASE:?set MPR_DIST_BASE to the public URL the files will be served from}"
export npm_config_cache="${npm_config_cache:-$ROOT/.npm-cache}"
VER=$(node -p "require('./package.json').version")
DIST="${DIST_DIR:-$ROOT/dist}"
rm -rf "$DIST" && mkdir -p "$DIST"
npm pack --silent --pack-destination "$DIST" >/dev/null
TGZ="meat-proxy-remover-$VER.tgz"
STAGE="$DIST/.mcpb-stage"; mkdir -p "$STAGE"
cp -R src package.json package-lock.json "$STAGE/"; cp packaging/mcpb/manifest.json "$STAGE/"
# Exact dependency tree from the lockfile, no install scripts: the shipped bytes are what we tested.
(cd "$STAGE" && npm ci --silent --omit=dev --ignore-scripts >/dev/null && rm -f package-lock.json)
npx -y @anthropic-ai/mcpb@2.1.2 pack "$STAGE" "$DIST/meat-proxy-remover-$VER.mcpb" >/dev/null
rm -rf "$STAGE"
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
BASE="${MPR_DIST_BASE%/}"
cat > "$DIST/release.json" <<JSON
{
  "version": "$VER",
  "tgz_url": "$BASE/$TGZ",
  "tgz_sha256": "$(sha "$DIST/$TGZ")",
  "mcpb_url": "$BASE/meat-proxy-remover-$VER.mcpb",
  "mcpb_sha256": "$(sha "$DIST/meat-proxy-remover-$VER.mcpb")"
}
JSON
ls -la "$DIST"; cat "$DIST/release.json"
