# Security Model

This page describes how access to boxes works and exactly which credentials
the CLI forwards to a box. The backend does not proxy user shell traffic:
file sync and command bytes go directly over SSH from the CLI to the VM.

## SSH Certificates

User access is based on authenticated backend sessions plus short-lived SSH
user certificates. User VMs do not receive account-level cloud SSH keys. The
CLI creates one persistent device key under `~/.boxhaven/ssh`; its private key
never leaves the user's machine. The backend signs that device's public key for
the authenticated machine owner, and the VM trusts the backend user CA.

In detail: every backend-created machine trusts the backend SSH user CA. The
backend persists the CA private key, passes the CA public key plus a
per-machine authorized principal to provider user data, and signs device
public keys through `POST /v1/machines/:name/ssh-cert` only after
authenticating the machine owner. `bh ssh-config install` adds managed
`bh-<name>` aliases to OpenSSH; each `ssh`, `scp`, or `rsync` invocation obtains
a fresh short-lived certificate before connecting directly to the VM public
IP. User SSH bytes do not flow through the backend. CLI-side host-key pinning
lives in `~/.boxhaven/remote_known_hosts`.

On DigitalOcean, the backend uses a one-time no-login key during create only
to prevent provider password emails, then deletes the account key. SSH access
still goes through short-lived backend-signed certificates and VM trust of
the matching user CA.

## Machine Agent Authentication

Each VM runs a BoxHaven machine agent that maintains a WebSocket to the
backend so the backend can ask the VM to run setup commands, prepare direct
commands, or create and attach the managed tmux session.

Every machine created by the backend gets a server-generated 48-byte random
machine-agent token. The backend stores only a hash of that token and passes
the plaintext token to the provider as VM user data for
`/etc/boxhaven/agent.env`. Machine-agent endpoints authenticate only that
bearer token; they do not accept or trust a machine name claimed by the VM.

## GitHub Repository Access

GitHub repository access is separate from BoxHaven auth. When the current
project's `origin` points at GitHub, `bh create`, `bh run`, `bh connect`, and
`bh sync up` forward GitHub auth to the remote box in
`/run/boxhaven/session.env`. The file lives in tmpfs, is readable only by the
remote SSH user and root, and is replaced or removed by the CLI on the next
command. The remote image includes a Git credential helper that uses those
variables, so agents and shells inside the box can push to HTTPS GitHub
remotes. The backend does not persist those GitHub tokens.

`GH_TOKEN` or `GITHUB_TOKEN` are used when set. Otherwise, if the GitHub CLI
is installed and authenticated locally, `bh` uses `gh auth token` and
forwards that token for the remote session. For the smoothest agent workflow,
use an HTTPS GitHub origin and either export a token with the repository
scopes your team allows or run `gh auth login` before starting the remote
session.

## What Else Is Forwarded

`bh create`, `bh run`, `bh connect`, and `bh sync up` also forward selected
local agent login files for Claude, Codex, Gemini, GitHub Copilot, and
opencode (for example `~/.codex/auth.json`, `~/.claude.json`,
`~/.claude/.credentials.json` on Linux, and `~/.claude/settings.json`). These
files go directly to the VM over SSH; this avoids repeated agent logins on
fresh boxes without sending those files through the backend. The backend does
not receive or store these files.

Recent claude/codex sessions for the current project are forwarded when you
start those agents so they can resume; broader histories, caches, and
databases are never copied.

Those commands also forward the effective local Git author identity for the
current project by setting `user.name` and `user.email` in the remote SSH
user's global Git config. BoxHaven does not copy the full local Git config.

## Reporting

See [SECURITY.md](https://github.com/finbarr/boxhaven/blob/master/SECURITY.md)
in the repository for how to report security issues.
