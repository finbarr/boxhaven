# BoxHaven Production Notes

Last updated: 2026-06-01

This is a handoff snapshot of the BoxHaven production work completed so far. It intentionally excludes tokens, passwords, private keys, and other secrets.

## Repos and Product Split

- Created the standalone private `boxhaven` repo from the remote side of Yolobox.
- Pushed the BoxHaven repo to `https://github.com/finbarr/boxhaven.git`.
- Kept BoxHaven focused on remote hosted boxes, with `yolobox` kept for the local/container workflow.
- Removed Yolobox naming from the BoxHaven app/CLI surface.
- Added a lightweight `bh` CLI with commands including:
  - `bh create`
  - `bh list`
  - `bh destroy`
  - `bh connect`
  - `bh run`
  - `bh sync`
  - `bh status`
  - `bh login` / `bh logout`
  - `bh config`

Current notable BoxHaven commits:

- `4eae5b4` - Make BoxHaven a standalone bh CLI
- `546bf17` - Refresh BoxHaven app design
- `5db1284` - Use at.boxhaven.dev for preview hosts

## Brand and App Refresh

- Reworked the app around the "little home for your boxes" / haven concept.
- Generated and committed quirky BoxHaven logo assets:
  - `backend/app/src/assets/boxhaven-logo-source.png`
  - `backend/app/src/assets/boxhaven-logo.png`
  - `backend/app/public/favicon.png`
  - `backend/app/public/boxhaven-icon-192.png`
- Updated the app copy, visual direction, and product naming around BoxHaven.

## Production Deployment

Primary control droplet:

- IP: `164.90.137.138`
- Droplet name: `boxhaven-control-prod-nyc3-01`
- Guest hostname: `boxhaven-control-prod-nyc3-01`

Production URLs:

- App: `https://app.boxhaven.dev`
- API: `https://api.boxhaven.dev`
- Preview wildcard base: `*.at.boxhaven.dev`

Production environment:

- `BOXHAVEN_PREVIEW_BASE_DOMAIN=at.boxhaven.dev`
- `BOXHAVEN_REMOTE_IMAGE=230979614`

Production containers:

- `digitalocean-backend-1`
  - Image: `boxhaven/backend:production`
  - Status: healthy
- `digitalocean-caddy-1`
  - Image: `caddy:2-alpine`

## Golden Remote Image

Active BoxHaven remote snapshot:

- Snapshot ID: `230979614`
- Snapshot name: `boxhaven-remote-7389477853b8-20260601031234`
- Built from deployed source on droplet-local commit `7389477853b8`

This snapshot is currently configured as the remote box image for new BoxHaven machines.

## DNS

- `app.boxhaven.dev` points to the production droplet.
- `api.boxhaven.dev` points to the production droplet.
- `*.at.boxhaven.dev` points to the production droplet.
- Verified `sample.at.boxhaven.dev -> 164.90.137.138`.
- `bh.run` is available but costs about `$220/year`, so it has been deferred.

## DigitalOcean Account Cleanup

Installed local `doctl`:

- Path used: `/home/yolo/.local/bin/doctl`
- Version checked: `1.160.0-release`

Deleted stale Yolobox droplets:

- `yolobox-foobar-a555c74bc2`
- `yolobox-barbar-6ba1e46f16`

Deleted old Yolobox resources:

- 7 old `yolobox-remote-*` snapshots
- stale `yolobox-image-builder-*` SSH keys
- empty Yolobox/smoke tags

Remaining active droplets:

- `boxhaven-control-prod-nyc3-01`
- `fundy-prod-nyc3-01`
- `calmbox-prod-nyc3-01`
- `electric-monk-prod-nyc3-01`
- `web` legacy droplet

## DigitalOcean Projects

Created or organized these projects:

- `boxhaven`
- `electric-monk`
- `legacy`

Updated:

- `calmbox` project set to `Web Application / Production`

Moved droplets into projects:

- `boxhaven-control-prod-nyc3-01` -> `boxhaven`
- `fundy-prod-nyc3-01` -> `fundy`
- `calmbox-prod-nyc3-01` -> `calmbox`
- `electric-monk-prod-nyc3-01` -> `electric-monk`
- `web` -> `legacy`

The default DigitalOcean project has no droplets left in it.

## Cloud Firewalls

Added baseline cloud firewall coverage across all active droplets.

Firewall: `baseline-public-web-ssh`

- Applies to all 5 active droplets
- Inbound:
  - TCP `22`
  - TCP `80`
  - TCP `443`
- Outbound:
  - TCP to internet
  - UDP to internet
  - ICMP to internet

Existing firewalls retained:

- `electric-monk-prod`
- `calmbox-prod-web`

Added BoxHaven-specific future box firewall:

- Firewall: `boxhaven-user-boxes`
- Applies to tag: `boxhaven`
- Same public SSH/web ingress posture for future BoxHaven boxes/builders.

## Backups

Disabled the old Yolobox backend backup timer:

- `yolobox-backend-backup.timer`

Installed and enabled the BoxHaven backend backup timer:

- `boxhaven-backend-backup.timer`

Recent backup examples under `/opt/boxhaven/backups`:

- `boxhaven-backend-20260601T032059Z.tar.gz`
- `boxhaven-backend-20260601T032143Z.tar.gz`
- `boxhaven-backend-20260601T032846Z.tar.gz`

## Verification Completed

Local BoxHaven verification:

- `npm --prefix boxhaven/backend run build` passed
- `npm --prefix boxhaven/backend test` passed, 23/23

Earlier full local verification included:

- `make clean && make build && make test`
- `make lint`
- `go run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@latest run ./...`
- `npm --prefix backend run build`

Production HTTP checks:

- `https://api.boxhaven.dev/healthz` returned `ok`
- `https://app.boxhaven.dev/` returned `HTTP/2 200`
- `https://api.boxhaven.dev/v1/providers` returned DigitalOcean provider data

Production CLI smoke:

- Created a temporary remote box.
- Synced a project into it.
- Ran commands with `bh run`.
- Verified remote command output.
- Destroyed the temporary box.

Cloud firewall smoke:

- Created a temporary box after firewall rollout.
- Verified direct SSH command execution.
- Destroyed the temporary box.

`at.boxhaven.dev` preview smoke:

- Created temp box `at-smoke-042847`.
- Generated preview URL `https://amber-ridge-405867.at.boxhaven.dev`.
- Started a Python HTTP server on remote port `80`.
- Fetched the preview through Caddy/TLS.
- Verified response body: `boxhaven at preview smoke at-smoke-042847`.
- Destroyed the box.
- Removed temporary smoke users/tags.
- Confirmed backend machine state was empty afterward.

## Still Worth Cleaning Up

- Inspect, migrate, or delete the old `web` droplet in the `legacy` project.
  - It was created in 2015 and appears to have Ubuntu 14.04-era history.
- Decide what to do with old manual snapshots:
  - `160948396 web-1721476164359`
  - `160956820 ubuntu-2gb-lon1-01-1721479579450`
- Keep the active BoxHaven remote snapshot:
  - `230979614 boxhaven-remote-7389477853b8-20260601031234`
- Consider restricting SSH ingress from `0.0.0.0/0` to trusted or VPN IP ranges.
- Add monitoring alerts for production services.
  - Current alert count was `0` during the audit.
- Inspect Fundy backup storage.
  - It was roughly `293 GiB` across 7 backups during the cleanup review.
- Consider a shorter preview domain later.
  - `bh.run` is available but expensive at the moment.

