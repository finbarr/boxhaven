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

The CLI is intentionally small:

```bash
bh login
bh create work
bh list
bh run work codex
bh connect work
bh rename work client-a
bh destroy work
bh image ls
bh team create acme
```

`bh create` asks the backend for a machine, waits for it to be reachable, and
syncs the current project into `/opt/boxhaven/project` by default. `bh run`
syncs the current project before starting the command on the existing machine.
Interactive commands attach to the machine's managed tmux session; noninteractive
commands run over direct SSH.

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
- Teams with shared box visibility, roles, and shareable invite links.
- Admin-managed golden images that become the default for new boxes.
- An open-source Fastify/Better Auth backend.

## Docs

- [Overview](docs/overview.md)
- [Getting Started](docs/getting-started.md)
- [Operations](docs/operations.md)

## Install From Source

```bash
go build -o bh ./cmd/bh
./bh version
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

Teams share box visibility across an organization. Create a team in the
console or from the CLI:

```bash
bh team create acme
```

Invite teammates by shareable link. `bh team invite <email>` (or the console
Teams view) creates an invitation and prints an invite URL such as
`https://app.boxhaven.dev/invite?id=<invitation-id>`; send that link to the
teammate, who accepts it after signing in with the invited email address.
BoxHaven does not send invitation emails.

Members have one of three roles: `owner`, `admin`, or `member`. Every member
sees the team's boxes and who owns each one. Owners and admins can also destroy
team members' boxes; members can only destroy their own.

Box ownership stays personal: joining a team makes all of your boxes visible
to that team, and its owners and admins can destroy them. If you belong to
several teams, each team sees your boxes. Keep separate accounts if you need
boxes isolated between teams.

## Images

Golden images carry the BoxHaven VM runtime so new boxes boot ready to use.
Backend admins, listed by email in `BOXHAVEN_ADMIN_EMAILS`, can manage them
from the CLI or the console Images view:

```bash
bh image ls
bh image create work            # snapshot the box "work" into a golden image
bh image activate <image-id>
bh image deactivate
bh image rm <image-id>
```

Activating an image makes it the default image for new boxes on that provider,
overriding the env-configured `BOXHAVEN_REMOTE_IMAGE*` default until the image
is deactivated. Non-admin users get a `403` from the image endpoints.

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

`bh create`, `bh run`, `bh connect`, and `bh sync up` also forward selected local
agent login files for Codex and Claude, including `~/.codex/auth.json`,
`~/.codex/config.toml`, `~/.claude.json`, and `~/.claude/settings.json`. It does
not copy histories, sessions, caches, or databases.

Those commands also forward the effective local Git author identity for the
current project by setting `user.name` and `user.email` in the remote SSH user's
global Git config. BoxHaven does not copy the full local Git config.

## Web Preview

Each hosted box receives a public preview URL when the backend is configured
with a preview base domain. Public HTTPS traffic terminates at the BoxHaven
control plane, then the backend proxies plain HTTP to the machine's
`BOXHAVEN_PREVIEW_TARGET_PORT`, default `80`.

Inside the box, commands receive:

- `BOXHAVEN_PREVIEW_URL`: the browser URL to share.
- `BOXHAVEN_PREVIEW_HOSTNAME`: the public hostname.
- `BOXHAVEN_PREVIEW_TARGET_PORT` / `BOXHAVEN_WEB_PORT`: the machine port to
  serve, normally `80`.
- `BOXHAVEN_WEB_BIND`: the bind address to use, normally `0.0.0.0`.
- `/run/boxhaven/context.json`: structured runtime context with the same
  preview details under `.preview`.

Apps should bind HTTP to `0.0.0.0:$BOXHAVEN_WEB_PORT` or run a reverse proxy on
that port to the app's internal dev-server port. The default `boxhaven` user has
sudo access if binding to port 80 is required.

## Backend

The open-source backend in [backend](backend) provides:

- Better Auth browser/device login
- per-user machine ownership
- DigitalOcean and Hetzner Cloud provisioning
- teams via Better Auth organizations with shared box visibility
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
activate the remote VM image:

```bash
npm run deploy:runtime
```

The runtime deploy creates and snapshots a temporary DigitalOcean builder
Droplet, updates `BOXHAVEN_REMOTE_IMAGE`, then restarts and verifies the backend
so new boxes use the image. When an active `BOXHAVEN_REMOTE_IMAGE` exists, the
builder starts from that snapshot by default instead of reinstalling the full
OS/toolchain from Ubuntu. Use `npm run deploy:runtime -- --full-base-image` only
for base OS or runtime dependency rebuilds. An image activated with
`bh image activate` overrides the env-configured default for that provider at
runtime until it is deactivated.

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
