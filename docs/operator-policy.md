# Backend Modules

BoxHaven can add private or deployment-specific behavior at build time through
the `BackendModule` interface exported by `@boxhaven/backend`. The standard
open-source entrypoint loads no modules and uses the in-process allow-all
commercial policy.

A module can contribute ordered SQLite migrations, authenticated API routes,
a `CommercialPolicy` implementation, and a provider-neutral
`TeamDeletionPolicy`. It receives the core database,
provider registry, state store, authentication helpers, and team authorization
helpers in process. This keeps provisioning, auth, SSH, and lifecycle behavior
in the open core while allowing a distribution to add its own models and UI.

## Database Ownership

Every module migration has a stable integer version. The backend applies core
and module migrations before listening and records them in the shared
`boxhaven_migrations` table. It refuses duplicate module names, missing
versions, migration downgrades, and changed migration history.

Use a prefix unique to the module for every private table and index. A module
must not modify tables owned by the core or another module. The backend process
is the sole owner of the SQLite connection and closes module runtimes before
closing core storage.

## Commercial Policy

A module can return a `CommercialPolicy` from `start()`. The policy can:

- authorize a create before provisioning;
- receive idempotent `machine.created`, `machine.destroyed`, and
  `machine.moved` lifecycle facts;
- reconcile against the authoritative active-machine set;
- request provider-neutral destruction of machines whose entitlement has
  ended;
- provide an account summary and account action to its own routes or UI.

The complete lifecycle event is written to the shared SQLite database in the
same transaction as the machine mutation. Delivery happens asynchronously;
failures remain in the durable outbox and retry after restarts. Stable event
IDs make duplicate delivery safe.

Reconciliation may return `machine.destroy` actions keyed by authoritative
team ID and stable policy machine ID. Core persists each accepted request
before contacting the machine's provider. Provider deletion is retried across
reconciliation runs and process restarts, and a failure for one machine or
provider does not stop other pending cleanups. Core removes the machine and
emits its final `machine.destroyed` fact only after the provider confirms the
resource is absent. Duplicate actions and concurrent policy runs converge on
the same pending cleanup.

Once cleanup is pending, a machine cannot be renamed or moved to another team.
A concurrent user-requested destroy may complete the same cleanup; the state
transaction emits only one destroyed fact. Policies should return actions in a
deterministic order and continue returning them while the corresponding
machine remains in reconciliation. Core also retains accepted requests, so a
restart does not depend on the policy returning the action again.

If a policy throws or returns an invalid create decision, BoxHaven returns
`503 entitlement_unavailable` and does not provision the box. An explicit
denial returns `403 entitlement_denied`. Listing, connecting, running, syncing,
moving, and destroying existing boxes do not wait for policy delivery.

The generic policy timing settings also control cleanup retries and fresh
entitlement evaluation: `BOXHAVEN_COMMERCIAL_POLICY_RETRY_MS` defaults to 30
seconds and `BOXHAVEN_COMMERCIAL_POLICY_RECONCILE_INTERVAL_MS` defaults to five
minutes. A module can call `requestPolicyReconciliation()` after an external
entitlement event to request an immediate serialized run.

## Deletion Policy

A module can return `teamDeletionPolicy.checkTeamDeletion`. The input contains
only the team and requesting actor; the decision is an allow flag and optional
actionable message. The core has no knowledge of why a module blocks deletion.

Team deletion always fails closed while a core box or provisioning reservation
exists. Each process-owned provisioning reservation is paired atomically with a
durable machine record. After a restart, core clears the stale reservation and
marks that record as requiring recovery; the record continues to block team and
account deletion until the box is explicitly destroyed. Recovery records are
not provider-confirmed lifecycle facts and are excluded from commercial-policy
reconciliation, so a crash cannot activate billing by itself.
Provider discovery can fill in VM identity and address details for cleanup, but
it never promotes a recovery record into a usable or billable machine. The box
must be destroyed and created again. A provider may classify an error as
definitively not created; only then does core remove the placeholder
automatically. Unknown outcomes keep the recovery record.

Modules whose external state can change concurrently also maintain a row in the
generic `core_team_deletion_policy_blockers` table in the same transaction as
that state. The core checks those rows before deletion and a SQLite trigger
checks them again inside Better Auth's organization-delete transaction. This
prevents a late external-state transition from racing a successful delete. Do
not put provider-specific credentials or payloads in the blocker row; its
message is user-facing and retained only until the blocker is cleared.

## Building A Distribution

Import `startBackendFromEnv` and pass modules explicitly from a distribution's
entrypoint:

```ts
import { startBackendFromEnv } from "@boxhaven/backend";
import { hostedModule } from "./hosted-module.js";

await startBackendFromEnv({ modules: [hostedModule] });
```

The standard `@boxhaven/backend` entrypoint always starts with zero modules.
There is no environment variable that enables private functionality in the
open-source image.
