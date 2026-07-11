import { policyMachineIdentity } from "./policy.js";
import type { CommercialPolicy, MachineLifecycleEvent, PolicyReconciliation } from "./policy.js";
import type { StateStore } from "./state.js";

export class PolicyEventDelivery {
  private timer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private running = false;
  private reconciling = false;
  private stopped = false;

  constructor(
    private readonly store: StateStore,
    private readonly policy: CommercialPolicy,
    private readonly retryMs = 30_000,
    private readonly reconcileIntervalMs = 5 * 60_000,
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
      await this.policy.reconcile(reconciliationSnapshot(await this.store.listMachines()));
    } catch (error) {
      failed = true;
      console.error(`commercial policy reconciliation failed: ${(error as Error).message}`);
    } finally {
      this.reconciling = false;
      if (!this.stopped) this.scheduleReconcile(failed ? this.retryMs : this.reconcileIntervalMs);
    }
  }
}

export function reconciliationSnapshot(
  machines: Awaited<ReturnType<StateStore["listMachines"]>>,
  generatedAt = new Date().toISOString(),
): PolicyReconciliation {
  return {
    version: 1,
    generated_at: generatedAt,
    machines: machines.map((machine) => {
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
