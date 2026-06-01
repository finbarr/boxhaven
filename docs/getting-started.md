# Getting Started

This guide covers the local developer workflow for using BoxHaven from source.

## Install The CLI

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

Or install a released CLI archive:

```bash
curl -fsSL https://raw.githubusercontent.com/finbarr/boxhaven/master/scripts/install-bh.sh | bash
```

## Log In

Use the hosted backend:

```bash
bh login
```

Use a local or self-hosted backend:

```bash
bh login --backend-url http://127.0.0.1:8787
```

The CLI stores the resulting session token in
`~/.config/boxhaven/config.toml`. `BOXHAVEN_BACKEND_URL` and `BOXHAVEN_TOKEN`
override the stored config when set.

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

Skip the initial sync only when you intentionally want an empty project path:

```bash
bh create work --no-sync
```

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
`copilot`, `pi`, `bash`, and `shell` use the managed tmux session. Other
commands run directly over SSH.

## Sync Files

Push local changes to the box:

```bash
bh sync up work
```

Pull remote changes back to the local checkout:

```bash
bh sync down work --force
```

`sync down` overwrites local files by design, so it requires `--force`.
Both sync directions exclude the local root `./bh` build artifact so a binary
built on one platform is not copied into a box or back onto the workstation.

## Push To GitHub From The Box

For agent workflows that commit and push from the remote box, use an HTTPS
GitHub origin and export a token locally before creating or connecting:

```bash
export GH_TOKEN=...
git remote set-url origin https://github.com/<org>/<repo>.git
bh run work codex
```

When the project origin points at GitHub, the CLI forwards `GH_TOKEN` or
`GITHUB_TOKEN` to `/run/boxhaven/session.env` on the VM. The remote image
includes a Git credential helper that uses those variables for HTTPS GitHub
operations.

## Inspect And Clean Up

```bash
bh list
bh status work
bh destroy work
```

Destroy boxes when the work is done so the cloud provider does not keep billing
for idle machines.
