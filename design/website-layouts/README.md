# BoxHaven website layout exploration

Designs for review, September 26, 2026. No live website changes.

Open `index.html` for the comparison gallery. `a.html`, `b.html`, and `c.html`
are complete responsive HTML concepts with real selectable example boxes, task
examples, setup anchors, and copyable install commands. Existing logo and box
art are preserved. No generated replacement artwork was needed for layout work.

## Diagnosis

The live headline is abstract: it does not name agents, coding, or parallelism.
The adjacent box list mostly proves that servers are online. The next section
jumps into Node versions and installation before demonstrating why the product
is useful. Persistence has equal visual weight to parallelization, and a broad
feature grid makes it hard to remember the central promise.

Proposed order: parallel work → visible product → concrete example → control
and hosting → installation. Keep setup details available without putting them
in the visitor's first screen.

## Compared pages

Primary pages were read and their desktop hero layouts captured locally. Each
observation is about how the product is presented, not an independent feature
or performance evaluation.

| Site | Observed emphasis | Useful layout lesson |
| --- | --- | --- |
| [Conductor](https://www.conductor.build/) | A team of coding agents, a prominent product screenshot, a primary download action, and cloud workspaces further down. Its hero varies between Mac/cloud wording. | Explain the user's workflow immediately; make the actual product large enough to understand. |
| [Blaxel](https://blaxel.ai/) | Agent infrastructure, a primary start action and compact skill-install command, followed by social proof and technical categories. | Keep a clear action close to the promise. Avoid turning BoxHaven's homepage into an infrastructure catalog. |
| [E2B](https://e2b.dev/) | A machine for each agent; execution and result shown together; hosted and own-cloud options. | Give isolation a concrete meaning and illustrate a useful outcome. |
| [Daytona](https://www.daytona.io/) | Running AI code; a split hero with language-selectable SDK code and start/docs actions. | Direct language helps, but an SDK example is too early for BoxHaven's human workflow story. |

Conductor already markets cloud workspaces and E2B advertises own-cloud options.
Do not claim that remote execution or customer-controlled infrastructure is
unique. BoxHaven's combined pitch should be open-source tools for parallel coding
work: a desktop interface, separate remote machines, and a self-hostable backend.

## Three directions

**A — Product first (selected).** A centered explicit headline, concise remote
machine explanation, one primary CTA, and a wide selectable desktop illustration.
Follow with six illustrated product features, hosting, and three equal setup paths. Desktop, CLI, and agent skill each have their own card; the skill
prerequisites sit in a disclosure beneath the cards so their edges stay aligned. Repeated task cards have been removed.

**B — Request first.** A split hero pairs a short outcome headline with a realistic
request branching into three independent homepage explorations. Parallelism is
shown spatially, not as a review/build/test pipeline. The product comes next.
Tradeoff: it can look like a prompt-to-website product without the coding-agent
subtitle and a range of examples.

**C — Tasks first.** A split editorial layout puts a recognizable set of independent
jobs next to the benefit. Visitors switch between feature, exploration, and backlog
examples, then see the desktop view. Tradeoff: the product is less prominent than A.

A is the selected direction. The latest revision replaces the repeated desktop/CLI
explanation with concrete features verified against the implementation. Setup is
limited to installation choices rather than repeating the benefits.
B and C are retained as earlier explorations. These are still review artifacts;
the live site is unchanged.

## Copy and product boundaries

- Keep parallel work primary. Laptop-away persistence supports it.
- Existing machine status means online/offline, not agent completion or approval.
  The terminal output and task descriptions here are labeled illustrative examples.
- Do not promise automatic merges, conflict-free results, linear speedups, or
  sub-second provisioning. Independent tasks still need review and integration.
- Team inventory and shareable previews are supported. Do not imply that everyone
  can attach to and co-edit another person's terminal.
- Self-hosting describes deployment control. Avoid “code never leaves your servers”:
  agents may call external model providers, and that depends on configuration.
- The desktop app currently has a source-build/setup path. Link to its guide rather
  than a fictional signed download. Desktop, CLI, and agent skill are equal entry paths into the same boxes.
  The skill requires the CLI to be installed and authenticated.
- Setup command and CLI prerequisites retain the canonical existing workflow.
- Preserve the cabin logo, small quirky portraits, ivory, evergreen, and sage.
  No invented customer logos, quotes, metrics, or production task activity.

## Reproduce the review

From the public repository root, using the existing desktop Playwright dependency:

```sh
node design/website-layouts/capture-references.mjs
node design/website-layouts/smoke.mjs
```

The first command captures external reference pages under ignored `.artifacts/`.
The second serves only this repository locally, checks all three concepts at
1440, 1170, 390, and 320 pixels, exercises the example controls and copy action, checks
images, local links, console errors, and overflow, and refreshes `previews/`.
Full-page screenshots and diagnostic output are under ignored `.artifacts/`.

## Feature claims checked against code

- **Persistent machines and sessions:** `cmd/bh/assets/remote-vm-install.sh`
  `prepareSession` creates detached tmux sessions and reattaches existing ones.
  Disconnect does not destroy the VM. This is not suspend/resume or a durability SLA.
- **Per-box URLs:** `backend/src/server.ts` `normalizeMachine` derives preview
  HTTPS URLs when a preview domain is configured. A web service must listen on the
  preview port. Previews are public, not team-authenticated links.
- **Local folder sync:** `cmd/bh/remote.go` `syncRemoteProject`,
  `rsyncPathToRemote`, and `rsyncPathFromRemote` copy the folder, not just committed
  Git content. Creation syncs once; subsequent up/down operations are explicit
  mirrors, including deletions. Exclusions apply. Desktop creation starts empty.
- **Credentials:** `syncRemoteAuthState`, `remoteGitAuthEnv`, and
  `localRemoteAuthFiles` forward available GitHub tokens, Git author identity, and
  selected agent files. This does not forward every secret or all OS-keychain
  credentials (notably Claude OAuth stored in the macOS Keychain).
- **Teams:** `backend/src/server.ts` team machine routes list shared inventory
  with owner metadata and roles. This does not promise access to another user's
  SSH terminal. Team invitations and public preview sharing are separate actions.
- **Reusable images:** `/v1/images` routes reserve team-owned images and ask the
  provider to snapshot a machine. These are machine images, not live RAM forks.

Also considered: direct SSH / VS Code Remote SSH (`cmd/bh/ssh_config.go`) and
forwarding recent Claude/Codex conversations (`cmd/bh/agent_sessions.go`). Useful
secondary docs topics; omit from this first six-card section to keep it focused.
No remote behavior changed or live machine was created for this copy revision.

The cloud CTA is “Start on BoxHaven Cloud.” Self-hosting links explicitly to
GitHub in a new tab. The smoke verifies that popup with a stubbed destination.
