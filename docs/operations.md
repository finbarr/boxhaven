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

To run the reusable local production-readiness preflight:

```bash
make production-check
```

This covers local builds, tests, lint, release packaging, checksum validation,
CLI smoke commands, and script syntax. It does not replace the remote lifecycle
smoke or hosted DigitalOcean audit.

`make lint` always runs `go vet`. It also runs `golangci-lint` when that binary
is installed locally.

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
docker compose --env-file deploy/digitalocean/.env.production \
  -f deploy/digitalocean/docker-compose.yml up -d --build --force-recreate backend
```

Keep the previous snapshot id until the remote lifecycle smoke passes.

## Release Archives

For a CLI release, build archives and checksums from a clean committed checkout:

```bash
make dist VERSION=v0.1.0
ls -lh dist/
sha256sum -c dist/checksums-v0.1.0.txt
```

Pushing a `v*` tag runs the release workflow, uploads the generated archives to
a GitHub release, and uses the matching `CHANGELOG.md` section as release notes.
Create the golden remote image from the same pushed tag or commit so the CLI,
backend, and VM runtime can be traced to one source revision.

## Production Health Checks

For the hosted DigitalOcean deployment:

```bash
docker compose --env-file deploy/digitalocean/.env.production \
  -f deploy/digitalocean/docker-compose.yml ps
curl -fsS https://api.boxhaven.dev/healthz
curl -fsS https://api.boxhaven.dev/metrics
curl -fsS https://app.boxhaven.dev/healthz
sudo systemctl status boxhaven-backend-backup.timer --no-pager
```

Backups are installed through `deploy/digitalocean/install-backups.sh` and write
archives under `/opt/boxhaven/backups`. Verify restore viability after backup
changes and during operations drills:

```bash
scripts/verify-backend-backup-restore.sh /opt/boxhaven/backups/<archive>.tar.gz
```

Production deployments should keep signup gated and machine creation bounded:

```bash
BOXHAVEN_SIGNUP_MODE=invite
BOXHAVEN_SIGNUP_INVITE_CODES=<comma-separated-codes>
BOXHAVEN_MAX_MACHINES_PER_USER=3
BOXHAVEN_MAX_MACHINES_TOTAL=100
BOXHAVEN_IDLE_MACHINE_TTL_HOURS=72
BOXHAVEN_STALE_CREATE_TTL_SECONDS=1800
```

Alert on failed health checks, missing metrics, container restarts, backup timer
failures, high `boxhaven_machines`, nonzero stale bootstrap counts, and
unexpected DigitalOcean spend.

Run the reusable DigitalOcean audit after firewall, snapshot, monitoring, or DNS
changes:

```bash
DIGITALOCEAN_ACCESS_TOKEN=... \
BOXHAVEN_REMOTE_IMAGE=<active-snapshot-id> \
make audit-digitalocean
```

The audit is read-only. It checks tagged droplets, broad SSH firewall ingress,
monitoring alert-policy presence, uptime checks for app/API health URLs, active
BoxHaven snapshot presence, and old non-active BoxHaven snapshots that should be
reviewed for cleanup.

Create missing app/API uptime checks with:

```bash
DIGITALOCEAN_ACCESS_TOKEN=... make ensure-uptime
```

Create baseline CPU, memory, and disk alert policies for BoxHaven-tagged
Droplets:

```bash
DIGITALOCEAN_ACCESS_TOKEN=... \
BOXHAVEN_ALERT_EMAILS=ops@example.com \
make ensure-alerts
```

Restrict BoxHaven SSH firewall ingress after deciding the trusted operator IP
ranges:

```bash
DIGITALOCEAN_ACCESS_TOKEN=... \
BOXHAVEN_TRUSTED_SSH_CIDRS=203.0.113.10/32,2001:db8::/64 \
make ensure-firewalls
```

Use `BOXHAVEN_DO_FIREWALL_DRY_RUN=1` first to review the exact firewall payload.
