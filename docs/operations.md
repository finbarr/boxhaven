# Operations

This page covers the operational workflows that should be repeatable before
BoxHaven changes are considered done.

## Local Verification

For CLI or shared behavior changes:

```bash
make clean && make build && make test
make lint
./bh version
./bh help
./bh config
```

For backend or browser app changes:

```bash
npm --prefix backend run build
npm --prefix backend test
```

`make lint` always runs `go vet`. It also runs `golangci-lint` when that binary
is installed locally.

## Local Compose Backend Smoke

Run the Docker Compose backend after backend, browser, auth, or deployment
container changes. This verifies the production container build, the served app,
and basic API reachability without creating cloud machines:

```bash
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-$(openssl rand -hex 32)}"
export DIGITALOCEAN_ACCESS_TOKEN="${DIGITALOCEAN_ACCESS_TOKEN:-dop_v1_local_smoke}"
export BOXHAVEN_BACKEND_PORT=127.0.0.1:8877
export BETTER_AUTH_URL=http://127.0.0.1:8877/v1/auth
export BOXHAVEN_APP_URL=http://127.0.0.1:8877
export BOXHAVEN_API_URL=http://127.0.0.1:8877

docker compose -f docker-compose.backend.yml up -d --build
docker compose -f docker-compose.backend.yml ps
curl -fsS http://127.0.0.1:8877/healthz
curl -fsS http://127.0.0.1:8877/v1/providers
curl -fsS -I http://127.0.0.1:8877/
BOXHAVEN_BACKEND_URL=http://127.0.0.1:8877 ./bh config
```

Use a real `DIGITALOCEAN_ACCESS_TOKEN` and `bh login --backend-url
http://127.0.0.1:8877` before running creates or the remote lifecycle smoke
against the local stack. A dummy token only covers startup and read-only checks.
When done, stop the stack with:

```bash
docker compose -f docker-compose.backend.yml down
```

## Remote Lifecycle Smoke

Remote VM, SSH, sync, snapshot, preview, and agent changes need a real
production or production-equivalent smoke. The reusable script is:

```bash
make smoke-remote
```

Typical hosted production run:

```bash
BOXHAVEN_TOKEN=... \
GH_TOKEN=... \
BOXHAVEN_SMOKE_GIT_REMOTE=https://github.com/<org>/<smoke-repo>.git \
make smoke-remote
```

The smoke does the following:

- Builds the `bh` binary if needed.
- Creates a temporary Git project.
- Creates two remote boxes.
- Verifies both boxes appear in `bh list`.
- Syncs the project into each box.
- Runs direct commands on both boxes.
- Verifies expected runtime tools such as `codex`, `claude`, `gh`, `tmux`, and
  Docker.
- Starts an HTTP server and fetches each generated preview URL.
- When `BOXHAVEN_SMOKE_GIT_REMOTE` and `GH_TOKEN` or `GITHUB_TOKEN` are set,
  verifies GitHub credential forwarding and pushes then deletes temporary smoke
  branches.
- Destroys both boxes unless `BOXHAVEN_SMOKE_KEEP=1` is set.

Useful options:

```bash
BOXHAVEN_SMOKE_BACKEND_URL=https://api.boxhaven.dev
BOXHAVEN_SMOKE_TIER=small
BOXHAVEN_SMOKE_PREFIX=my-smoke
BOXHAVEN_SMOKE_KEEP=1
BOXHAVEN_SMOKE_REQUIRE_PREVIEW=0
```

For agent reconnect coverage, pass a backend restart command:

```bash
BOXHAVEN_SMOKE_RESTART_BACKEND_CMD="ssh root@<control-plane-ip> 'cd /opt/boxhaven/app && docker compose --env-file deploy/digitalocean/.env.production -f deploy/digitalocean/docker-compose.yml restart backend'" \
make smoke-remote
```

## Golden Image Rotation

Remote runtime dependencies belong in the golden VM image. After changing
`cmd/bh/assets/remote-vm-install.sh`, build and activate a new snapshot from a
clean committed checkout or pushed ref:

```bash
deploy/digitalocean/build-remote-image.sh \
  --env-file deploy/digitalocean/.env.production \
  --set-active
```

Restart the backend after `BOXHAVEN_REMOTE_IMAGE` changes so new creates use the
new snapshot:

```bash
npm run deploy:production
```

Keep the previous snapshot id until the remote lifecycle smoke passes.

`npm run deploy:runtime` still writes `BOXHAVEN_REMOTE_IMAGE` to the env file as
the env-configured default. A managed image activated with `bh image activate`
overrides that env default per provider at runtime through backend state, so
check `bh image ls` for an active image before assuming new boxes use the
env-configured snapshot. Run `bh image deactivate` to fall back to the env
default.

## Managed Images

Backend admins, listed in `BOXHAVEN_ADMIN_EMAILS`, can manage golden images
without rerunning the image builder. Snapshot a prepared box, then activate the
resulting image:

```bash
bh image create work
bh image ls
bh image activate <image-id>
```

`bh image create` snapshots one of your own boxes; the backend prefixes the
image name with `boxhaven-remote-`. The snapshot starts in `creating` status
and can only be activated once it is `available`. Activation makes the image
the default for new boxes on that provider until `bh image deactivate` is run,
and an active image cannot be deleted (`bh image rm` returns a conflict). The
console Images view offers the same operations.

After activating a new image, run the remote lifecycle smoke before relying on
it, and keep the previous image around for rollback until the smoke passes.

## Teams

Create a team in the console or from the CLI:

```bash
bh team create acme
```

Invite teammates with `bh team invite <email>` or from the console Teams view.
BoxHaven does not send invitation emails: the invite is a shareable link of the
form `<app-url>/invite?id=<invitation-id>`. Send it to the teammate, who signs
in with the invited email address and accepts. Accepting also switches that
session's active team to the joined team.

Every box belongs to a team, and every account gets a personal team
automatically. New boxes land in the session's active team; `bh create --team`
targets a team explicitly, `bh team switch <team>` changes the CLI default,
and `bh move <name> <team>` moves a box between the owner's teams. Creating a
team or selecting one in the console's Team view also switches that session's
active team.

When a member leaves or is removed from a team, their boxes in it move back
to their active team the next time they list their boxes; until then the old
team can still see and destroy those boxes.

Roles are `owner`, `admin`, and `member`. Members see exactly the boxes in
that team and their owners — not every box of every member. Owners and admins
can destroy any box in the team; members can only destroy their own. Pending
invitations can be cancelled by the inviter or a team admin before they are
accepted.

## Production Deploy

For the hosted DigitalOcean deployment, use the checked-in npm entrypoint from
the repository root:

```bash
npm run deploy:production
```

The command SSHes to `root@app.boxhaven.dev`, fast-forwards
`/opt/boxhaven/app` on `master`, runs the Compose deploy on the Droplet, and
checks the app and API health endpoints. It forwards your SSH agent so the
Droplet can fetch the private GitHub repo without storing a GitHub token.
Override the SSH target with `BOXHAVEN_DEPLOY_TARGET=root@<control-plane-ip>` or
run `npm run deploy:production:local` from the Droplet checkout.

## Production Health Checks

For the hosted DigitalOcean deployment:

```bash
npm run deploy:production:verify
sudo systemctl status boxhaven-backend-backup.timer --no-pager
```

Backups are installed through `deploy/digitalocean/install-backups.sh` and write
archives under `/opt/boxhaven/backups`.
