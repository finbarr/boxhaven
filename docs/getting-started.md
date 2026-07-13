# Getting Started

This guide installs the `bh` CLI, logs in to a backend, creates your first
box, and resumes an agent session on it.

## Install The CLI

### Install script

One-liner (macOS and Linux, installs the latest release):

```bash
curl -fsSL https://raw.githubusercontent.com/finbarr/boxhaven/master/install.sh | sh
```

The script downloads the latest `bh` release for your platform, verifies it
against the release's `SHA256SUMS`, and installs it to `/usr/local/bin`
(sudo when needed) or `~/.local/bin` as a fallback. Set `BOXHAVEN_VERSION`
to install a specific release tag and `BOXHAVEN_INSTALL_DIR` to choose the
install directory.

### Homebrew

Via the `finbarr/tap` tap:

```bash
brew install finbarr/tap/boxhaven
```

### From a release archive

Tagged releases publish prebuilt `bh` archives for Linux and macOS (amd64 and
arm64) on the [GitHub releases page](https://github.com/finbarr/boxhaven/releases).
Download the archive for your platform, extract it, and put `bh` on your
`PATH`:

```bash
tar -xzf bh_<version>_<os>_<arch>.tar.gz
install -m 0755 bh ~/.local/bin/bh
bh version
```

### From source

```bash
git clone https://github.com/finbarr/boxhaven.git
cd boxhaven
make build
./bh version
```

Install it to `~/.local/bin` when you want `bh` on your shell path:

```bash
make install
```

A plain Go build also works:

```bash
go build -o bh ./cmd/bh
```

## Log In

Use the hosted backend:

```bash
bh login
```

Creating a hosted account requires accepting the
[Terms of Service](https://boxhaven.dev/terms/) and acknowledging the
[Privacy Policy](https://boxhaven.dev/privacy/). These policies do not govern
self-hosted deployments operated by someone else.

Use a local or self-hosted backend:

```bash
bh login --backend-url http://127.0.0.1:8787
```

The CLI prints a browser URL, tries to open it, and waits for the web app to
grant access. The resulting session token is stored in
`~/.config/boxhaven/config.toml`. `BOXHAVEN_BACKEND_URL` and `BOXHAVEN_TOKEN`
override the stored config when set.

## Enable Direct SSH

Install managed OpenSSH aliases once after logging in:

```bash
bh ssh-config install
```

This adds an `Include` line to `~/.ssh/config`, creates a device key under
`~/.boxhaven/ssh`, and manages an alias named `bh-<name>` for each ready box.
Aliases update after normal box lifecycle commands; run
`bh ssh-config refresh` to force an update or `bh ssh-config uninstall` to
remove the managed include.

## Create A Box

Run this from the project you want to work on remotely:

```bash
bh create work
```

`bh create` asks the backend to provision a VM, waits until the BoxHaven agent
and SSH certificate trust are ready, then syncs the current directory to:

```text
/opt/boxhaven/project
```

Use a larger tier when needed:

```bash
bh create work --tier medium
```

Pick a specific provider, region, or image when the backend has more than one
provider configured:

```bash
bh create work --provider hetzner --region fsn1
```

Without `--provider`, the backend default applies. Set a sticky default with
the `provider` key under `[remote]` in `.boxhaven.toml` or the global config.
See [Cloud Providers](/providers) for the full provider configuration.

Skip the initial sync only when you intentionally want an empty project path:

```bash
bh create work --no-sync
```

Every account automatically gets a default team, and your first box lands
there: new boxes go to your session's active team, which `bh login` pins to
that default team until you switch to another one. See
[Teams](/teams) for sharing boxes with teammates.

Use the box through normal OpenSSH clients:

```bash
ssh bh-work
scp ./notes.txt bh-work:/opt/boxhaven/project/
rsync -az ./fixtures/ bh-work:/opt/boxhaven/project/fixtures/
```

The same alias works with tools that read OpenSSH configuration, including VS
Code Remote SSH. Each invocation transparently obtains a new short-lived
certificate from the backend; the SSH connection itself goes directly to the
box.

## Run Commands

Run a noninteractive command:

```bash
bh run work run bash -lc 'go test ./...'
```

Start or attach to the managed tmux session:

```bash
bh run work codex
bh connect work
```

Interactive commands such as `codex`, `claude`, `gemini`, `opencode`,
`copilot`, `pi`, and a bare `bash` or `shell` use the managed tmux session.
Shells with arguments (`bash -lc '...'`) and other commands run directly over
SSH.

`bh run` never touches the project files on the box: the project syncs when
the box is created and when you run `bh sync up` (which mirrors deletions).
Work done by agents on the box stays put until you pull it back with
`bh sync down`. Pass `--sync` to a run to mirror local files first. Sync
excludes common dependency/cache directories such as `node_modules/`, `.next/`,
and `.venv/` by default; add `.boxhavenignore` at the project root for
additional rsync-style exclude patterns.

## Resume Your Local Agent Session

Starting `claude` or `codex` forwards your newest local sessions for this
project, so you can resume the conversation you were having on your laptop:

```bash
bh run work claude --continue
```

Disconnect whenever you like — the agent keeps running in the box's tmux
session. `bh connect work` reattaches, and `bh list` shows which boxes are
online.

## Sync Files

Push local changes to the box:

```bash
bh sync up work
```

Pull remote changes back to the local checkout:

```bash
bh sync down work --force
```

Excluded paths are not deleted by sync, so dependency directories installed on
the box can stay warm across later `bh sync up` runs. Sync completion reports
elapsed time, network bytes, changed bytes, and file counts.

`sync down` overwrites local files by design, so it requires `--force`.

## Push To GitHub From The Box

For agent workflows that commit and push from the remote box, use an HTTPS
GitHub origin and make local GitHub auth available before creating or
connecting:

```bash
gh auth login
git remote set-url origin https://github.com/<org>/<repo>.git
bh run work codex
```

When the project origin points at GitHub, the CLI forwards `GH_TOKEN` or
`GITHUB_TOKEN` when set, otherwise it falls back to `gh auth token` from the
local GitHub CLI. The token is written to `/run/boxhaven/session.env` on the VM.
The remote image includes a Git credential helper that uses those variables for
HTTPS GitHub operations.

The same remote commands also forward selected agent login/config files
(Claude, Codex, Gemini, Copilot, opencode) from your local home directory, so
a newly created box reuses your local agent logins. Recent claude/codex
sessions for the current project are forwarded when you start those agents;
broader histories, caches, and databases are never copied. See the
[Security Model](/security) for exactly what is forwarded.

## Inspect And Clean Up

```bash
bh list
bh status work
bh destroy work
```

Destroy boxes when the work is done so the cloud provider does not keep billing
for idle machines. The CLI prompts before destroying; pass `--force` only for
noninteractive cleanup scripts.
