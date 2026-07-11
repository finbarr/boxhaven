# External Policy Service

BoxHaven is fully functional without a commercial policy service. The default
self-hosted behavior allows all creates (subject to the ordinary operator-set
per-user cap) and shows no account or plan navigation in the console.

Operators can connect a separate HTTP service through these settings:

| Variable | Purpose |
| --- | --- |
| `BOXHAVEN_COMMERCIAL_POLICY_URL` | Base URL of the external service. |
| `BOXHAVEN_COMMERCIAL_POLICY_TOKEN` | Shared bearer credential sent only to that service. |
| `BOXHAVEN_COMMERCIAL_POLICY_TIMEOUT_MS` | Create-decision timeout, default `5000`. |
| `BOXHAVEN_ACCOUNT_LABEL` | Optional console label such as `Account` or `Plan`; empty hides the navigation. |

The URL and token must be set together. New box creates fail closed when a
configured service is unavailable or returns an invalid decision. Listing,
connecting, running, syncing, moving, and destroying existing boxes do not
depend on policy availability. Lifecycle fact delivery is best-effort.

## Version 1 Contract

Requests use JSON, `Authorization: Bearer <token>`, a `/contract/v1` path, and
`version: 1` in the body:

- `POST /contract/v1/entitlements/create` receives the team, actor, machine
  identity, and `small`, `medium`, or `large` tier; it returns
  `{version: 1, allowed: boolean, message?: string}`.
- `POST /contract/v1/events` receives idempotent `machine.created`,
  `machine.destroyed`, and `machine.moved` facts with an event ID and time.
- `POST /contract/v1/account-link` receives the current team and actor and
  returns `{version: 1, url}` when the generic account capability is enabled.

The public backend deliberately stores no provider-specific commercial state.
Use TLS, a long random token, and network controls between the two services.
