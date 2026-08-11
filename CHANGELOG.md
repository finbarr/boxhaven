# Changelog

## Unreleased

## v0.2.0 - TBD

### Added

- Added direct OpenSSH and SCP access through generated `bh-<box>` aliases,
  managed by `bh ssh-config install`, `refresh`, and `uninstall`.
- Added non-blocking CLI update notices and a compact self-hosted console
  update banner. Both use the latest public GitHub release and stay out of the
  way when release discovery is unavailable.
- Added team size shortcuts and provider plan discovery, including
  region-compatible DigitalOcean defaults and region-scoped plan selection.
- Added native console account management, including password changes and
  longer-lived authentication sessions.
- Added Ghostty terminfo, SQLite tooling, and a pinned Chrome for Testing
  headless shell with its required libraries to remote images.

### Changed

- Relicensed BoxHaven from MIT to the GNU Affero General Public License v3.0.
- Redesigned the console around stable URLs, team-scoped navigation, full-width
  tables, and contextual drawers, with destructive actions requiring explicit
  confirmation in both the CLI and console.
- Unified public backend state in SQLite and replaced runtime module loading
  with compile-time contracts. Hosted commercial policy now runs outside the
  public backend; self-hosting remains vendor-neutral and defaults to allow-all.
- Excluded dependency caches from project syncs and added elapsed-time reporting
  for create and sync operations.
- Split the marketing site, documentation, and console surfaces so self-hosted
  deployments can serve the console and docs independently.

### Fixed

- Preserved backend, authentication, Caddy, and SSH CA state in verified
  backup archives, and serialized backend initialization and remote
  authentication updates.
- Fixed deployment argument forwarding, production health-check retries, and
  preview proxy warmup for HTTPS and WebSockets.
- Updated vulnerable backend dependencies and pinned compatible Codex and
  browser versions in the remote runtime.
- Prevented rotated authentication tokens from appearing in remote smoke-test
  output and made smoke cleanup reliably destroy disposable boxes.

## v0.1.0 - 2026-06-10

- `bh run` no longer mirrors the local project to the box: the project syncs
  at create and via `bh sync up`, so agent work on the box is never
  overwritten by a routine command (`bh run --sync` opts back in).
- Starting `claude` or `codex` with `bh run` forwards your newest local
  sessions for the project, so `claude --continue` on the box resumes the
  conversation your laptop was having. Auth forwarding also covers Linux
  Claude credentials, Gemini, GitHub Copilot, opencode, and the global
  `~/.claude/CLAUDE.md`.
- Fixed the golden image so `claude` is runnable by the box user, and made the
  image build and remote smoke verify that agents execute as the box user.
- Fixed incremental image rebuilds that silently re-snapshotted the old
  runtime, and pre-trusted the box project path for Codex so detached sessions
  are not blocked by its first-run trust prompt.
- Shell commands with arguments (`bash -lc '...'`) run over direct SSH instead
  of being treated as interactive sessions, and starting an already-running
  session from a non-terminal prints a hint instead of failing.
- `bh list` gained a STATUS column (`online`/`offline`/`creating`) from the
  machine agent heartbeat, and `bh status` shows `agent_last_seen`.
- Added `bh team destroy <box> --force` so team owners and admins can remove a
  teammate's box from the CLI, and references to a teammate's box explain who
  owns it.
- CLI backend errors print the server's message instead of a raw JSON body,
  and session auth forwarding uses one SSH round trip instead of three.
- Made box ownership team-centric: every account automatically gets a personal
  team, every box belongs to a team, and new boxes land in the session's
  active team.
- Added `bh create --team`, `bh team switch <team>`, and
  `bh move <name> <team>` for choosing or changing a box's team.
- Added an operator-set per-user box limit through
  `BOXHAVEN_MAX_MACHINES_PER_USER`.
- Scoped team machine lists and destroy operations to boxes that belong to the
  selected team.
- Added DigitalOcean and Hetzner support through a provider registry, plus
  `bh create --provider`, `--region`, and `--image` for per-box selection.
- Added managed golden images through `bh image`, a console Images view, and
  `BOXHAVEN_ADMIN_EMAILS` admin gating.
- Added Better Auth organization-backed teams with shareable invite links,
  owner/admin/member roles, team box visibility, and console management.
- Added release archives for Linux and macOS on amd64 and arm64, an installer,
  and a Homebrew formula template.
- Split BoxHaven into a standalone remote development-machine repository with
  a lightweight `bh` CLI and BoxHaven-specific configuration and deployment
  defaults.
