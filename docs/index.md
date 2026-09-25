---
title: Documentation
description: Install the BoxHaven skill and ask your coding agent to run work in parallel on separate remote VMs.
---

# BoxHaven Documentation

Run coding agents in parallel on separate Linux VMs, each with its own project
copy and compute. Install the BoxHaven skill so your local agent can create
boxes, check progress, and bring back the results. Sessions keep running after
you disconnect.

## Start with the agent skill

With Node.js 22.20 or later:

```bash
npx skills add finbarr/boxhaven \
  --skill boxhaven -g \
  -a codex claude-code
```

Complete the [one-time CLI installation and login](/getting-started#install-the-cli),
then invoke `$boxhaven` in Codex or `/boxhaven` in Claude.

**Work in parallel**

> Use BoxHaven to run a code review and a test coverage audit on two separate
> VMs in parallel. Check both agents' progress and bring back their findings.

**Keep working while you're away**

> Use BoxHaven to continue this task on a remote VM so I can close my laptop.
> Check that the agent is working and give me the command to reconnect.

- [Agent skill](/agent-skill): installation, updates, version pins, and parallel tasks.
- [Getting started](/getting-started): skill setup and the manual CLI workflow from create to reconnect.
- [CLI reference](/commands): every command and flag for boxes, SSH, sync, teams, images, auth, and config.
- [Self-hosting](/self-hosting): run the control plane with your own provider credentials.

## Operate boxes

- [Teams](/teams): team-owned boxes, roles, invitations, and moving boxes between teams.
- [Golden images](/images): save, select, and remove team VM images by name.
- [Cloud providers](/providers): configure DigitalOcean and Hetzner Cloud provider settings.

## Security and operation

- [Security model](/security): short-lived SSH certificates, the backend user CA, and forwarded credentials.
- [External policy service](/operator-policy): optional create policy and native account-page integration for operators.

## Documentation for agents

[`llms.txt`](https://docs.boxhaven.dev/llms.txt) lists the documentation pages
and their Markdown URLs. For example,
[`commands.md`](https://docs.boxhaven.dev/commands.md) is the source of the CLI
reference. The website and these exports are built from the same files.

## Source and license

BoxHaven is open source under the GNU Affero General Public License v3.0 only
(`AGPL-3.0-only`). The source code, copyright notice, and full license text
live in the [BoxHaven GitHub repository](https://github.com/finbarr/boxhaven).
