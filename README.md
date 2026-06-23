# BoxHaven

BoxHaven gives development teams a standard way to run AI coding agents and
developer shells on named remote Linux boxes. Each box keeps running after a
laptop disconnects, has a managed tmux session for long-running Codex, Claude,
Gemini, or shell work, and can sync the current project to and from the remote
machine.

BoxHaven is built for the workflow many teams are assembling by hand today:
remote dev boxes for individual developers, persistent agent sessions, direct
SSH access, project sync, GitHub pushes from the box, and a self-hostable
control plane.

The CLI is intentionally small, and the workflow is agent-first: copy your
project to a box once, start Claude or Codex inside the box's tmux session —
resuming your local conversation if you like — then disconnect and let it
work:

```bash
bh login
bh create work        # provisions a box and syncs this project once
bh run work claude    # claude starts working in the box's tmux session
# close the laptop — the agent keeps going. Reattach any time:
bh connect work
```

Mid-conversation with Claude locally? `bh run work claude --continue` resumes
that exact session on the box.

Sign up with email and password or, when the operator configures a GitHub
OAuth app (`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`), with "Continue with
GitHub" — `bh login` then works the same either way.

Run as many agents in parallel as you want, each on its own box:

```bash
bh create work-2 && bh run work-2 codex
bh create work-3 && bh run work-3 claude
```

`bh create` asks the backend for a machine, waits for it to be reachable, and
syncs the current project into `/opt/boxhaven/project`. After that the box
owns its copy: `bh run` does not mirror local files, so nothing an agent does
on the box is ever overwritten by a routine command — `bh sync up` pushes
local changes explicitly (mirroring deletions) and `bh sync down` retrieves
the box's work. Project sync excludes common dependency/cache directories such
as `node_modules/`, `.next/`, and `.venv/` by default. Add a `.boxhavenignore`
file at the project root for additional rsync-style exclude patterns. Sync
completion reports elapsed time, network bytes, changed bytes, and file counts.

When you start `claude` or `codex` with `bh run`, bh forwards your newest
local sessions for the project, so `claude --continue` on the box picks up
the conversation exactly where your laptop left it. Interactive commands
attach to the machine's managed tmux session; noninteractive commands run
over direct SSH.

## What It Provides

- Named remote boxes: create, list, inspect, connect, sync, run, rename, and destroy.
- Project sync to `/opt/boxhaven/project` with explicit sync up/down commands.
- A managed tmux session per box for long-running AI agent sessions.
- Mouse-wheel scrolling through tmux history in interactive sessions.
- Direct SSH using backend-signed short-lived user certificates.
- GitHub HTTPS credential forwarding from local `GH_TOKEN` or `GITHUB_TOKEN`.
- Git safe-directory configuration for the synced project path.
- Optional preview hostnames for HTTP services running on the box.
- Multiple cloud providers per backend: DigitalOcean and Hetzner Cloud.
- Team-owned boxes with roles, shareable invite links, and per-team visibility.
- Admin-managed golden images that become the default for new boxes.
- An open-source Fastify/Better Auth backend.

## Docs

- [Overview](docs/overview.md)
- [Getting Started](docs/getting-started.md)
- [Operations](docs/operations.md)

## Hosted And Self-Hosted

`app.boxhaven.dev` is the hosted control plane run by the BoxHaven operators.
Hosted boxes are provisioned from the operators' cloud provider accounts, and
the operators can cap boxes per account with `BOXHAVEN_MAX_MACHINES_PER_USER`.

The same open-source backend self-hosts with your own provider credentials and
no built-in limits. See [backend/README.md](backend/README.md) for running the
backend and [deploy](deploy) for the production deployment bundle.

## Install

One-liner (macOS and Linux, installs the latest release):

```bash
curl -fsSL https://raw.githubusercontent.com/finbarr/boxhaven/master/install.sh | sh
```

Homebrew (via the `finbarr/tap` tap):

```bash
brew install finbarr/tap/boxhaven
```

Or build from source:

```bash
go build -o bh ./cmd/bh
./bh version
```

Then jump straight into the quickstart:

```bash
bh login
bh create work       # provisions the box and syncs this project once
bh run work claude   # start Claude in the box's tmux session
```

## Configuration

BoxHaven reads global config from `~/.config/boxhaven/config.toml` and project
config from `.boxhaven.toml`.

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

## Providers

A single backend can serve multiple cloud providers. `GET /v1/providers` lists
what a backend has configured, and `bh create` picks the backend default unless
a provider is requested explicitly:

```bash
bh create work --provider hetzner
bh create work --provider digitalocean --region sfo3
bh create work --provider hetzner --region fsn1 --image 12345678
```

`--region` and `--image` are passed through to the provider verbatim. Set a
project-wide default with the `provider` key under `[remote]` in
`.boxhaven.toml` or the global config.

The backend enables a provider when its credentials are present and selects the
default with `BOXHAVEN_BACKEND_PROVIDER`. When unset, the first configured
provider is the default (DigitalOcean when both are configured).

DigitalOcean:

- `DIGITALOCEAN_ACCESS_TOKEN`: API token, enables the provider.
- `DIGITALOCEAN_REGION`: default `nyc3`.
- `DIGITALOCEAN_SIZE`: default `s-2vcpu-4gb-amd`.
- `DIGITALOCEAN_IMAGE`: base image fallback, default `ubuntu-24-04-x64`.
- `BOXHAVEN_REMOTE_IMAGE_DIGITALOCEAN` (or legacy `BOXHAVEN_REMOTE_IMAGE`):
  golden snapshot id for new boxes.

Hetzner Cloud:

- `HCLOUD_TOKEN`: API token, enables the provider.
- `HETZNER_LOCATION`: default `nbg1` (also `fsn1`, `hel1`, `sin`). The tier
  server types are not orderable in the US locations `ash` and `hil`; to use
  those, set `HETZNER_SERVER_TYPE` to a plan Hetzner offers there and create
  boxes without `--tier`.
- `HETZNER_SERVER_TYPE`: default `cpx22`; tiers map to `cpx22`/`cpx32`/`cpx42`.
- `HETZNER_IMAGE`: base image fallback, default `ubuntu-24.04`.
- `BOXHAVEN_REMOTE_IMAGE_HETZNER`: golden snapshot id for new boxes.

## Teams

Every box belongs to a team. Each account automatically gets a default team
named `<name>'s team`, so boxes work with no setup. Create another team in the
console or from the CLI:

```bash
bh team create acme
```

Invite teammates by shareable link. `bh team invite <email>` (or the console
Teams view) creates an invitation and prints an invite URL such as
`https://app.boxhaven.dev/invite?id=<invitation-id>`; send that link to the
teammate, who accepts it after signing in with the invited email address.
BoxHaven does not send invitation emails.

New boxes land in the session's active team: `bh login` pins it, and accepting
an invitation, creating a team, or selecting a team in the console's Team view
switches it for that session. Control placement explicitly:

```bash
bh create work --team acme   # create a box directly in a team
bh team switch acme          # change the CLI default team for new boxes
bh move work acme            # move one of your boxes to another of your teams
```

Members have one of three roles: `owner`, `admin`, or `member`. Team members
see exactly the boxes in that team and who owns each one; boxes in your other
teams stay invisible to them. Owners and admins can destroy team boxes;
members can only destroy their own.

When you leave a team (or are removed), your boxes in it move back to your
active team the next time you list them; until that next listing, the old
team can still see and destroy them.

Moving or sharing never copies a box. To hand a teammate a box like yours,
snapshot it into a team image and create a new box from the resulting image:

```bash
bh image create work
bh create work-clone --image <image-id>
```

## Images

Golden images carry the BoxHaven VM runtime so new boxes boot ready to use.
Images belong to the active team. A team member can snapshot one of the
team's boxes, then select that image when creating another box in the same
team. If no image is selected, BoxHaven uses the backend's configured default
image for that provider.

```bash
bh image ls
bh image create work            # snapshot the box "work" into a golden image
bh create work-clone --image <image-id>
bh image rm <image-id> --force
```

## GitHub Repository Access

When the current project's `origin` points at GitHub, `bh create`, `bh run`,
`bh connect`, and `bh sync up` forward GitHub auth to the remote box in
`/run/boxhaven/session.env`. The file lives in tmpfs, is readable only by the
remote SSH user and root, and is replaced or removed by the CLI on the next
command. The remote image includes a Git credential helper that uses those
variables, so agents and shells inside the box can push to HTTPS GitHub remotes.

`GH_TOKEN` or `GITHUB_TOKEN` are used when set. Otherwise, if the GitHub CLI is
installed and authenticated locally, `bh` uses `gh auth token` and forwards that
token for the remote session. For the smoothest agent workflow, use an HTTPS
GitHub origin and either export a token with the repository scopes your team
allows or run `gh auth login` before starting the remote session.

`bh create`, `bh run`, `bh connect`, and `bh sync up` also forward selected
local agent login files for Claude, Codex, Gemini, GitHub Copilot, and
opencode (for example `~/.codex/auth.json`, `~/.claude.json`,
`~/.claude/.credentials.json` on Linux, and `~/.claude/settings.json`).
Recent claude/codex sessions for the current project are forwarded when you
start those agents so they can resume; broader histories, caches, and
databases are never copied.

Those commands also forward the effective local Git author identity for the
current project by setting `user.name` and `user.email` in the remote SSH user's
global Git config. BoxHaven does not copy the full local Git config.

## Web Preview

Each hosted box receives a public preview URL when the backend is configured
with a preview base domain. The backend warms the preview URL during machine
create so Caddy has already completed on-demand certificate issuance before the
URL is shown. Public HTTPS and WebSocket traffic terminate at the BoxHaven
control plane, then the backend proxies plain HTTP/WebSocket traffic to the
machine's `BOXHAVEN_PREVIEW_TARGET_PORT`, default `80`.

Inside the box, commands receive:

- `BOXHAVEN_PREVIEW_URL`: the browser URL to share.
- `BOXHAVEN_PREVIEW_HOSTNAME`: the public hostname.
- `BOXHAVEN_PREVIEW_TARGET_PORT` / `BOXHAVEN_WEB_PORT`: the machine port to
  serve, normally `80`.
- `BOXHAVEN_WEB_BIND`: the bind address to use, normally `0.0.0.0`.
- `/run/boxhaven/context.json`: structured runtime context with the same
  preview details under `.preview`.

Apps should bind HTTP to `0.0.0.0:$BOXHAVEN_WEB_PORT` or run a reverse proxy on
that port to the app's internal dev-server port. Framework dev-server
WebSockets, including Vite HMR, use the same preview URL. The default
`boxhaven` user has sudo access if binding to port 80 is required.

## Backend

The open-source backend in [backend](backend) provides:

- Better Auth browser/device login
- team-centric box ownership with automatic default teams
- DigitalOcean and Hetzner Cloud provisioning
- multi-member teams via Better Auth organizations with roles and invite links
- admin-managed golden images per provider
- backend-signed short-lived SSH certificates
- VM agent RPC for setup commands and tmux session lifecycle
- generated preview hostnames and a browser console

Run it locally:

```bash
cd backend
npm ci
BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
DIGITALOCEAN_ACCESS_TOKEN=dop_v1_example \
npm run dev
```

Then point the CLI at it:

```bash
bh login --backend-url http://127.0.0.1:8787
bh create work
```

## DigitalOcean Deployment

Production deployment and golden-image tooling live in
[deploy/digitalocean](deploy/digitalocean). Deploy the hosted production stack
from the repository root with:

```bash
npm run deploy:app
```

`npm run deploy:production` is kept as a compatibility alias for the same fast
app/API deploy. These commands SSH to `root@app.boxhaven.dev`, fast-forward
`/opt/boxhaven/app` on `master`, run the DigitalOcean Compose deploy, and check
the production app and API health endpoints. They do not rebuild the remote VM
snapshot.

After changing the VM runtime or image-builder code, explicitly rebuild and
publish the remote VM image:

```bash
npm run deploy:runtime
```

The runtime deploy creates and snapshots a temporary DigitalOcean builder
Droplet, updates `BOXHAVEN_REMOTE_IMAGE`, then restarts and verifies the backend
so new boxes use the image. When an active `BOXHAVEN_REMOTE_IMAGE` exists, the
builder starts from that snapshot by default instead of reinstalling the full
OS/toolchain from Ubuntu. Use `npm run deploy:runtime -- --full-base-image` only
for base OS or runtime dependency rebuilds.

Both deploy commands forward your SSH agent so the Droplet can fetch the private
GitHub repo without storing a GitHub token. Override the target with
`BOXHAVEN_DEPLOY_TARGET` or `-- --target user@host` for self-hosted installs.

## Production Smoke

Run the reusable remote lifecycle smoke against the hosted backend after remote
VM, SSH, sync, snapshot, or agent changes:

```bash
BOXHAVEN_TOKEN=... \
GH_TOKEN=... \
BOXHAVEN_SMOKE_GIT_REMOTE=https://github.com/<org>/<smoke-repo>.git \
make smoke-remote
```

The default smoke is intentionally fast: it creates one box from the active
snapshot, syncs a temporary Git project, verifies runtime tools, fetches the
preview URL, optionally pushes and deletes a temporary GitHub smoke branch, and
destroys the box unless `BOXHAVEN_SMOKE_KEEP=1` is set.

Use `make smoke-remote-full` with `BOXHAVEN_SMOKE_RESTART_BACKEND_CMD` when the
agent reconnect path needs coverage. Use `make smoke-remote-two-box` only for
concurrency, provider import, or multiple-machine behavior.
