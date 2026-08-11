import { policyMachineIdentity } from "./policy.js";
import type { CommercialPolicy, MachineLifecycleAction, MachineLifecycleEvent, PolicyReconciliation } from "./policy.js";
import type { MachineCleanupRecord, StateStore } from "./state.js";
import type { RemoteMachine } from "./types.js";

export type MachineCleanupExecutor = (machine: RemoteMachine) => Promise<void>;

export class PolicyEventDelivery {
  private timer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private running = false;
  private reconciling = false;
  private reconcilePending = false;
  private stopped = false;

  constructor(
    private readonly store: StateStore,
    private readonly policy: CommercialPolicy,
    private readonly retryMs = 30_000,
    private readonly reconcileIntervalMs = 5 * 60_000,
    private readonly cleanupMachine?: MachineCleanupExecutor,
  ) {}

  start(): void {
    if (!this.policy.lifecycleEventsEnabled || this.stopped) return;
    this.schedule(0);
    this.scheduleReconcile(0);
  }

  notify(): void {
    if (!this.policy.lifecycleEventsEnabled || this.stopped) return;
    this.schedule(0);
  }

  notifyReconcile(): void {
    if (!this.policy.lifecycleEventsEnabled || this.stopped) return;
    if (this.reconciling) {
      this.reconcilePending = true;
      return;
    }
    this.scheduleReconcile(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.timer = undefined;
    this.reconcileTimer = undefined;
  }

  private scheduleReconcile(delayMs: number): void {
    if (this.reconciling || this.stopped) return;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined;
      void this.reconcile();
    }, delayMs);
    this.reconcileTimer.unref();
  }

  private schedule(delayMs: number): void {
    if (this.running || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.deliver();
    }, delayMs);
    this.timer.unref();
  }

  private async deliver(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (const event of await this.store.listPolicyEvents()) {
        if (this.stopped) return;
        try {
          await this.deliverOne(event);
        } catch (error) {
          console.error(`commercial policy ${event.type} event ${event.id} failed: ${(error as Error).message}`);
          break;
        }
      }
    } catch (error) {
      console.error(`commercial policy outbox failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
      if (!this.stopped) this.schedule(this.retryMs);
    }
  }

  private async deliverOne(event: MachineLifecycleEvent): Promise<void> {
    await this.policy.emitMachineFact(event);
    await this.store.deletePolicyEvent(event.id);
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling || this.stopped) return;
    this.reconciling = true;
    let failed = false;
    try {
      const attempted = new Set<string>();
      failed = !(await this.processCleanups(attempted));
      const snapshot = await this.store.captureMachineSnapshot();
      const result = await this.policy.reconcile(reconciliationSnapshot(snapshot.machines, snapshot.generatedAt));
      const actions = normalizedActions(result?.actions || []);
      let inserted = false;
      for (const action of actions) {
        inserted = (await this.store.requestMachineCleanup(action)) || inserted;
      }
      if (inserted) failed = !(await this.processCleanups(attempted)) || failed;
    } catch (error) {
      failed = true;
      console.error(`commercial policy reconciliation failed: ${(error as Error).message}`);
    } finally {
      this.reconciling = false;
      const pending = this.reconcilePending;
      this.reconcilePending = false;
      if (!this.stopped) this.scheduleReconcile(pending ? 0 : failed ? this.retryMs : this.reconcileIntervalMs);
    }
  }

  private async processCleanups(attempted: Set<string>): Promise<boolean> {
    let succeeded = true;
    for (const cleanup of await this.store.listMachineCleanups()) {
      if (this.stopped) return succeeded;
      if (attempted.has(cleanup.machine_id)) continue;
      attempted.add(cleanup.machine_id);
      try {
        await this.executeCleanup(cleanup);
      } catch (error) {
        succeeded = false;
        console.error(`commercial policy cleanup ${cleanup.machine_id} failed: ${(error as Error).message}`);
      }
    }
    return succeeded;
  }

  private async executeCleanup(cleanup: MachineCleanupRecord): Promise<void> {
    if (!this.cleanupMachine) throw new Error("machine cleanup executor is not configured");
    await this.cleanupMachine(cleanup.machine);
    if (await this.store.completeMachineCleanup(cleanup.machine_id)) this.notify();
  }
}

function normalizedActions(actions: MachineLifecycleAction[]): MachineLifecycleAction[] {
  const byMachine = new Map<string, MachineLifecycleAction>();
  for (const action of actions) {
    if (action.type !== "machine.destroy" || !action.team_id || !action.machine_id || !action.reason) {
      throw new Error("commercial policy returned an invalid machine lifecycle action");
    }
    const existing = byMachine.get(action.machine_id);
    if (existing && (existing.team_id !== action.team_id || existing.type !== action.type)) {
      throw new Error(`commercial policy returned conflicting actions for machine ${action.machine_id}`);
    }
    byMachine.set(action.machine_id, action);
  }
  return [...byMachine.values()].sort((left, right) => (
    left.team_id.localeCompare(right.team_id) || left.machine_id.localeCompare(right.machine_id)
  ));
}

export function reconciliationSnapshot(
  machines: Awaited<ReturnType<StateStore["listMachines"]>>,
  generatedAt = new Date().toISOString(),
): PolicyReconciliation {
  return {
    version: 1,
    generated_at: generatedAt,
    // Provisioning recovery records block destructive operations but are not
    // provider-confirmed lifecycle facts and must never activate billing.
    machines: machines.filter((machine) => !machine.create_state).map((machine) => {
      const teamID = machine.org_id || machine.user_id || "unknown";
      return {
        team: {
          id: teamID,
          name: machine.org_name || teamID,
          ...(machine.org_slug ? { slug: machine.org_slug } : {}),
        },
        machine: policyMachineIdentity(machine),
      };
    }),
  };
}
