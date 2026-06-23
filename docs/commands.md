# CLI Reference

The `bh` CLI is intentionally small. This page covers every command and flag.

```text
bh create <name> [--provider <name>] [--tier small|medium|large] [--region <region>] [--image <image>] [--team <team>] [--no-sync]
bh list
bh destroy <name> [--force]
bh rename <old-name> <new-name>
bh move <name> <team>
bh connect <name>
bh run <name> <cmd...>
bh sync up <name>
bh sync down <name> --force
bh status <name>
bh image ls|create|rm [...]
bh team list|create|switch|status|members|invite|boxes [...]
bh login [--backend-url <url>] [--no-open]
bh logout
bh config
bh version
```

Box names use lowercase letters, numbers, and hyphens, start and end with a
letter or number, and are at most 63 characters.

## bh create

```bash
bh create <name> [options]
```

Provisions a VM through the backend, waits until the BoxHaven agent and SSH
certificate trust are ready, then syncs the current directory to
`/opt/boxhaven/project`.

| Option | Description |
| --- | --- |
| `--no-sync` | Skip the create command's initial project sync |
| `--provider <name>` | Cloud provider for create (defaults to config or backend default) |
| `--tier <tier>` | Machine size tier for create: `small`, `medium`, or `large` |
| `--region <region>` | Provider region for create, passed through to the provider verbatim |
| `--image <image>` | Provider image ID or slug for create, passed through verbatim |
| `--team <team>` | Team that owns the new box (defaults to your active team) |
| `--ssh-user <user>` | SSH user for create |
| `--backend-url <url>` | Remote backend API URL for create |

## bh run

```bash
bh run <name> [--sync] <cmd...>
```

Runs a command on the box. Interactive commands — `claude`, `codex`,
`gemini`, `opencode`, `copilot`, `pi`, and a bare `shell`, `bash`, `sh`,
`zsh`, or `fish` — start or attach to the box's managed tmux session. Shells
with arguments (`bash -lc '...'`) and all other commands run directly over
SSH.

`bh run` does not mirror the local folder, so work done by agents on the box
is never overwritten by a routine command. Pass `--sync` to mirror the local
project first (this overwrites box-side edits).

Starting `claude` or `codex` forwards your newest local sessions for the
current project, so `claude --continue` on the box resumes the conversation
your laptop was having:

```bash
bh run work claude --continue
```

## bh connect

```bash
bh connect <name>
```

Attaches to the box's managed tmux session over direct SSH, starting a shell
session if none exists. Disconnecting leaves the session running.

## bh sync

```bash
bh sync up <name>
bh sync down <name> --force
```

`sync up` pushes the local project to `/opt/boxhaven/project`, mirroring
deletions. `sync down` pulls the box's project back into the local checkout;
it overwrites local files by design, so it requires `--force`. Sync excludes
common dependency/cache directories such as `node_modules/`, `.next/`, and
`.venv/` by default and reads additional rsync-style exclude patterns from
`.boxhavenignore` at the project root. Excluded paths are preserved on the
receiver even when sync mirrors deletions.

## bh list

```bash
bh list
```

Lists your boxes with name, status, team, provider, size, and preview URL.
Status is reported from the machine agent's last heartbeat: `creating` until
bootstrap completes, then `online` when the agent has been seen within the
last five minutes, otherwise `offline`.

## bh status

```bash
bh status <name>
```

Prints the full backend record for one box: provider, public IP, size,
region, image, SSH user, preview URL, source and project paths, repo and
branch, last sync time, agent last-seen time, and bootstrap state.

## bh rename

```bash
bh rename <old-name> <new-name>
```

Renames the box record while keeping the underlying provider VM, preview
hostname, SSH principal, and agent identity unchanged.

## bh move

```bash
bh move <name> <team>
```

Moves one of your boxes to another of your teams. See [Teams](/teams).

## bh destroy

```bash
bh destroy <name> [--force]
```

Destroys the box and its provider VM. Owners and admins can destroy team
boxes; members can only destroy their own (see `bh team destroy` below for
removing a teammate's box). Without `--force`, the CLI prompts for
confirmation in interactive terminals and refuses to continue in noninteractive
sessions.

## bh image

```bash
bh image ls [--provider <name>]
bh image create <machine> [--name <name>]
bh image rm <id> [--provider <name>] [--force]
```

Images belong to the active team. Pass an image id to `bh create --image <id>`
when creating a box; without `--provider` image commands use the backend's
default provider. `bh image rm` prompts unless `--force` is passed. See
[Images](/images) for the full workflow.

## bh team

```bash
bh team list
bh team create <name>
bh team switch <team>
bh team status
bh team members [--team <slug-or-id>]
bh team invite <email> [--role member|admin|owner] [--team <slug-or-id>]
bh team boxes [--team <slug-or-id>]
bh team destroy <box> [--force] [--team <slug-or-id>]
```

`--team` is optional when you belong to exactly one team. `bh team destroy`
removes a teammate's box; it requires the owner or admin role and prompts
unless `--force` is passed. See [Teams](/teams) for the team workflow.

## bh login

```bash
bh login [--backend-url <url>] [--no-open]
bh login [--backend-url <url>] --token <token>
```

Without `--token`, boxhaven opens a browser approval flow and also prints the
URL. `--no-open` prints the browser login URL without trying to open it.
`--token` stores an existing backend session token without calling the login
API.

## bh logout

```bash
bh logout
```

Revokes the backend session and clears the stored token.

## bh config

```bash
bh config
```

Prints the effective configuration: `backend_url`, `token` (redacted),
`ssh_user`, `provider`, `remote_name`, `command`, and `setup`.

## bh version

```bash
bh version
```

Prints the CLI version and platform.

## Configuration Files And Environment

BoxHaven reads global config from `~/.config/boxhaven/config.toml` and project
config from `.boxhaven.toml`:

```toml
[remote]
backend_url = "https://api.boxhaven.dev"
token = "browser-granted-session-token"
ssh_user = "boxhaven"
provider = "hetzner"
setup = [
  "docker compose up -d db"
]
```

Environment overrides:

- `BOXHAVEN_BACKEND_URL`
- `BOXHAVEN_TOKEN`
- `GH_TOKEN` or `GITHUB_TOKEN` for GitHub repository access inside remote boxes
