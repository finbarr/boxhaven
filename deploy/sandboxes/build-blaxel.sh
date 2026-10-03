#!/usr/bin/env bash
set -euo pipefail
source_dir="$(cd "$(dirname "$0")/blaxel" && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/boxhaven-blaxel-build.XXXXXX")"
trap 'rm -r "$build_dir"' EXIT
# The CLI packages its working directory. Never send the repository or local
# credentials as a build context, even when --directory is supplied.
cp "$source_dir/Dockerfile" "$source_dir/blaxel.toml" "$build_dir/"
cd "$build_dir"
bl push --type sandbox --name boxhaven-runtime-v051 -y "$@"
