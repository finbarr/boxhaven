import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommercialPolicy, MachineLifecycleEvent } from "./policy.js";
import { PolicyEventDelivery, reconciliationSnapshot } from "./policy_delivery.js";
import { StateStore } from "./state.js";

const event: MachineLifecycleEvent = {
  version: 1,
  id: "event-stable-1",
  occurred_at: "2026-07-11T00:00:00.000Z",
  type: "machine.created",
  team: { id: "team-1", name: "Team One", slug: "team-one" },
  actor: { id: "user-1", email: "user@example.com" },
  machine: {
    id: "provider:machine-1",
    name: "box",
    size: "medium",
    provider: "fake",
    provider_plan: "medium",
    provider_hourly_price: 0.1,
  },
};

test("machine state and its policy event survive restart in one state commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-state-"));
  const path = join(dir, "boxhaven.sqlite");
  const store = new StateStore(path, "fake");
  await store.putMachine({ name: "box", user_id: "user-1", provider: "fake" }, event);

  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM core_machines").get() as { count: number }).count, 1);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM core_policy_events").get() as { count: number }).count, 1);
  store.close();

  const restarted = new StateStore(path, "fake");
  assert.equal((await restarted.getMachine("user-1", "box"))?.name, "box");
  assert.deepEqual(await restarted.listPolicyEvents(), [event]);

  const destroyed = { ...event, id: "event-stable-2", type: "machine.destroyed" as const };
  await restarted.deleteMachine("user-1", "box", destroyed);
  assert.equal(await restarted.getMachine("user-1", "box"), undefined);
  assert.deepEqual((await restarted.listPolicyEvents()).find((queued) => queued.id === destroyed.id), {
    ...destroyed,
    occurred_at: "2026-07-11T00:00:00.001Z",
  });
});

test("failed delivery remains queued and is retried after process restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-restart-"));
  const path = join(dir, "boxhaven.sqlite");
  const store = new StateStore(path, "fake");
  await store.putMachine({ name: "box", user_id: "user-1", provider: "fake" }, event);

  const persistedBody = (await store.listPolicyEvents())[0];
  const failedBodies: MachineLifecycleEvent[] = [];
  const failing = deliveryPolicy(async (delivered) => {
    failedBodies.push(structuredClone(delivered));
    throw new Error("offline");
  });
  const firstProcess = new PolicyEventDelivery(store, failing, 5);
  firstProcess.start();
  await waitFor(() => failedBodies.length > 0);
  firstProcess.stop();
  assert.deepEqual((await store.listPolicyEvents()).map((queued) => queued.id), [event.id]);

  const deliveredBodies: MachineLifecycleEvent[] = [];
  const restartedStore = new StateStore(path, "fake");
  const secondProcess = new PolicyEventDelivery(restartedStore, deliveryPolicy(async (delivered) => {
    deliveredBodies.push(structuredClone(delivered));
  }), 5);
  secondProcess.start();
  await waitFor(() => deliveredBodies.length > 0);
  await waitFor(async () => (await restartedStore.listPolicyEvents()).length === 0);
  secondProcess.stop();
  assert.deepEqual(deliveredBodies, [persistedBody]);
  for (const body of failedBodies) assert.deepEqual(body, persistedBody);
});

test("a dequeue persistence failure redelivers the same idempotent event ID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-idempotent-"));
  const path = join(dir, "boxhaven.sqlite");
  const store = new FlakyDeleteStateStore(path, "fake");
  await store.putMachine({ name: "box", user_id: "user-1", provider: "fake" }, event);
  const deliveredIDs: string[] = [];
  const delivery = new PolicyEventDelivery(store, deliveryPolicy(async (delivered) => {
    deliveredIDs.push(delivered.id);
  }), 5);
  delivery.start();
  await waitFor(async () => (await store.listPolicyEvents()).length === 0);
  delivery.stop();
  assert.deepEqual(deliveredIDs, [event.id, event.id]);
});

test("a failed outbox insert rolls back its machine mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-transaction-failure-"));
  const path = join(dir, "boxhaven.sqlite");
  const store = new StateStore(path, "fake");
  store.db.exec(`
    CREATE TRIGGER fail_policy_insert
    BEFORE INSERT ON core_policy_events
    BEGIN
      SELECT RAISE(ABORT, 'simulated policy insert failure');
    END;
  `);
  await assert.rejects(
    store.putMachine({ name: "first", user_id: "user-1", provider: "fake" }, event),
    /simulated policy insert failure/,
  );
  assert.equal(await store.getMachine("user-1", "first"), undefined);
  assert.deepEqual(await store.listPolicyEvents(), []);

  store.db.exec("DROP TRIGGER fail_policy_insert");
  const second = { ...event, id: "event-stable-second", machine: { ...event.machine, id: "provider:second", name: "second" } };
  await store.putMachine({ name: "second", user_id: "user-1", provider: "fake" }, second);
  store.close();

  const restarted = new StateStore(path, "fake");
  assert.equal(await restarted.getMachine("user-1", "first"), undefined);
  assert.equal((await restarted.getMachine("user-1", "second"))?.name, "second");
  assert.deepEqual((await restarted.listPolicyEvents()).map((queued) => queued.id), [second.id]);
});

test("concurrent state mutations are serialized without lost machines or outbox entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-concurrent-"));
  const path = join(dir, "boxhaven.sqlite");
  const store = new StateStore(path, "fake");
  await Promise.all(Array.from({ length: 20 }, (_, index) => {
    const queued = {
      ...event,
      id: `event-${index}`,
      machine: { ...event.machine, id: `provider:machine-${index}`, name: `box-${index}` },
    };
    return store.putMachine({ name: `box-${index}`, user_id: "user-1", provider: "fake" }, queued);
  }));
  assert.equal((await store.listMachines()).length, 20);
  assert.equal((await store.listPolicyEvents()).length, 20);
  const restarted = new StateStore(path, "fake");
  assert.equal((await restarted.listMachines()).length, 20);
  assert.equal((await restarted.listPolicyEvents()).length, 20);
});

test("persisted state is available to all SQLite readers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-load-"));
  const path = join(dir, "boxhaven.sqlite");
  const store = new StateStore(path, "fake");
  await store.putMachine({
    name: "box",
    user_id: "user-1",
    provider: "fake",
    provider_name: "stable-box",
  }, event);

  const [loaded, captured, queued] = await Promise.all([
    store.load(),
    store.captureMachineSnapshot(() => new Date("2026-07-11T00:10:00.000Z")),
    store.listPolicyEvents(),
  ]);

  assert.equal(Object.keys(loaded.machines).length, 1);
  assert.equal(captured.machines.length, 1);
  assert.equal(captured.machines[0].provider_name, "stable-box");
  assert.deepEqual(queued, [event]);
});

test("reconciliation uses lifecycle team and stable provider machine identity semantics", () => {
  assert.deepEqual(reconciliationSnapshot([{
    name: "renamed-box",
    user_id: "user-1",
    provider: "fake",
    provider_name: "stable-provider-name",
    size: "large",
    size_shortcut: "large",
    provider_hourly_price: 0.2,
    org_id: "team-1",
    org_name: "Team One",
    org_slug: "team-one",
  }], "2026-07-11T00:05:00.000Z"), {
    version: 1,
    generated_at: "2026-07-11T00:05:00.000Z",
    machines: [{
      team: { id: "team-1", name: "Team One", slug: "team-one" },
      machine: {
        id: "fake:stable-provider-name",
        name: "renamed-box",
        size: "large",
        provider: "fake",
        provider_plan: "large",
        provider_hourly_price: 0.2,
      },
    }],
  });
});

test("reconciliation capture is serialized with lifecycle state commits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-capture-"));
  const store = new StateStore(join(dir, "boxhaven.sqlite"), "fake");
  const beforeCreate = store.captureMachineSnapshot(() => new Date("2026-07-11T10:00:00.000Z"));
  const create = store.putMachine({
    name: "box",
    user_id: "user-1",
    provider: "fake",
    provider_name: "stable-box",
  }, { ...event, occurred_at: "2026-07-11T10:00:01.000Z" });
  assert.deepEqual(await beforeCreate, { generatedAt: "2026-07-11T10:00:00.000Z", machines: [] });
  await create;

  const afterCreate = await store.captureMachineSnapshot(() => new Date("2026-07-11T10:00:02.000Z"));
  assert.equal(afterCreate.generatedAt, "2026-07-11T10:00:02.000Z");
  assert.equal(afterCreate.machines.length, 1);
  assert.equal(afterCreate.machines[0].provider_name, "stable-box");
});

test("snapshot and lifecycle timestamps follow queue reservation order behind a slow write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-reservation-"));
  const path = join(dir, "boxhaven.sqlite");
  const store = new SlowFirstWriteStateStore(path, "fake");
  const slowUpdate = store.putImage({ name: "base", provider: "fake", org_id: "team-1" });
  await store.firstWriteStarted;

  const snapshot = store.captureMachineSnapshot(() => new Date("2026-07-11T10:00:02.000Z"));
  const create = store.putMachine({
    name: "box",
    user_id: "user-1",
    provider: "fake",
    provider_name: "stable-box",
  }, { ...event, occurred_at: "2026-07-11T10:00:01.000Z" });

  store.releaseFirstWrite();
  await slowUpdate;
  const captured = await snapshot;
  assert.deepEqual(captured, { generatedAt: "2026-07-11T10:00:02.000Z", machines: [] });
  await create;

  const restarted = new StateStore(path, "fake");
  const [persistedEvent] = await restarted.listPolicyEvents();
  assert.equal(persistedEvent.occurred_at, "2026-07-11T10:00:02.001Z");
  assert.ok(persistedEvent.occurred_at > captured.generatedAt);
  assert.equal((await restarted.getMachine("user-1", "box"))?.provider_name, "stable-box");
});

test("hosted reconciliation runs at startup, retries failures, and remains periodic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-reconcile-"));
  const store = new StateStore(join(dir, "boxhaven.sqlite"), "fake");
  await store.putMachine({
    name: "box",
    user_id: "user-1",
    provider: "fake",
    provider_name: "stable-box",
    size: "medium",
    size_shortcut: "medium",
    provider_hourly_price: 0.1,
    org_id: "team-1",
    org_name: "Team One",
  });
  const reconciliations: Array<{ version: number; machineIDs: string[] }> = [];
  let fail = true;
  const policy: CommercialPolicy = {
    lifecycleEventsEnabled: true,
    async checkCreate() { return { allowed: true }; },
    async emitMachineFact() {},
    async reconcile(input) {
      reconciliations.push({ version: input.version, machineIDs: input.machines.map((entry) => entry.machine.id) });
      if (fail) {
        fail = false;
        throw new Error("reconciliation offline");
      }
    },
  };
  const delivery = new PolicyEventDelivery(store, policy, 5, 10);
  delivery.start();
  await waitFor(() => reconciliations.length >= 3);
  delivery.stop();
  assert.deepEqual(reconciliations, [
    { version: 1, machineIDs: ["fake:stable-box"] },
    { version: 1, machineIDs: ["fake:stable-box"] },
    { version: 1, machineIDs: ["fake:stable-box"] },
  ]);
});

test("policy cleanup persists, retries provider failures, and completes other providers independently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-cleanup-"));
  const path = join(dir, "boxhaven.sqlite");
  const store = new StateStore(path, "fake-a");
  for (const [name, provider] of [["blocked", "fake-a"], ["healthy", "fake-b"]] as const) {
    await store.putMachine({
      name,
      user_id: "user-1",
      provider,
      provider_name: `${provider}-${name}`,
      provider_id: `${provider}-id`,
      org_id: "team-1",
      org_name: "Team One",
      size: "small",
      size_shortcut: "small",
      provider_hourly_price: 0.1,
      created_at: `2026-07-11T00:00:0${name === "blocked" ? "0" : "1"}.000Z`,
    });
  }
  let allowBlocked = false;
  const attempts: string[] = [];
  const facts: MachineLifecycleEvent[] = [];
  const policy: CommercialPolicy = {
    lifecycleEventsEnabled: true,
    async checkCreate() { return { allowed: true }; },
    async emitMachineFact(fact) { facts.push(fact); },
    async reconcile(input) {
      return {
        actions: input.machines.map((item) => ({
          type: "machine.destroy" as const,
          team_id: item.team.id,
          machine_id: item.machine.id,
          reason: "entitlement ended",
        })),
      };
    },
  };
  const delivery = new PolicyEventDelivery(store, policy, 10, 60_000, async (machine) => {
    attempts.push(`${machine.provider}:${machine.name}`);
    if (machine.name === "blocked" && !allowBlocked) throw new Error("fake-a unavailable");
  });
  delivery.start();
  await waitFor(async () => (await store.getMachine("user-1", "healthy")) === undefined);
  delivery.stop();

  assert.equal((await store.getMachine("user-1", "blocked"))?.provider, "fake-a");
  assert.deepEqual((await store.listMachineCleanups()).map((item) => item.machine_id), ["fake-a:fake-a-blocked"]);
  assert.ok(attempts.includes("fake-b:healthy"), "the healthy provider is cleaned up despite another provider failing");
  store.close();

  const restarted = new StateStore(path, "fake-a");
  allowBlocked = true;
  const restartedDelivery = new PolicyEventDelivery(restarted, policy, 10, 60_000, async (machine) => {
    attempts.push(`restart:${machine.provider}:${machine.name}`);
  });
  restartedDelivery.start();
  await waitFor(async () => (await restarted.listMachines()).length === 0);
  await waitFor(() => facts.length === 2);
  restartedDelivery.stop();

  assert.deepEqual(await restarted.listMachineCleanups(), []);
  assert.deepEqual(facts.map((item) => item.type), ["machine.destroyed", "machine.destroyed"]);
  assert.deepEqual(facts.map((item) => item.actor), [
    { id: "boxhaven-policy", email: "" },
    { id: "boxhaven-policy", email: "" },
  ]);
});

test("duplicate actions and concurrent reconciliation notifications cannot duplicate cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-cleanup-concurrent-"));
  const store = new StateStore(join(dir, "boxhaven.sqlite"), "fake");
  await store.putMachine({
    name: "one",
    user_id: "user-1",
    provider: "fake",
    provider_name: "stable-one",
    provider_id: "provider-one",
    org_id: "team-1",
    size: "small",
    provider_hourly_price: 0.1,
    created_at: "2026-07-11T00:00:00.000Z",
  });
  let reconciles = 0;
  let activeReconciles = 0;
  let maxActiveReconciles = 0;
  let releaseReconcile!: () => void;
  const firstReconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
  const facts: MachineLifecycleEvent[] = [];
  const policy: CommercialPolicy = {
    lifecycleEventsEnabled: true,
    async checkCreate() { return { allowed: true }; },
    async emitMachineFact(fact) { facts.push(fact); },
    async reconcile(input) {
      reconciles += 1;
      activeReconciles += 1;
      maxActiveReconciles = Math.max(maxActiveReconciles, activeReconciles);
      if (reconciles === 1) await firstReconcileGate;
      activeReconciles -= 1;
      const action = {
        type: "machine.destroy" as const,
        team_id: "team-1",
        machine_id: "fake:stable-one",
        reason: "entitlement ended",
      };
      return { actions: input.machines.length ? [action, action] : [] };
    },
  };
  let releases = 0;
  const delivery = new PolicyEventDelivery(store, policy, 10, 60_000, async () => { releases += 1; });
  delivery.start();
  await waitFor(() => activeReconciles === 1);
  delivery.notifyReconcile();
  delivery.notifyReconcile();
  releaseReconcile();
  await waitFor(async () => (await store.listMachines()).length === 0);
  await waitFor(() => reconciles >= 2);
  await waitFor(() => facts.length === 1);
  delivery.stop();

  assert.equal(maxActiveReconciles, 1);
  assert.equal(releases, 1);
  assert.equal(facts.filter((item) => item.type === "machine.destroyed").length, 1);
});

test("manual deletion wins a cleanup race without a duplicate destroyed fact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-cleanup-user-delete-"));
  const store = new StateStore(join(dir, "boxhaven.sqlite"), "fake");
  const machine = {
    name: "one",
    user_id: "user-1",
    provider: "fake",
    provider_name: "stable-one",
    org_id: "team-1",
    size: "small",
    provider_hourly_price: 0.1,
    created_at: "2026-07-11T00:00:00.000Z",
  };
  await store.putMachine(machine);
  await store.requestMachineCleanup({
    type: "machine.destroy",
    team_id: "team-1",
    machine_id: "fake:stable-one",
    reason: "entitlement ended",
  }, new Date("2026-07-11T01:00:00.000Z"));
  const userEvent: MachineLifecycleEvent = {
    ...event,
    id: "user-destroy",
    occurred_at: "2026-07-11T01:01:00.000Z",
    type: "machine.destroyed",
    machine: { ...event.machine, id: "fake:stable-one", name: "one" },
  };
  await store.deleteMachine("user-1", "one", userEvent);
  assert.equal(await store.completeMachineCleanup("fake:stable-one"), false);
  assert.deepEqual((await store.listPolicyEvents()).map((item) => item.id), ["user-destroy"]);
  assert.deepEqual(await store.listMachineCleanups(), []);
});

class FlakyDeleteStateStore extends StateStore {
  private fail = true;

  override async deletePolicyEvent(id: string): Promise<void> {
    if (this.fail) {
      this.fail = false;
      throw new Error("simulated crash before dequeue commit");
    }
    await super.deletePolicyEvent(id);
  }
}

class SlowFirstWriteStateStore extends StateStore {
  readonly firstWriteStarted: Promise<void>;
  private markFirstWriteStarted!: () => void;
  private resumeFirstWrite!: () => void;
  private firstWrite = true;
  private readonly firstWriteReleased: Promise<void>;

  constructor(path: string, provider: string) {
    super(path, provider);
    this.firstWriteStarted = new Promise((resolve) => { this.markFirstWriteStarted = resolve; });
    this.firstWriteReleased = new Promise((resolve) => { this.resumeFirstWrite = resolve; });
  }

  releaseFirstWrite(): void {
    this.resumeFirstWrite();
  }

  protected override async beforeMutation(): Promise<void> {
    if (this.firstWrite) {
      this.firstWrite = false;
      this.markFirstWriteStarted();
      await this.firstWriteReleased;
    }
    await super.beforeMutation();
  }
}

function deliveryPolicy(emit: (event: MachineLifecycleEvent) => Promise<void>): CommercialPolicy {
  return {
    lifecycleEventsEnabled: true,
    async checkCreate() { return { allowed: true }; },
    emitMachineFact: emit,
    async reconcile() {},
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
