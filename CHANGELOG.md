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
  data, and SSH certificate authority keys.
- Added reusable local and hosted production checks: `make production-check`,
  `make smoke-remote`, `make audit-digitalocean`, uptime/alert/firewall
  remediators, strict environment and Compose validation, paginated
  DigitalOcean inventory reads, and dry-run-first snapshot pruning.
- Added release packaging and installation automation with cross-platform CLI
  archives, checksums, a tag-driven GitHub release workflow, and
  `scripts/install-bh.sh`.
