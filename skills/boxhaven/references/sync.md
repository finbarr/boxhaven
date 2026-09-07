# Project sync and .boxhavenignore

Read this before the first project upload, when excluding files, or when moving
work between a laptop and a box. The remote project is `/opt/boxhaven/project`.

## Choose what leaves the laptop

`bh create NAME` uploads the current project, including `.git` metadata.
BoxHaven does not read `.gitignore` as a sync filter. Check for local data and
credentials before creation; being untracked or Git-ignored does not exclude
a file from upload.

Put `.boxhavenignore` at the local project root. It adds one **rsync exclude
pattern** per line to the built-in exclusions. Blank lines and lines starting
with `#` are ignored. This is not Git's ignore language: `!` does not re-include
a file, and this file cannot undo a built-in exclusion.

For example, if these files are not required by the remote task:

```text
# Local credentials; keep .env.example available to the agent.
.env
.env.local

# A root-level private dataset and generated output.
/private-data/
/dist/
*.log
```

A leading `/` anchors a pattern to the project root; a trailing `/` matches
directories. A pattern without `/`, such as `.env`, matches that name at any
depth. Preserve existing patterns when editing the file. Excluding a required
fixture or configuration file can prevent the app from running on the box.

Dependency and cache directories such as `node_modules/`, `.next/`, `.nuxt/`,
`.svelte-kit/`, `.vite/`, `.turbo/`, `.cache/`, `.parcel-cache/`, Python tool
caches, `__pycache__/`, `.venv/`, `venv/`, `.tox/`, and `coverage/` are excluded
by default. Install project dependencies on the box so native packages match
its Linux environment.

## Sync direction and deletion

| Operation | Result |
| --- | --- |
| `bh create work` | Creates a box and syncs the current local project once. |
| `bh run work ...` | Runs a command without syncing the project. |
| `bh sync up work` | Mirrors local files and deletions to the box. |
| `bh run work --sync ...` | Syncs up before running the command. |
| `bh sync down work --force` | Mirrors the box's project back into the current local project, overwriting files and mirroring deletions. |

Both directions use the **local** project directory's `.boxhavenignore` plus
the built-in exclusions. Excluded paths are left untouched on the receiving
side even when other deletions are mirrored. Adding an exclusion does not
remove a copy that was already uploaded.

Once a remote agent is editing, its project copy contains the work. Syncing
up an older local checkout can overwrite or delete those changes. Inspect
both sides before syncing; use a separate local task directory or checkout
for each box. Pull into the matching directory and review the diff and run
the project's checks before reporting completion.

Sync prints elapsed time, network bytes, changed bytes, and file counts. It is
an explicit transfer, not a continuous background sync service.

For the current CLI contract, consult [bh sync](https://docs.boxhaven.dev/commands#bh-sync)
or fetch the [Markdown command reference](https://docs.boxhaven.dev/commands.md).
