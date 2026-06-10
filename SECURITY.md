# Security Policy

## Reporting a Vulnerability

Report vulnerabilities privately through GitHub Security Advisories for this
repository: open the repository's Security tab and choose "Report a
vulnerability". Do not open public issues or pull requests for security
reports.

You should receive an initial response within 5 business days. Please include
reproduction steps, affected components (CLI, backend, deploy tooling, or VM
runtime), and any impact assessment you have.

## Scope

- The hosted control plane at `app.boxhaven.dev` / `api.boxhaven.dev`.
- Self-hosted releases of this repository: the `bh` CLI, the backend, the
  deploy bundle, and the remote VM runtime.

Issues in third-party cloud providers (DigitalOcean, Hetzner Cloud) or in
software you run inside your own boxes are out of scope; report those to the
relevant vendor. Only test against hosted infrastructure with accounts and
machines you own, and never against other users' boxes or data.
