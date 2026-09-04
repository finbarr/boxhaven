# BoxHaven Agent Skill

Give Codex or Claude the workflows for creating boxes, launching persistent
agents in parallel, checking progress, opening previews, and bringing the
results home. The skill and its launcher live in the public
[BoxHaven repository](https://github.com/finbarr/boxhaven/tree/master/skills/boxhaven).
They use the `bh` CLI and your existing login.

## Install

Clone the repository and copy the skill into your agent's personal skill folder:

```bash
git clone https://github.com/finbarr/boxhaven.git
cd boxhaven
```

For Codex:

```bash
mkdir -p ~/.agents/skills
test ! -e ~/.agents/skills/boxhaven &&
  cp -R skills/boxhaven ~/.agents/skills/boxhaven
```

For Claude Code:

```bash
mkdir -p ~/.claude/skills
test ! -e ~/.claude/skills/boxhaven &&
  cp -R skills/boxhaven ~/.claude/skills/boxhaven
```

These commands leave an existing installation untouched. To update, compare
your installed folder with `skills/boxhaven` after pulling the repository.
For project-scoped installation, use `.agents/skills` or `.claude/skills` inside
that project instead. See the official
[Codex skill locations](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)
and [Claude skill locations](https://code.claude.com/docs/en/skills#where-skills-live).

Open a new agent session after installing. Invoke **`$boxhaven`** in Codex or
**`/boxhaven`** in Claude, followed by your request. For example:

> Use BoxHaven to create three boxes for these three prototypes. Give each
> agent its own task directory, verify that it starts working, and return the
> preview URLs and reattach commands. Leave the boxes running for the demo.

The skill can also be selected automatically for relevant BoxHaven tasks.
It does not install `bh` or authenticate for you; use the
[getting-started guide](/getting-started) for those steps.

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

From the public BoxHaven checkout:

```bash
python3 skills/boxhaven/scripts/launch.py /path/to/demo/tasks.json --jobs 2
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
