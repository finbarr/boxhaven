---
title: Documentation
description: Install BoxHaven, run remote boxes, manage teams and images, and self-host the backend.
---

# BoxHaven Documentation

BoxHaven runs remote development boxes for AI coding agents. Use these docs to
install the CLI, connect to a hosted or self-hosted backend, create boxes, run
agents inside persistent sessions, and operate the backend.

## Start here

- [Getting started](/getting-started): install `bh`, log in, create a box, run an agent, disconnect, and reattach.
- [CLI reference](/commands): every command and flag for boxes, sync, teams, images, auth, and config.
- [Self-hosting](/self-hosting): run the Fastify/Better Auth control plane with your own provider credentials.

## Operate boxes

- [Teams](/teams): team-owned boxes, roles, invitations, and moving boxes between teams.
- [Golden images](/images): create, snapshot, activate, and remove VM runtime images.
- [Cloud providers](/providers): configure DigitalOcean and Hetzner Cloud provider settings.

## Security and operation

- [Security model](/security): short-lived SSH certificates, the backend user CA, and forwarded credentials.
- [External policy service](/operator-policy): optional create policy and account capability integration for operators.

## Source and license

BoxHaven is open source under the GNU Affero General Public License v3.0 only
(`AGPL-3.0-only`). The source code, copyright notice, and full license text
live in the [BoxHaven GitHub repository](https://github.com/finbarr/boxhaven).
