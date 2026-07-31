#!/usr/bin/env bash
# Renders all artifacts for an iteration: run-iter.sh <iterN>
set -u
export PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$PATH"
BASE=/home/baoro/stuff/random/sloodge/experiments/init
ITER=$1
for f in "$BASE/artifacts/$ITER"/*.html; do
  id=$(basename "$f" .html)
  flag=""
  case "$id" in graph-*) flag="--interactive";; esac
  echo "=== $id ==="
  node "$BASE/harness/render.mjs" "$f" "$BASE/evidence/$ITER/$id" $flag || echo "RENDER FAILED: $id"
done
