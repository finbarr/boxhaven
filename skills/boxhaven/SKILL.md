---
name: boxhaven
description: Use the bh CLI to create and manage remote BoxHaven machines, run persistent Codex or Claude tasks on one or several boxes, inspect progress, share web previews, and retrieve work. Use when the user asks to work on BoxHaven boxes or launch parallel remote agents.
---

# BoxHaven

Run this skill on the computer with the user's `bh` login. A box is a remote
Linux VM with its own project copy and persistent agent session. Use the CLI
for ordinary machine operations; cloud-provider credentials are not needed.

## Establish the workspace

- Locate `bh` with `command -v bh`; in the BoxHaven source checkout, `./bh` may
  be the freshly built CLI. Check `bh version`, `bh help`, and `bh list`.
  If absent, follow [installation](https://docs.boxhaven.dev/getting-started).
- If authentication is missing, use `bh login` (or `bh login --no-open` for a
  printed browser URL). Let the user finish browser authentication. Never
  print or embed the saved token in prompts, manifests, or logs.
- Honor the configured backend, requested team/provider/size, agent, and model.
  `bh team list`, `bh size list`, and `bh config` help resolve configuration.
  Do not switch the user's active team merely to launch a task; use `--team`.
- Start from the intended project directory. Create syncs that directory,
  including its Git metadata, into `/opt/boxhaven/project`. Use a separate
  checkout/worktree or task directory for each independent agent. Review what
  will be uploaded and use `.boxhavenignore` for additional exclusions.
- For a delegated build, write a concrete `TASK.md`: outcome, scope, checks,
  expected artifacts, and whether to keep a public app running. Respect the
  project's existing instructions. Do not invent a different task or model.

## One box

From the task's local directory:

```bash
bh create work
bh status work
bh run work bash -lc 'pwd; command -v codex; command -v claude'
bh run work codex 'Read TASK.md, complete the task, and record the checks and results.'
# In an attached terminal: Ctrl-b, then d disconnects without stopping the agent.
bh connect work
```

Use `bh run work claude 'Read TASK.md and complete the task.'` for Claude.
Starting Codex or Claude forwards selected local auth/config files and recent
sessions for this project. `bh run work claude --continue` resumes the most
recent forwarded Claude conversation when that is the user's intent.

`bh run` classifies agent commands into the managed tmux session named
`boxhaven`. With a terminal, it attaches; without a terminal, it starts detached
and returns. `bh connect` reattaches. If that session already exists, another
`bh run work codex ...` attaches to it; it does **not** send a fresh task. Inspect
and continue the existing session instead of assuming a second task started.
Commands such as `bash -lc '...'` run directly over SSH without replacing it.

## Several boxes at once

Choose a bounded number consistent with the user's request. List existing
boxes first, use fresh names, and keep a manifest of exactly the boxes created
for this task. Each running VM costs money even when its agent is idle; consult
current `bh size list` rates and report what remains running. Provider capacity
limits can reject individual creates; do not delete unrelated boxes or retry
the whole batch blindly.

The optional [parallel launcher](scripts/launch.py) uses Python 3's standard
library and a JSON manifest. It checks every workspace/name before creating,
runs independent creates concurrently, and starts each agent as its box becomes
ready. Each manifest entry has `name`, `directory`, and `agent` (an argument
array beginning with `codex` or `claude`). Optional create settings are `size`,
`provider`, `region`, `image`, and `team`. Relative directories resolve against
the manifest's location.

```json
[
  {"name":"demo-orchard","directory":"./orchard","agent":["codex","Read TASK.md and implement it. Verify the result."]},
  {"name":"demo-observatory","directory":"./observatory","agent":["claude","Read TASK.md and implement it. Verify the result."]}
]
```

Create the task directories and instructions before running:

```bash
python3 /path/to/boxhaven/scripts/launch.py ./tasks.json --jobs 2
# Use --bh /absolute/path/to/bh when the CLI is not on PATH.
```

The script prints a temporary `boxhaven-launch-*` directory outside the projects with
per-stage logs, timestamped events, and `results.json`. It leaves created boxes
running, finishes independent jobs after a failure, and exits nonzero if any
job failed. It does not retry or automatically destroy machines. Successful
launch results mean **session launched**, not task completed. Inspect the logs
and live session next. Existing names cause preflight to stop before any create.

For a small ad hoc batch, background separate shell subshells and wait for each
PID, capturing its exit status. Redirect stdin and stdout so `bh run` has no
terminal. Two foreground `bh run` lines in a terminal are not a parallel launch.

## Verify what is actually happening

Distinguish these states: VM created, SSH working, agent session launched,
model executing, task completed, and preview reachable. Prove the state needed
for the user's request; a detached command returning zero proves only launch.

```bash
bh status work
bh run work tmux list-sessions
bh run work tmux capture-pane -p -t boxhaven -S -100
bh run work bash -lc 'git status --short; ls -la'
```

- Read the actual session output for model/auth errors, approval prompts,
  missing dependencies, progress, and final results. A tmux session existing
  does not establish that the model is working.
- For version diagnosis, avoid classifying a version check as a managed agent:
  `bh run work env BOXHAVEN_NO_FULL_AUTO=1 codex --version` (or `claude`).
  Preserve the requested model if it is unsupported; report the version/error
  instead of silently substituting one. New golden images apply to new boxes.
- Forwarded configuration can contain local-only MCP executable paths. Identify
  the failing server and whether it is required. Do not reset authentication or
  erase the user's whole configuration to suppress an optional MCP warning.
- `creating` means wait for the create request. For a failed/uncertain create,
  inspect `bh list`, `bh status`, and the create log before retrying. A recovery
  record requires explicit destroy/recreate of that task's box; do not infer
  that an error left no VM.

If the request is to launch background work, verify that each requested agent
is working and hand back names, links, and reattach commands with a clear
in-progress status. If the request is to finish the builds, continue through
their actual checks and results.

## Public web previews

`bh status work` prints `preview_url`; the console's **Public preview** link and
the drawer's **Open preview** button open it. Do not invent a hostname or use
the VM IP as the share link. Some self-hosted backends have no preview domain.

Inside the box, commands receive `BOXHAVEN_PREVIEW_URL`,
`BOXHAVEN_PREVIEW_HOSTNAME`, `BOXHAVEN_WEB_BIND` (normally `0.0.0.0`), and
`BOXHAVEN_WEB_PORT` (normally `80`). `/run/boxhaven/context.json` contains the
same preview context. Public TLS terminates at the control plane; serve HTTP
on that bind address and port, or proxy from that port to the app's dev server.
The default user has sudo for port 80.

Keep the website in a separate named tmux session, such as `web`, so exiting
the agent or SSH command does not stop it. Serve the intended public/build
directory, never the entire checkout with `.git`, credentials, or task logs.
Verify HTTP content and important interactions at the public URL in a browser.
A provisioned preview URL or a 200 response alone does not prove the requested
app works. Preserve an existing server unless the task calls for replacing it.

## Retrieve and hand off

The remote copy owns its changes after creation. `bh run` does not sync files.
`bh sync up work` (or `bh run work --sync ...`) explicitly mirrors local files
and deletions; do not use it casually after a remote agent starts editing.

From the matching isolated local directory, retrieve work with
`bh sync down work --force`. This overwrites local files. Inspect the diff and
run appropriate checks before calling the work verified. Keep results from
different boxes in different directories or branches.

For direct tools, `bh ssh-config install` enables `ssh bh-work`, `scp`, and
rsync using short-lived certificates and pinned host keys. Do not replace that
with blanket host-key bypasses or copy cloud SSH keys around.

Report each box's task, current state, verified preview (when relevant), local
artifact location, and `bh connect NAME`. Leave demos running when requested.
When cleanup is in scope, destroy only the task's recorded boxes using
`bh destroy NAME --force`, then verify their absence in `bh list`.

More commands: [CLI reference](https://docs.boxhaven.dev/commands).
