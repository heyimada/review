#!/usr/bin/env bash
# Runs the engine against a real pull request the way the workflows do, without posting anything, and keeps the result.
#
#   e2e/dry-run.sh OWNER/REPO PR bugs|security|gate [CONFIG]
#
# CONFIG defaults to .github/review.json on the repository's default branch. The review reads with `gh auth token` and
# runs its agents on your Claude login; the gate needs no Claude login. The pull request's head is cloned into a temporary
# pr/ with its symlinks deleted, as review.yml does. Output: e2e/out/<owner>-<repo>-<pr>-<what>.json (the dry-run JSON)
# and .log (the engine's log), kept in the repository.
set -euo pipefail
engine=$(cd "$(dirname "$0")/.." && pwd)
repo=${1:?usage: e2e/dry-run.sh OWNER/REPO PR bugs|security|gate [CONFIG]}
pr=${2:?pull request number}
what=${3:?bugs, security or gate}
out="$engine/e2e/out/${repo/\//-}-$pr-$what"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -n "${4:-}" ]; then cp "$4" "$work/review.json"
else gh api "repos/$repo/contents/.github/review.json" -H "Accept: application/vnd.github.raw" > "$work/review.json"; fi
export GITHUB_REPOSITORY=$repo REVIEW_CONFIG="$work/review.json"
bun "$engine/src/config.ts"

cd "$work"
if [ "$what" = gate ]; then
  bun "$engine/src/gate.ts" --pr "$pr" --dry-run > "$out.json" 2> "$out.log"
else
  gh repo clone "$repo" pr -- --quiet --filter=blob:none --no-checkout
  git -C pr fetch --quiet origin "pull/$pr/head"
  git -C pr checkout --quiet --detach FETCH_HEAD
  find pr -type l -delete
  bun "$engine/src/review.ts" --pr "$pr" --lens "$what" --dry-run > "$out.json" 2> "$out.log"
fi
cat "$out.log" >&2
jq -c 'if .decision then {pr, status: .decision.status, reasons: .decision.reasons} else {pr, lens, head, state, candidates, findings: (.findings | length), errors, costUsd} end' "$out.json"
