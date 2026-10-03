#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
bh="${repo_root}/bh"
name="exe-smoke-$(date +%s)-$(openssl rand -hex 3)"
project="$(mktemp -d)"
attempted=0
cleanup() {
  status=$?
  if [[ "$attempted" == 1 ]]; then
    if ! "$bh" destroy "$name" --force; then
      echo "Cleanup was not confirmed. Run: bh destroy $name --force" >&2
      status=1
    fi
  fi
  rm -rf "$project"
  exit "$status"
}
trap cleanup EXIT
cd "$project"
git init -q
printf 'exe.dev connector file transfer\n' > payload.txt
attempted=1
"$bh" create "$name" --provider exedev
"$bh" run "$name" bash -lc 'test -f /opt/boxhaven/project/payload.txt && test -f /usr/local/lib/boxhaven/ssh-bridge.mjs && printf "runtime-and-sync-ok\n"'
"$bh" run "$name" bash -lc 'tmux new-session -d -s connector-smoke "sleep 2; printf persistent-session-ok > /opt/boxhaven/project/result.txt; sleep 30"'
sleep 3
"$bh" run "$name" cat /opt/boxhaven/project/result.txt
"$bh" sync down "$name" --force
test "$(cat result.txt)" = persistent-session-ok
echo "PASS: exe.dev create, runtime readiness, direct SSH, file sync, and persistent session; destroying $name"
