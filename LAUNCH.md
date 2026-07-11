# Public Launch Checklist

Working checklist for taking the hosted BoxHaven at `app.boxhaven.dev` to a
public, paid launch. Items marked **(you)** need Finbarr; everything else is
done or scripted.

## Done

- [x] Multi-provider backend (DigitalOcean live; Hetzner ready behind
  `HCLOUD_TOKEN`), teams with shareable invites, admin-managed golden images.
- [x] Team-centric box ownership with membership-validated sessions.
- [x] Per-user box cap (`BOXHAVEN_MAX_MACHINES_PER_USER`) as the hard abuse
  stop; auth rate limiting via Better Auth production defaults.
- [x] CI (test/lint/build), tag-triggered release workflow with checksums,
  `SECURITY.md`, credential-free local smoke, production lifecycle smoke that
  executes the agents (not just `command -v`).
- [x] Golden image verified end to end: claude and codex run as the box user,
  codex pre-trusts the project path, incremental rebuilds actually rebuild.
- [x] Daily state backups on the droplet (systemd timer, verified armed).
- [x] Installer script, Homebrew tap formula, VitePress docs site, and
  transactional email plumbing — all landed in this release; see sections
  below for the pieces only you can finish.

## Needs you: accounts and keys

- [x] **Resend**: `mail.boxhaven.dev` verified; production sends from
  `BoxHaven <hello@mail.boxhaven.dev>` (password reset and invitation emails
  deliver to all users).
- [x] **DNS**: `docs.boxhaven.dev` live with enforced HTTPS.
- [ ] **(you) GitHub sign-in**: create a GitHub OAuth App (Settings →
  Developer settings → OAuth Apps) with homepage `https://app.boxhaven.dev`
  and callback URL `https://api.boxhaven.dev/v1/auth/callback/github`, then
  set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in
  `deploy/digitalocean/.env.production` and redeploy. The "Continue with
  GitHub" button appears automatically once they are set; accounts with a
  matching verified email link to the existing account.

## Needs you: launch decisions

- [x] **Terms of Service + Privacy Policy.** Live at
  `https://boxhaven.dev/terms/` and `https://boxhaven.dev/privacy/`; linked
  from the marketing site and hosted console, with explicit acceptance on
  account creation. Have counsel review before a broad paid launch.
- [ ] **(you) Support channel.** `support@boxhaven.dev` forwarding to your
  inbox, mentioned in docs and the console footer.

## Strongly recommended before announcing

- [ ] Offsite backups: the daily archives live on the droplet itself. Ship
  them to DO Spaces or any S3 bucket (one `s3cmd put` line in
  `deploy/digitalocean/backup-backend.sh`); a dead droplet must not take the
  backups with it. Run one restore drill.
- [ ] Uptime monitoring on `https://api.boxhaven.dev/healthz` and
  `https://app.boxhaven.dev/healthz` (UptimeRobot/healthchecks.io — five
  minutes to set up) plus DigitalOcean droplet alerts (CPU/disk).
- [ ] Account deletion path: Better Auth supports `deleteUser`; v1 can be a
  documented support-email flow, but decide before collecting payments.
- [ ] Provider quota headroom: confirm the DO account's droplet limit is
  comfortably above expected box count; same for Hetzner if enabled.
- [ ] Turn on email verification for new signups once Resend is configured
  (`requireEmailVerification` in `backend/src/auth.ts`) — also unblocks
  upgrading better-auth past 1.6.x (see the pin note in backend/README.md).
- [ ] Cut `v0.1.0` (`git tag v0.1.0 && git push --tags`), confirm the release
  workflow publishes binaries, and fill the Homebrew formula checksums
  (`packaging/homebrew/README.md` has the procedure).

## Nice to have, not blocking

- [ ] Error tracking (Sentry) in the backend.
- [ ] Status page.
- [ ] Analytics on the docs/landing (Plausible or similar).
- [ ] Per-team access controls beyond owner/admin/member roles.
- [ ] `apt`/distro packages — the install script and brew cover launch.
