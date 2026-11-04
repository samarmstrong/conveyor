#!/bin/zsh
# Bring this checkout up to the newest commit on the default branch whose CI
# passed, so every machine running the factory runs the same factory. Run at
# the start of a tick, before any of the factory's code loads; a tick already
# under way keeps the code it started with. A checkout on another branch, or
# with commits of its own, is someone's work: it is left alone, and the second
# is alerted. Never fails the tick: an update that cannot happen is logged and
# the tick runs on what it has.
set -u
ROOT="${0:A:h:h}"
cd "$ROOT" || exit 0
mkdir -p telemetry
log() { echo "[$(date -u +%FT%TZ)] update: $1" >> telemetry/launchd.log; }
# A deployment that wants to be paged on a stuck checkout drops an executable at
# contrib/alert.sh taking (title, body); without one, the alert is only logged.
alert() { [[ -x "$ROOT/contrib/alert.sh" ]] && "$ROOT/contrib/alert.sh" "$1" "$2"; log "$1: $2"; }

upstream="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
branch="${upstream#origin/}"
[[ "$(git symbolic-ref -q --short HEAD)" == "$branch" ]] || { log "not on $branch; left alone"; exit 0; }
git fetch -q origin "$branch" || { log "fetch failed"; exit 0; }

if ! git merge-base --is-ancestor HEAD "$upstream"; then
  alert "factory checkout diverged" \
    "$ROOT has commits not on $upstream, so it no longer updates itself. Push them or reset to $upstream."
  exit 0
fi

# Newest first; a commit whose CI is still running or red is passed over for
# the one before it, so a bad push never reaches the fleet.
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || { log "gh cannot see the repo"; exit 0; }
target=""
for sha in $(git rev-list --max-count=20 "HEAD..$upstream"); do
  if [[ "$(gh api "repos/$repo/commits/$sha/check-runs?check_name=check" \
      --jq '[.check_runs[] | select(.status == "completed" and .conclusion == "success")] | length' 2>/dev/null)" -gt 0 ]]; then
    target="$sha"; break
  fi
done
[[ -n "$target" ]] || exit 0

old="$(git rev-parse HEAD)"
if ! git merge -q --ff-only "$target" 2>>telemetry/launchd.log; then
  alert "factory update failed" \
    "$ROOT could not fast-forward to ${target:0:7} (uncommitted changes in the way?). It runs ${old:0:7} until that is cleared."
  exit 0
fi
log "${old:0:7} → ${target:0:7}"
if ! git diff --quiet "$old" "$target" -- package-lock.json; then
  npm ci --silent >> telemetry/launchd.log 2>&1 || alert "factory update: npm ci failed" "at ${target:0:7}; see telemetry/launchd.log"
fi
exit 0
