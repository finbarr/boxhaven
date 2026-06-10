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

Pick a specific provider, region, or image when the backend has more than one
provider configured:

```bash
bh create work --provider hetzner --region fsn1
```

Without `--provider`, the backend default applies. Set a sticky default with
the `provider` key under `[remote]` in `.boxhaven.toml` or the global config.

Skip the initial sync only when you intentionally want an empty project path:

```bash
bh create work --no-sync
```

Every account automatically gets a personal team, and your first box lands
there: new boxes go to your session's active team, which `bh login` pins to
your personal team until you join or switch to another one.

## Work In A Team

To share boxes with teammates, create a shared team and invite them:

```bash
bh team create acme
bh team invite teammate@example.com
```

The invite is a shareable link; the teammate signs in with the invited email
address and accepts it, which also switches that session's active team to the
new team. Creating a team likewise makes it your session's active team, as
does selecting a team in the console's Team view. When you belong to more
than one team, control where boxes go explicitly:

```bash
bh create work --team acme   # create a box directly in a team
bh team switch acme          # change the CLI default team for new boxes
bh move work acme            # move one of your boxes into the team
```

Team members see exactly the boxes in that team; boxes in your other teams
stay invisible to them. Owners and admins can destroy team boxes; members can
only destroy their own.

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
`bh sync down`. Pass `--sync` to a run to mirror local files first.

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

The same remote commands also forward selected Codex and Claude login/config
files from your local home directory, so a newly created box can reuse your local
agent logins without copying histories, sessions, caches, or databases.

## Inspect And Clean Up

```bash
bh list
bh status work
bh destroy work
```

Destroy boxes when the work is done so the cloud provider does not keep billing
for idle machines.
