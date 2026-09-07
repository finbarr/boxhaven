# BoxHaven Agent Skill

Install the BoxHaven skill on your development laptop to teach Codex or Claude
how to create boxes, run persistent agents, launch tasks in parallel, check
progress, open previews, and bring results home. It also explains project sync
and `.boxhavenignore`, and links to the current documentation when your agent
needs more detail. The skill and its launcher live in the public
[BoxHaven repository](https://github.com/finbarr/boxhaven/tree/master/skills/boxhaven).
They use the `bh` CLI and your existing login.

## Install

Use [Vercel's Skills CLI](https://github.com/vercel-labs/skills), the installer
behind [skills.sh](https://skills.sh/). Install Node.js 22.20 or later, then run:

```bash
npx skills add finbarr/boxhaven \
  --skill boxhaven -g \
  -a codex claude-code
```

`-g` makes the skill available across your projects. `-a` selects the agents;
use just `-a codex` or `-a claude-code` if you only use one. The installer puts
the skill, its references, and its launcher in the agents' skill folders and
records the source for future updates. With its default symlink installation,
the shared files live in `~/.agents/skills/boxhaven`; Claude's
`~/.claude/skills/boxhaven` points to that copy.

For a project installation shared with your team, omit `-g` and run the command
from that project's root. Commit the installed skill files, agent links, and
`skills-lock.json` with the project.

To see what will be installed without installing it:

```bash
npx skills add finbarr/boxhaven --list
```

Open a new agent session after installing if the skill is not yet visible.
Invoke **`$boxhaven`** in Codex or **`/boxhaven`** in Claude, followed by your
request. For example:

> Use BoxHaven to create three boxes for these three prototypes. Give each
> agent its own task directory, verify that it starts working, and return the
> preview URLs and reattach commands. Leave the boxes running for the demo.

The skill can also be selected automatically for relevant BoxHaven tasks.
It requires `bh` 0.2.0 or later and your existing BoxHaven login. It does not
install or upgrade `bh`, or authenticate for you; follow
[getting started](/getting-started) for those steps.

## Updates And Versions

Update a global installation with:

```bash
npx skills update boxhaven -g
```

For a project installation, run `npx skills update boxhaven -p` in that project.
Updates replace the installed skill files, so keep personal additions outside
the installed package. If you previously copied the skill manually, run the
installation command above to register its source with the installer.

The unpinned install follows the repository's default branch when you request
an update. Publishing a change does not automatically update your local copy.
The installer records the Git source/ref and a content hash; its project lock
file is `skills-lock.json`. The `metadata.version` in `SKILL.md` identifies the
instructions and `metadata.minimum-bh-version` identifies the required CLI.
The installer does not enforce that CLI requirement; the skill tells the agent
to check `bh version`.

To pin skill **1.0.0** to its Git tag:

```bash
npx skills add 'finbarr/boxhaven#boxhaven-skill-v1.0.0' \
  --skill boxhaven -g -a codex claude-code
```

Updates preserve that ref. To move to another version, install from its tag;
to follow the default branch again, rerun the unpinned installation command.
`npx skills@1.5.24` would pin the **installer**, not the BoxHaven skill.
In Skills CLI 1.5.24, `skills check` is an alias for `update`, not a read-only
check. Use `npx skills ls -g` to list installed skills.

Skill changes are reviewed alongside CLI and docs changes in the same
repository. Skill releases get `boxhaven-skill-v<version>` tags; future CLI
release tags also contain the skill. The older `v0.2.0` CLI tag predates the
skill and cannot be used to install it.

## Project Sync And Documentation

The installed [sync reference](https://github.com/finbarr/boxhaven/blob/master/skills/boxhaven/references/sync.md)
explains default exclusions, rsync patterns in `.boxhavenignore`, and how to
retrieve work without overwriting remote edits. `.gitignore` is not a BoxHaven
sync filter. See [bh sync](/commands#bh-sync) for the CLI contract.

The skill includes a map of the [CLI reference](/commands),
[security model](/security), [teams](/teams), and other docs, and tells the
agent when to fetch them. Agents can discover the pages through
[`llms.txt`](https://docs.boxhaven.dev/llms.txt) and fetch Markdown sources such
as [`commands.md`](https://docs.boxhaven.dev/commands.md). These exports are
generated from the same source as the website on every build.

## Inside A Remote Box

The laptop skill manages boxes through your local `bh` login. Separately,
the golden VM image installs a Codex skill named `boxhaven-web-preview` inside
the box. That skill explains the box's public preview URL, bind address, port,
and TLS setup. Its updates ship with rebuilt VM images, not the laptop skill
installer; an existing box keeps its installed runtime skill.

## Launch A Batch

Prepare separate project directories with clear `TASK.md` instructions. Put a
manifest outside those directories, for example:

```text
demo/
  tasks.json
  orchard/TASK.md
  observatory/TASK.md
```

`tasks.json`:

```json
[
  {
    "name": "demo-orchard",
    "directory": "./orchard",
    "agent": ["codex", "Read TASK.md and build the app. Verify it and keep its preview running."]
  },
  {
    "name": "demo-observatory",
    "directory": "./observatory",
    "agent": ["claude", "Read TASK.md and build the app. Verify it and keep its preview running."]
  }
]
```

With the default global installation:

```bash
python3 ~/.agents/skills/boxhaven/scripts/launch.py \
  /path/to/demo/tasks.json --jobs 2
```

The launcher requires Python 3 and `bh` on PATH; `--bh /path/to/bh` selects a
specific binary. Add `size`, `provider`, `region`, `image`, or `team` to each
manifest entry when needed. Otherwise the CLI's configured defaults apply.
The `agent` array accepts ordinary Codex or Claude arguments, including an
explicit model when you want one.

The launcher validates every entry and checks for existing names before
creating anything. It starts each agent as its VM becomes ready, writes stage
logs and `results.json` to the printed temporary directory, and leaves boxes
running. A failed job does not stop the others. It never automatically retries
or destroys a box. VM charges continue until you destroy it.

## Inspect And Reattach

```bash
bh list
bh status demo-orchard
bh run demo-orchard tmux capture-pane -p -t boxhaven -S -100
bh connect demo-orchard
# Ctrl-b, then d disconnects; the agent keeps running.
```

Read the session output before reporting that an agent is working. Open and
exercise its public preview before reporting that an app is ready. The
console provides a **Public preview** link in each box row and an **Open
preview** button in its details.

Retrieve the result from the matching local task directory:

```bash
cd /path/to/demo/orchard
bh sync down demo-orchard --force
```

This overwrites local files. Keep each box's result in its own directory.
When the demo is over, destroy only the boxes you created for it:

```bash
bh destroy demo-orchard
bh destroy demo-observatory
bh list
```
