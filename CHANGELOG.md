# Changelog

## Unreleased

- Added `bh dev`: one command that derives the box name from the project
  (or `remote_name` in `.boxhaven.toml`), creates the box on first use, syncs
  the project, and runs the given or configured command in the managed
  session.
- Added `bh run --no-sync` to skip the local-to-remote project mirror so
  remote edits (for example from an agent session on the box) are not
  overwritten, and documented the sync model.
- Shell commands with arguments (`bash -lc '...'`) now run over direct SSH
  instead of being treated as interactive sessions, and starting an already
  running session from a non-terminal prints a hint instead of failing.
- `bh list` gained a STATUS column (`online`/`offline`/`creating`) from the
  machine agent heartbeat, and `bh status` shows `agent_last_seen`.
- Added `bh team destroy <box> --force` so team owners and admins can remove
  a teammate's box from the CLI, and referencing a teammate's box by name now
  explains who owns it instead of "machine does not exist".
- CLI backend errors now print the server's message instead of a raw JSON
  body, and session auth forwarding uses one SSH round trip instead of three,
  roughly halving `bh run` latency.

- Made box ownership team-centric: every account automatically gets a personal
  team, every box belongs to a team, and new boxes land in the session's
  active team (`bh login` pins it; accepting an invite switches it for that
  session). `GET /v1/auth/whoami` now returns the active `team` and all
  `teams`, and machine responses include `org_id`, `team_id`, `team_slug`, and
  `team_name`.
- Added `bh create --team` for creating a box directly in a team,
  `bh team switch <team>` for changing the CLI default team, and
  `bh move <name> <team>` plus `POST /v1/machines/:name/move` for moving a box
  between your teams.
- Added an operator-set per-user box limit via `BOXHAVEN_MAX_MACHINES_PER_USER`
  (`0` or unset means unlimited); `POST /v1/machines` returns `403`
  `limit_reached` when the cap is hit.
- Changed `GET /v1/orgs/:id/machines` to return only the boxes that belong to
  that team instead of all boxes of all members, and team destroys now return
  `404` for boxes outside the team. Joining a team no longer exposes your
  other boxes to it.
- Added multi-provider backend support with a provider registry and a Hetzner
  Cloud provider (`HCLOUD_TOKEN`, `HETZNER_LOCATION`, `HETZNER_SERVER_TYPE`,
  `HETZNER_IMAGE`, `BOXHAVEN_REMOTE_IMAGE_HETZNER`) alongside DigitalOcean,
  with `BOXHAVEN_BACKEND_PROVIDER` selecting the default.
- Added `bh create --provider`, `--region`, and `--image` plus a `provider`
  key under `[remote]` config for targeting a specific provider per box.
- Added managed golden images: `bh image ls`/`create`/`activate`/`deactivate`/
  `rm`, a console Images view, and `BOXHAVEN_ADMIN_EMAILS` admin gating. An
  activated image overrides the env-configured default image for new boxes on
  its provider.
- Added teams backed by Better Auth organizations: `bh team` and console team
  management, shareable invite links, owner/admin/member roles, team box
  visibility, and admin destroy of team members' boxes.
- Added a tag-triggered GitHub release workflow that publishes `bh` archives
  for linux/darwin on amd64/arm64 with checksums and CHANGELOG release notes.
- Split BoxHaven into a standalone remote development-machine repository.
- Replaced the inherited command surface with a lightweight `bh` CLI:
  `create`, `list`, `destroy`, `connect`, `run`, `sync`, `status`, `login`,
  `logout`, `config`, and `version`.
- Renamed config, environment variables, VM paths, backend package names, and
  deployment defaults to BoxHaven.
- Removed inherited local-tool documentation, workflows, skills, and image
  build surfaces from this repository.
