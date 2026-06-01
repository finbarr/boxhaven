# Changelog

## Unreleased

- Split BoxHaven into a standalone remote development-machine repository.
- Replaced the inherited command surface with a lightweight `bh` CLI:
  `create`, `list`, `destroy`, `connect`, `run`, `sync`, `status`, `login`,
  `logout`, `config`, and `version`.
- Renamed config, environment variables, VM paths, backend package names, and
  deployment defaults to BoxHaven.
- Removed inherited local-tool documentation, workflows, skills, and image
  build surfaces from this repository.
- Hardened hosted backend guardrails with invite-gated signup, optional email
  domain checks, per-user and deployment-wide machine quotas, auth/create rate
  limits, stale-create cleanup, idle disconnected machine cleanup, bearer-token
  protected `/metrics`, request logging controls, and safer state writes.
- Added production backup/restore verification for backend state, auth SQLite
  data, and SSH certificate authority keys. The backup job now verifies each new
  archive before pruning older backups.
- Added reusable local and hosted production checks: `make production-check`,
  `make smoke-production-http`, `make smoke-remote`, `make audit-digitalocean`,
  uptime/alert/firewall remediators, strict environment and Compose validation,
  paginated DigitalOcean inventory reads, and dry-run-first snapshot pruning.
- Added explicit snapshot-id support to the dry-run-first DigitalOcean pruning
  workflow for retiring old manual snapshots while preserving the active image.
- Tightened the DigitalOcean production audit to require the baseline BoxHaven
  CPU, memory, and disk monitoring alert policies on the BoxHaven tag with the
  expected enabled state, metric types, comparisons, and thresholds.
- Required production deployments to set `BOXHAVEN_REMOTE_IMAGE` to an active
  BoxHaven remote snapshot before Compose can start the backend.
- Tightened golden-image builder cleanup so temporary DigitalOcean SSH keys it
  creates are removed with the builder Droplet.
- Added release packaging and installation automation with cross-platform CLI
  archives, checksums, a tag-driven GitHub release workflow, and
  `scripts/install-bh.sh`.
