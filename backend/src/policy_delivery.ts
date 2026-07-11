import type { CommercialPolicy, MachineLifecycleEvent } from "./policy.js";
import type { StateStore } from "./state.js";

export class PolicyEventDelivery {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(
    private readonly store: StateStore,
    private readonly policy: CommercialPolicy,
    private readonly retryMs = 30_000,
  ) {}

  start(): void {
    if (!this.policy.lifecycleEventsEnabled || this.stopped) return;
    this.schedule(0);
  }

  notify(): void {
    if (!this.policy.lifecycleEventsEnabled || this.stopped) return;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
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
}
