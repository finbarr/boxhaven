#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
: "${EXEUNTU_IMAGE:?Set EXEUNTU_IMAGE to a trusted exeuntu OCI image pinned by digest}"
: "${BOXHAVEN_EXEDEV_IMAGE_TAG:?Set BOXHAVEN_EXEDEV_IMAGE_TAG to your registry/image:tag}"
if [[ "$EXEUNTU_IMAGE" != *@sha256:* ]]; then
  echo "EXEUNTU_IMAGE must be pinned by digest" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "Build from a clean, committed checkout" >&2
  exit 1
fi
docker build --platform linux/amd64 --file deploy/exedev/Dockerfile \
  --build-arg "EXEUNTU_IMAGE=$EXEUNTU_IMAGE" \
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
  --tag "$BOXHAVEN_EXEDEV_IMAGE_TAG" .
echo "Built $BOXHAVEN_EXEDEV_IMAGE_TAG. Push it to your registry and configure BOXHAVEN_REMOTE_IMAGE_EXEDEV with the published digest."
