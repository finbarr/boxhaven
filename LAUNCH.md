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
- [x] Installer script, Homebrew tap formula, VitePress docs site, Stripe
  billing (per team: personal teams get 1 free box, shared teams are
  subscription-first, usage-billed beyond the allowance), transactional
  email plumbing — all landed in this release; see sections below for the
  pieces only you can finish.

## Needs you: accounts and keys

- [ ] **(you) Stripe**: billing is per team — each subscribed team gets its
  own Stripe customer, personal teams include `BOXHAVEN_FREE_MACHINES` free
  boxes (default 1), and shared teams are subscription-first
  (`BOXHAVEN_TEAM_FREE_MACHINES`, default 0). Create the products in the
  Stripe dashboard —
  1. Billing → Meters → create meter with event name `boxhaven_box_hours`.
  2. A usage-based price on that meter (pick the $/box-hour number) →
     `STRIPE_PRICE_ID`.
  3. Developers → Webhooks → endpoint `https://api.boxhaven.dev/v1/billing/webhook`
     with events `checkout.session.completed`,
     `customer.subscription.updated`, `customer.subscription.deleted` →
     `STRIPE_WEBHOOK_SECRET`.
  4. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` in
     `deploy/digitalocean/.env.production` and redeploy. Billing stays
     entirely off (and self-host unaffected) until the key is set.
- [ ] **(you) Resend** (or any provider; the client is a 40-line raw HTTP
  call): verify the `boxhaven.dev` sending domain, then set `RESEND_API_KEY`
  and `BOXHAVEN_EMAIL_FROM="BoxHaven <hello@boxhaven.dev>"`. Enables password
  reset and invitation emails; invite links keep working without it.
- [ ] **(you) DNS**: add `docs` CNAME → `finbarr.github.io` so the docs site
  serves at `https://docs.boxhaven.dev` (GitHub Pages is already configured
  with the CNAME file and workflow).

## Needs you: legal and money decisions

- [ ] **(you) Terms of Service + Privacy Policy.** Required before charging
  cards and storing user code on your infrastructure. Use a generator or
  lawyer; host as static pages (the console can serve `/terms` and
  `/privacy` — add them to `backend/app` when the text exists) and link them
  from the sign-up panel and Stripe checkout settings.
- [ ] **(you) Pricing number.** The meter bills per box-hour beyond the free
  box. Reference point: an `s-2vcpu-4gb` droplet costs ~$0.036/hr; price
  above that with margin (e.g. $0.06–0.10/box-hour) or round to a friendly
  monthly-equivalent.
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
