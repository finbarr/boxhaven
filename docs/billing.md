# Billing

On the hosted `app.boxhaven.dev`, billing attaches to teams, never to user
accounts. Every box belongs to a [team](/teams), and a team's subscription
covers every box in it, whichever member created the box.

## The Model

- **Every team uses the same allowance.** By default, each team can run one box
  with no subscription. A team owner or admin subscribes once for the whole
  team when it needs more.
- **Usage is metered per box-hour.** Boxes beyond a team's free allowance
  are billed per started hour through a Stripe subscription with a metered
  price. Destroy a box and the metering stops with it.

When a team is at its allowance without an active subscription, creating a
box fails with `payment_required` and points at the console's Billing view,
where owners and admins can subscribe (Stripe Checkout) and manage the
subscription afterwards (Stripe customer portal). Members can see a team's
billing status but cannot manage it.

## Operator Configuration

Billing is off until `STRIPE_SECRET_KEY` is set on the backend. Self-hosted
deployments normally leave it unset, which disables every billing gate and
keeps box creation free; provider costs are the only costs.

| Variable | Meaning |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe API key; setting it enables billing. |
| `STRIPE_PRICE_ID` | Metered price used for team checkout subscriptions. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `POST /v1/billing/webhook` deliveries. |
| `STRIPE_METER_EVENT_NAME` | Billing Meter event name, default `boxhaven_box_hours`. |
| `BOXHAVEN_FREE_MACHINES` | Free boxes per team, default `1`. |
| `BOXHAVEN_BILLING_USAGE_REPORTER` | Set to `off` to stop this backend from reporting meter events. |

The webhook endpoint is `https://<api-host>/v1/billing/webhook` and needs the
`checkout.session.completed`, `customer.subscription.updated`, and
`customer.subscription.deleted` events. Each subscribed team gets its own
Stripe customer, and the backend reports one meter event unit per box beyond
the team's allowance per started hour, persisting the last reported hour per
team so restarts never double-bill.

`BOXHAVEN_MAX_MACHINES_PER_USER` remains an independent hard per-user cap on
top of any billing state.

See the [backend README](https://github.com/finbarr/boxhaven/blob/master/backend/README.md)
for the full `/v1/billing` API surface.
