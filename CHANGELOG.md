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
