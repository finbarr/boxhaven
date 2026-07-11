import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommercialPolicy, MachineLifecycleEvent } from "./policy.js";
import { PolicyEventDelivery, reconciliationSnapshot } from "./policy_delivery.js";
import { StateStore } from "./state.js";
import type { BackendState } from "./types.js";

const event: MachineLifecycleEvent = {
  version: 1,
  id: "event-stable-1",
  occurred_at: "2026-07-11T00:00:00.000Z",
  type: "machine.created",
  team: { id: "team-1", name: "Team One", slug: "team-one" },
  actor: { id: "user-1", email: "user@example.com" },
  machine: { id: "provider:machine-1", name: "box", tier: "medium" },
};

test("machine state and its policy event survive restart in one state commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path, "fake");
  await store.putMachine({ name: "box", user_id: "user-1", provider: "fake" }, event);

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.machines["user-1:box"].name, "box");
  assert.deepEqual(persisted.policy_events[event.id], event);

  const restarted = new StateStore(path, "fake");
  assert.equal((await restarted.getMachine("user-1", "box"))?.name, "box");
  assert.deepEqual(await restarted.listPolicyEvents(), [event]);

  const destroyed = { ...event, id: "event-stable-2", type: "machine.destroyed" as const };
  await restarted.deleteMachine("user-1", "box", destroyed);
  const afterDestroy = JSON.parse(await readFile(path, "utf8"));
  assert.equal(afterDestroy.machines["user-1:box"], undefined);
  assert.deepEqual(afterDestroy.policy_events[destroyed.id], {
    ...destroyed,
    occurred_at: "2026-07-11T00:00:00.001Z",
  });
});

test("failed delivery remains queued and is retried after process restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-restart-"));
  const path = join(dir, "state.json");
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
  const path = join(dir, "state.json");
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

test("a post-rename sync failure cannot make a later state write lose the committed outbox", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-sync-failure-"));
  const path = join(dir, "state.json");
  const store = new FlakyDirectorySyncStateStore(path, "fake");
  await store.load();
  await assert.rejects(
    store.putMachine({ name: "first", user_id: "user-1", provider: "fake" }, event),
    /simulated directory sync failure/,
  );
  const second = { ...event, id: "event-stable-second", machine: { ...event.machine, id: "provider:second", name: "second" } };
  await store.putMachine({ name: "second", user_id: "user-1", provider: "fake" }, second);

  const restarted = new StateStore(path, "fake");
  assert.equal((await restarted.getMachine("user-1", "first"))?.name, "first");
  assert.equal((await restarted.getMachine("user-1", "second"))?.name, "second");
  assert.deepEqual((await restarted.listPolicyEvents()).map((queued) => queued.id).sort(), [event.id, second.id].sort());
});

test("concurrent state mutations are serialized without lost machines or outbox entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-concurrent-"));
  const path = join(dir, "state.json");
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

test("reconciliation uses lifecycle team and stable provider machine identity semantics", () => {
  assert.deepEqual(reconciliationSnapshot([{
    name: "renamed-box",
    user_id: "user-1",
    provider: "fake",
    provider_name: "stable-provider-name",
    tier: "large",
    org_id: "team-1",
    org_name: "Team One",
    org_slug: "team-one",
  }], "2026-07-11T00:05:00.000Z"), {
    version: 1,
    generated_at: "2026-07-11T00:05:00.000Z",
    machines: [{
      team: { id: "team-1", name: "Team One", slug: "team-one" },
      machine: { id: "fake:stable-provider-name", name: "renamed-box", tier: "large" },
    }],
  });
});

test("reconciliation capture is serialized with lifecycle state commits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-capture-"));
  const store = new StateStore(join(dir, "state.json"), "fake");
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
  const path = join(dir, "state.json");
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
  const store = new StateStore(join(dir, "state.json"), "fake");
  await store.putMachine({
    name: "box",
    user_id: "user-1",
    provider: "fake",
    provider_name: "stable-box",
    tier: "medium",
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

  protected override async writeState(state: BackendState): Promise<void> {
    if (this.firstWrite) {
      this.firstWrite = false;
      this.markFirstWriteStarted();
      await this.firstWriteReleased;
    }
    await super.writeState(state);
  }
}

class FlakyDirectorySyncStateStore extends StateStore {
  private fail = true;

  protected override async syncStateDirectory(): Promise<void> {
    if (this.fail) {
      this.fail = false;
      throw new Error("simulated directory sync failure");
    }
    await super.syncStateDirectory();
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
