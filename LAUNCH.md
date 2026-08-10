# Public Paid Launch Gates

This document tracks the remaining work required before opening hosted BoxHaven
at `app.boxhaven.dev` to unrestricted public signups. A gate is complete only
when its production behavior has been verified. Code, CI, health endpoints, or
configured credentials alone are not sufficient evidence.

Last audited: 2026-07-31.

## Verified production state

- [x] The public application and private hosted services are deployed from the
  intended commits, and CI is green in both repositories.
- [x] `boxhaven.dev`, `app.boxhaven.dev`, `api.boxhaven.dev`,
  `account.boxhaven.dev`, `admin.boxhaven.dev`, and `docs.boxhaven.dev` resolve
  and their HTTPS health checks pass where applicable.
- [x] GitHub OAuth, Resend transactional email, live Stripe Checkout, the live
  Stripe webhook, the native account page, and the admin console are enabled.
- [x] Production uses a restricted live Stripe key rather than an unrestricted
  secret key.
- [x] DigitalOcean backups are enabled. The daily application archive includes
  public backend state, shared authentication, hosted billing and admin state,
  Caddy state, and the SSH CA keypair.
- [x] DigitalOcean allows 100 droplets, leaving adequate initial quota
  headroom.
- [x] A new production box was created from the active image and passed project
  sync, plain SSH, SCP, HTTPS preview, a real GitHub push and branch deletion,
  and an actual `gpt-5.6-sol` Codex invocation. The disposable box and team were
  destroyed afterward.
- [x] The Terms of Service and Privacy Policy are live, linked during signup,
  and explicitly accepted for hosted accounts.

## 1. Control trial and infrastructure abuse

This is the first launch gate. The hosted policy currently grants a $5 included
credit to every new team. A user can create additional teams to obtain additional
credit. Email verification is disabled, and the production value of
`BOXHAVEN_MAX_MACHINES_PER_USER` is unset.

- [ ] Grant included usage once per verified user or other durable billing
  identity, not once per newly created team.
- [ ] Require a payment method before the first hosted machine is provisioned.
  Included credit should still be consumed before metered charges begin.
- [ ] Require email verification for password signups. GitHub sign-in may rely
  on GitHub's verified email assertion.
- [ ] Set `BOXHAVEN_MAX_MACHINES_PER_USER=5` in production for the initial
  launch. Raise it after observing real usage and cost.
- [ ] Verify that creating more teams cannot obtain more included usage and
  that the machine cap applies across all of a user's teams.

## 2. Make deletion billing-safe

The console currently sends Better Auth's organization-delete request directly.
It does not first prove that the team has no active machines or subscription.
Deleting such a team can orphan provider resources or recurring billing.

- [ ] Reject team deletion while the team owns any active machine.
- [ ] Reject or coordinate team deletion while the team has an active or
  recoverable Stripe subscription.
- [ ] Define one deletion workflow that destroys machines, cancels billing,
  records the administrative action, and only then removes team data.
- [ ] Keep account deletion as a verified support request for launch, and
  document the procedure and retention behavior for the operator.
- [ ] Exercise the complete deletion workflow against a disposable production
  account, subscription, team, and machine.

## 3. Publish pricing and payment policy

The live marketing site has no pricing page. The account page shows prices but
does not yet publish the markup formula, trial expiry, or card requirements.

- [ ] Publish the launch price before signup and beside the account action.
  The built-in DigitalOcean sizes start at `$0.10`, `$0.20`, and `$0.40` per
  hour; custom plans use the same hosted pricing formula.
- [ ] State that usage is measured in started machine-minutes and that the $5
  included credit expires after 14 days.
- [ ] State when a card is required, when metered charges begin, how to cancel,
  and what happens to machines after cancellation.
- [ ] Change the `past_due` policy to block new machine creation immediately.
  Define a short operator-managed grace period for existing machines so unpaid
  infrastructure cannot run indefinitely.
- [ ] Verify the published wording against a real live Checkout Session and
  Customer Portal session.

## 4. Publish the current CLI

The latest GitHub release and Homebrew formula are still `v0.1.0`, while the
deployed product and `master` contain substantial newer CLI behavior.

- [ ] Finish the launch-blocking changes above and write a versioned changelog
  section.
- [ ] Tag the next release, expected to be `v0.2.0`, and verify that GitHub
  publishes all four platform archives plus `SHA256SUMS`.
- [ ] Update `finbarr/homebrew-tap` using the procedure in
  [packaging/homebrew/README.md](packaging/homebrew/README.md).
- [ ] On a clean machine, test both `install.sh` and Homebrew, then run login,
  create, agent start, disconnect, SSH/SCP, reconnect, and destroy.

## 5. Add detection and prove recovery

DigitalOcean machine backups and complete daily application archives are an
acceptable initial backup baseline. They are not proven recoverable until a
restore succeeds. DigitalOcean currently has no monitoring alert policies.

- [ ] Add external uptime checks for `api.boxhaven.dev`, `app.boxhaven.dev`,
  and `account.boxhaven.dev`.
- [ ] Add DigitalOcean CPU and disk alerts for the production control-plane
  droplet and route them to an inbox that is actively monitored.
- [ ] Restore the latest production archive into a disposable host. Verify
  database integrity, user login, hosted account state, and SSH certificate
  issuance before destroying it.
- [ ] Record the restore command and expected validation output in the operator
  documentation.
- [ ] After launch, copy application archives to storage outside the production
  droplet. Storage outside the DigitalOcean account is preferred but is not a
  blocker for the initial limited beta.

## 6. Complete owner-operated launch checks

These checks require access to business, payment, email, or legal accounts and
cannot be established by repository tests.

- [ ] In Stripe, confirm that the Default Alive LLC account and payouts are
  fully activated and that the bank account, statement descriptor, customer
  support details, and failed-payment notifications are correct.
- [ ] Confirm that Customer Portal permits payment-method updates and
  cancellation as described by the Terms.
- [ ] Decide the sales-tax approach with an accountant. Stripe automatic tax is
  currently disabled; configure the business address, product tax code,
  registrations, and Checkout behavior before collecting tax.
- [ ] Send test messages to `support@boxhaven.dev`, `legal@boxhaven.dev`, and
  `security@boxhaven.dev` and confirm they arrive in the monitored inbox.
- [ ] Add `support@boxhaven.dev` to the docs and console footer.
- [ ] Have counsel review the Terms, Privacy Policy, arbitration language, and
  support-based deletion procedure before a broad paid announcement.
- [ ] Confirm Default Alive LLC's initial Statement of Information, tax
  calendar, business bank account, and bookkeeping are in place.

## Final launch proof

Run this only after every gate above is complete.

- [ ] Run all public and private CI suites from clean worktrees.
- [ ] Run the canonical combined production deployment. Do not deploy the
  public Compose stack by itself because that can orphan the private hosted
  services.
- [ ] Verify the deployed immutable commits, live Stripe price and webhook,
  account and admin authentication boundaries, backup timer, and monitoring.
- [ ] Create a new paid production account through the public UI, provision a
  box, run the reusable production smoke, inspect metered usage, cancel through
  Customer Portal, and complete the deletion workflow.
- [ ] Confirm the box, provider resources, Stripe objects, temporary Git branch,
  account, and test team are cleaned up.

## Explicitly deferred

These are useful follow-ups but must not delay the initial launch:

- Warm pools. Current production provisioning is under one minute; collect
  real latency and abandonment data before adding idle infrastructure.
- Persistent home-directory synchronization between boxes.
- Additional machine sizes beyond small, medium, and large.
- Sentry, a public status page, product analytics, distro packages, and more
  granular roles beyond owner, admin, and member.
