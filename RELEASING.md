# Release Runbook

This runbook is for the release operator. It intentionally separates publishing
the GitHub release from updating `finbarr/homebrew-tap`: the tap must never
point at an artifact that does not exist yet.

The current public release is `v0.1.0`. As audited on 2026-08-11, its release
assets and `SHA256SUMS` agree with each other, but the live Homebrew formula
contains older checksums and `brew fetch` fails. Do not replace the v0.1.0
assets again. Publishing v0.2.0 and then updating the tap from the verified
v0.2.0 `SHA256SUMS` is the recovery path.

## 1. Prepare the exact release commit

Do this only after every change intended for v0.2.0 has merged to `master`.
Start in a clean public checkout:

```bash
set -euo pipefail
TAG=v0.2.0
git switch master
git pull --ff-only origin master
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)"
```

Replace the placeholder changelog date with the current UTC date, inspect the
notes, and commit that change:

```bash
RELEASE_DATE="$(date -u +%F)"
python3 - "$TAG" "$RELEASE_DATE" <<'PY'
import pathlib
import sys

tag, release_date = sys.argv[1:]
path = pathlib.Path("CHANGELOG.md")
contents = path.read_text(encoding="utf-8")
old = f"## {tag} - TBD"
new = f"## {tag} - {release_date}"
if contents.count(old) != 1:
    raise SystemExit(f"expected exactly one {old!r} heading")
path.write_text(contents.replace(old, new), encoding="utf-8")
PY
scripts/check-release-metadata.sh "$TAG" /tmp/boxhaven-release-notes.md
cat /tmp/boxhaven-release-notes.md
git diff --check
git diff -- CHANGELOG.md
git add CHANGELOG.md
git commit -m "Finalize ${TAG} changelog"
git push origin master
```

Run every public verification surface from that commit. ShellCheck 0.11.0 or
newer is required for the shell command below.

```bash
make clean
make build
make test
make backend-build
make lint
./bh version
./bh help
./bh config
make release-test
shellcheck \
  install.sh \
  scripts/build-release-artifacts.sh \
  scripts/check-release-metadata.sh \
  scripts/render-homebrew-formula.sh \
  scripts/test-release-tooling.sh \
  scripts/verify-published-release.sh \
  scripts/verify-release-artifacts.sh
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
```

Watch the CI run for the release commit and require success:

```bash
RELEASE_COMMIT="$(git rev-parse HEAD)"
CI_RUN_ID=""
until [ -n "$CI_RUN_ID" ]; do
  CI_RUN_ID="$(gh run list --workflow ci.yml --commit "$RELEASE_COMMIT" \
    --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [ -n "$CI_RUN_ID" ] || sleep 2
done
gh run watch "$CI_RUN_ID" --exit-status
```

Do not tag if any local or GitHub check fails, if `CHANGELOG.md` still contains
`v0.2.0 - TBD`, or if the release commit is not on `origin/master`.

## 2. Tag and watch the gated release

Reconfirm the exact remote commit, create one annotated tag, and push only that
tag:

```bash
git fetch origin master
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"
test "$RELEASE_COMMIT" = "$(git rev-parse origin/master)"
git tag -a "$TAG" -m "$TAG"
git push origin "refs/tags/${TAG}"
```

The release workflow repeats the full public verification, builds all four
archives twice, compares them byte-for-byte, validates the archive contract,
uploads a draft, checks GitHub's asset digests, and only then publishes it.
Watch that exact run:

```bash
RELEASE_RUN_ID=""
until [ -n "$RELEASE_RUN_ID" ]; do
  RELEASE_RUN_ID="$(gh run list --workflow release.yml --commit "$RELEASE_COMMIT" \
    --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [ -n "$RELEASE_RUN_ID" ] || sleep 2
done
gh run watch "$RELEASE_RUN_ID" --exit-status
gh release view "$TAG" --json tagName,isDraft,isPrerelease,assets,url
scripts/verify-published-release.sh "$TAG"
```

Do not move or force-push the tag after this point. The workflow refuses to
replace an existing release. If it fails before draft creation, fix the source
on `master` and use a new version. If it leaves a draft, inspect the failed run
and draft before deciding whether to delete the unpublished draft and rerun;
never overwrite assets on a published release.

## 3. Generate and test the Homebrew formula

Run this on a clean macOS machine with Homebrew, Ruby, and a checkout of the
same release commit. Do not begin until `verify-published-release.sh` passes.

```bash
set -euo pipefail
TAG=v0.2.0
brew tap finbarr/tap
TAP_REPO="$(brew --repo finbarr/tap)"
git -C "$TAP_REPO" fetch origin main
git -C "$TAP_REPO" switch --detach origin/main
git -C "$TAP_REPO" switch -c "boxhaven-${TAG}"

FORMULA_TMP="$(mktemp -d)"
curl -fsSL -o "${FORMULA_TMP}/SHA256SUMS" \
  "https://github.com/finbarr/boxhaven/releases/download/${TAG}/SHA256SUMS"
scripts/render-homebrew-formula.sh \
  "$TAG" \
  "${FORMULA_TMP}/SHA256SUMS" \
  "${TAP_REPO}/Formula/boxhaven.rb"
git -C "$TAP_REPO" diff --check
git -C "$TAP_REPO" diff -- Formula/boxhaven.rb
```

Test the edited formula from the local tap before pushing it:

```bash
HOMEBREW_NO_AUTO_UPDATE=1 brew audit --strict --online finbarr/tap/boxhaven
HOMEBREW_NO_AUTO_UPDATE=1 brew fetch --force finbarr/tap/boxhaven
brew uninstall --force finbarr/tap/boxhaven 2>/dev/null || true
HOMEBREW_NO_AUTO_UPDATE=1 brew install finbarr/tap/boxhaven
HOMEBREW_NO_AUTO_UPDATE=1 brew test finbarr/tap/boxhaven
brew list --versions boxhaven
bh version | grep -F "bh ${TAG} ("
```

Only after those commands pass, commit and push the tap update:

```bash
git -C "$TAP_REPO" add Formula/boxhaven.rb
git -C "$TAP_REPO" commit -m "Update boxhaven to ${TAG#v}"
git -C "$TAP_REPO" push origin HEAD:main
```

Finally, prove that a new user receives the formula from the live tap, rather
than the edited local checkout:

```bash
brew uninstall --force finbarr/tap/boxhaven
brew untap finbarr/tap
brew install finbarr/tap/boxhaven
brew test finbarr/tap/boxhaven
bh version | grep -F "bh ${TAG} ("
```

## 4. Verify a clean installer and production lifecycle

On a separate clean macOS or Linux test machine, install from the tagged
installer into a temporary directory so an older `bh` on `PATH` cannot mask the
result:

```bash
set -euo pipefail
TAG=v0.2.0
CLEAN_ROOT="$(mktemp -d)"
curl -fsSL -o "${CLEAN_ROOT}/install.sh" \
  "https://raw.githubusercontent.com/finbarr/boxhaven/${TAG}/install.sh"
BOXHAVEN_VERSION="$TAG" BOXHAVEN_INSTALL_DIR="${CLEAN_ROOT}/bin" \
  sh "${CLEAN_ROOT}/install.sh"
BH="${CLEAN_ROOT}/bin/bh"
"$BH" version | grep -F "bh ${TAG} ("
```

Log in with the disposable production smoke account. Set
`BOXHAVEN_SMOKE_GIT_REMOTE` to an existing disposable GitHub repository and
provide a token that can push and delete temporary branches there; leaving the
variable unset skips that required proof.

```bash
"$BH" login --backend-url https://api.boxhaven.dev
export GH_TOKEN="$(gh auth token)"
export BOXHAVEN_SMOKE_GIT_REMOTE="https://github.com/<org>/<smoke-repo>.git"
BOXHAVEN_SMOKE_BH="$BH" \
BOXHAVEN_SMOKE_BACKEND_URL=https://api.boxhaven.dev \
BOXHAVEN_SMOKE_PREFIX="release-${TAG#v}-$(date -u +%H%M%S)" \
  scripts/smoke-remote-lifecycle.sh
```

The checked-in smoke creates and destroys its box and verifies sync, list,
direct SSH, SCP, runtime tools, preview HTTPS, and the temporary Git branch.
Confirm its cleanup completed.

Use the same released binary for one real agent run. This final interactive
check proves agent startup, disconnect, and reconnect rather than only runtime
installation:

```bash
AGENT_PROJECT="$(mktemp -d)"
git -C "$AGENT_PROJECT" init -b main
git -C "$AGENT_PROJECT" config user.email boxhaven-smoke@example.invalid
git -C "$AGENT_PROJECT" config user.name "BoxHaven Smoke"
echo "BoxHaven ${TAG} agent smoke" > "${AGENT_PROJECT}/README.md"
git -C "$AGENT_PROJECT" add README.md
git -C "$AGENT_PROJECT" commit -m "Agent smoke fixture"
cd "$AGENT_PROJECT"
AGENT_BOX="release-${TAG#v}-agent-$(date -u +%H%M%S)"
"$BH" create "$AGENT_BOX"
"$BH" run "$AGENT_BOX" codex --model gpt-5.6-sol
```

Ask Codex to create `release-agent-smoke.txt` containing the release tag and to
run `git status --short`. While it is working, detach from tmux with
<kbd>Ctrl-b</kbd>, then <kbd>d</kbd>. Reattach and verify the result:

```bash
"$BH" list
"$BH" connect "$AGENT_BOX"
# After inspecting the completed agent session, detach again, then:
"$BH" run "$AGENT_BOX" run test -s /opt/boxhaven/project/release-agent-smoke.txt
"$BH" destroy "$AGENT_BOX" --force
"$BH" list
```

Record the public CI run URL, release workflow URL, release URL, tap commit,
Homebrew audit/fetch/test output, installer version output, production smoke
output, and agent smoke result in the launch evidence. The release is complete
only when no disposable box or Git branch remains.
