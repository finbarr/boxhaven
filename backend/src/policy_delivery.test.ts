import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CommercialPolicy, MachineLifecycleEvent } from "./policy.js";
import { PolicyEventDelivery } from "./policy_delivery.js";
import { StateStore } from "./state.js";

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
  assert.deepEqual(afterDestroy.policy_events[destroyed.id], destroyed);
});

test("failed delivery remains queued and is retried after process restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-policy-restart-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path, "fake");
  await store.putMachine({ name: "box", user_id: "user-1", provider: "fake" }, event);

  const failedIDs: string[] = [];
  const failing = deliveryPolicy(async (delivered) => {
    failedIDs.push(delivered.id);
    throw new Error("offline");
  });
  const firstProcess = new PolicyEventDelivery(store, failing, 5);
  firstProcess.start();
  await waitFor(() => failedIDs.length > 0);
  firstProcess.stop();
  assert.deepEqual((await store.listPolicyEvents()).map((queued) => queued.id), [event.id]);

  const deliveredIDs: string[] = [];
  const restartedStore = new StateStore(path, "fake");
  const secondProcess = new PolicyEventDelivery(restartedStore, deliveryPolicy(async (delivered) => {
    deliveredIDs.push(delivered.id);
  }), 5);
  secondProcess.start();
  await waitFor(async () => (await restartedStore.listPolicyEvents()).length === 0);
  secondProcess.stop();
  assert.deepEqual(deliveredIDs, [event.id]);
  assert.ok(failedIDs.every((id) => id === event.id));
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

function deliveryPolicy(emit: (event: MachineLifecycleEvent) => Promise<void>): CommercialPolicy {
  return {
    lifecycleEventsEnabled: true,
    async checkCreate() { return { allowed: true }; },
    emitMachineFact: emit,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
