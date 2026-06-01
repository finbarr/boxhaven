# BoxHaven Overview

BoxHaven is an open-source remote development box manager for teams using AI
coding agents. It provides a common CLI and control plane for creating,
connecting to, syncing, and destroying remote Linux machines that stay alive
while developers disconnect and reconnect.

The target workflow is simple:

```bash
bh login
bh create work
bh run work codex
bh connect work
bh sync down work --force
bh destroy work
```

## Why It Exists

Teams are increasingly running Codex, Claude, Gemini, and other coding agents on
remote development machines so sessions can continue while laptops sleep or
developers move between devices. Without a shared tool, each company tends to
build its own combination of cloud VMs, tmux, SSH keys, sync scripts, Git
credentials, and cleanup jobs.

BoxHaven standardizes that stack:

- The CLI stays small and predictable.
- The backend owns machine lifecycle and per-user access.
- VMs come from a golden image with the agent runtime already installed.
- Developers connect over direct SSH using short-lived certificates.
- Project bytes sync to `/opt/boxhaven/project`.
- Interactive work runs in a managed tmux session.
- GitHub HTTPS pushes work when a local `GH_TOKEN` or `GITHUB_TOKEN` is
  forwarded.

## Architecture

BoxHaven has three main pieces:

- `cmd/bh`: the Go CLI for login, machine lifecycle, direct SSH, rsync, and
  command execution.
- `backend`: the Fastify/Better Auth control plane for users, sessions, machine
  ownership, provider calls, SSH certificate signing, preview proxying, and VM
  agent RPC.
- `deploy/digitalocean`: production deployment, backup, and golden remote image
  tooling for the hosted DigitalOcean provider.

The CLI talks to the backend for machine metadata and short-lived SSH
certificates. File sync and command bytes go directly over SSH from the CLI to
the VM. The backend does not proxy user shell traffic.

Each VM runs a BoxHaven machine agent. The agent maintains a WebSocket to the
backend so the backend can ask the VM to run setup commands, prepare direct
commands, or create and attach the managed tmux session.

## Security Model

User access is based on authenticated backend sessions plus short-lived SSH user
certificates. User VMs do not receive account-level cloud SSH keys. The backend
signs temporary CLI public keys for the authenticated machine owner, and the VM
trusts the backend user CA.

GitHub repository access is separate from BoxHaven auth. When the local project
is a GitHub repo and `GH_TOKEN` or `GITHUB_TOKEN` is set, the CLI writes those
values over direct SSH to `/run/boxhaven/session.env` on the VM. The file is
root-only, lives in tmpfs, and is sourced by the machine agent before setup,
direct commands, or tmux session launches.

## Current Provider

The current provider implementation is DigitalOcean. The provider creates boxes
from a prebuilt BoxHaven snapshot when `BOXHAVEN_REMOTE_IMAGE` is configured.
Plain Ubuntu fallback images are not considered fully bootstrapped for normal
CLI use.
