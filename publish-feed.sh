#!/usr/bin/env bash
# Publish dist/ (parquet shards + manifest + index) to the public GitHub Pages host
# that OpenAI's hosted-URL connector reads.
#
#   ./publish-feed.sh
#
# Pushes a single-commit orphan branch every time, so the 27 MB snapshot never
# accumulates in git history — the repo stays the size of one snapshot.
set -euo pipefail

REPO="${FEED_REPO:-nvg58/hellaprints-product-feed}"
BRANCH="${FEED_BRANCH:-gh-pages}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist"

[ -d "$DIST" ] || { echo "no dist/ — run make-parquet.py first" >&2; exit 1; }
ls "$DIST"/*.parquet >/dev/null 2>&1 || { echo "no parquet shards in dist/" >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp "$DIST"/*.parquet "$DIST"/manifest.json "$DIST"/index.html "$STAGE"/
touch "$STAGE/.nojekyll"   # serve every file as-is, no Jekyll processing

cd "$STAGE"
git init -q -b "$BRANCH"
git add -A
git -c user.name="feed-bot" -c user.email="feed-bot@users.noreply.github.com" \
    commit -q -m "feed snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
# SSH by default (matches the local gh/git setup); set FEED_REMOTE to override, e.g.
# FEED_REMOTE="https://x-access-token:$GITHUB_TOKEN@github.com/$REPO.git" in CI.
git push -q --force "${FEED_REMOTE:-git@github.com:$REPO.git}" "$BRANCH"

echo "published to https://$(echo "$REPO" | cut -d/ -f1).github.io/$(echo "$REPO" | cut -d/ -f2)/"
