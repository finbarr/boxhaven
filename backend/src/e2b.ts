import { Sandbox, SandboxNotFoundError } from "e2b";
import { SandboxAccessCache, SandboxProvider, sandboxPlan } from "./sandbox_provider.js";
import type { SandboxRecord } from "./sandbox_provider.js";
import type { MachinePlan, MachineProviderInfo, RemoteMachine } from "./types.js";

type Config = { apiKey: string; template: string; cpu?: number; memoryMB?: number; diskGB?: number };
const leaseMs = 60 * 60 * 1000;
export class E2BProvider extends SandboxProvider {
  readonly name = "e2b";
  readonly label = "E2B";
  readonly info: MachineProviderInfo = { name: this.name, label: this.label, capabilities: ["create", "destroy", "list", "connect"],
    default_sizes: { small: "template", medium: "template", large: "template" } };
  private readonly access = new SandboxAccessCache<Sandbox>();
  private readonly renewal = new SandboxAccessCache<void>();
  private readonly resuming = new Map<string, Promise<void>>();
  private readonly renewalRetryAfter = new Map<string, number>();
  constructor(private readonly config: Config) {
    super(config.template);
    if (!config.apiKey || !config.template) throw new Error("E2B requires E2B_API_KEY and BOXHAVEN_REMOTE_IMAGE_E2B");
  }
  private get options() { return { apiKey: this.config.apiKey, requestTimeoutMs: 60_000, retries: 0 }; }
  async listPlans() {
    const plan = sandboxPlan(this.name, "template", this.config.cpu || 2, this.config.memoryMB || 4096, this.config.diskGB || 0);
    plan.label = "Prepared template";
    plan.description = "CPU, memory, and disk are fixed by the configured E2B template. Billed by E2B; BoxHaven renews the running sandbox lease.";
    return [plan];
  }
  protected async inventory(team?: string) {
    const pages = Sandbox.list({ ...this.options, query: { metadata: { boxhaven: "true", ...(team ? { boxhaven_team: team } : {}) } } });
    const records: SandboxRecord[] = [];
    while (pages.hasNext) records.push(...(await pages.nextItems()).map(s => this.record(s)));
    return records;
  }
  protected async inspect(id: string) {
    try { return this.record(await Sandbox.getInfo(id, this.options)); }
    catch (error) { if (error instanceof SandboxNotFoundError) return undefined; throw new Error("E2B sandbox lookup failed"); }
  }
  protected async provision(_name: string, labels: Record<string, string>, _plan: MachinePlan) {
    const sandbox = await Sandbox.create(this.image, { ...this.options, timeoutMs: leaseMs, metadata: labels,
      network: { allowPublicTraffic: false }, lifecycle: { onTimeout: { action: "pause", keepMemory: true }, autoResume: true } });
    this.access.get(sandbox.sandboxId, Date.now() + 15 * 60_000, async () => sandbox);
    return this.record(await sandbox.getInfo());
  }
  protected async bootstrap(id: string, script: string) {
    const sandbox = await this.connect(id);
    await sandbox.files.write("/root/boxhaven-setup.sh", script, { user: "root" });
    await sandbox.commands.run("chmod 0600 /root/boxhaven-setup.sh && bash /root/boxhaven-setup.sh && rm /root/boxhaven-setup.sh", { user: "root", timeoutMs: 60_000 });
    await sandbox.commands.run("nohup /etc/boxhaven/run-sandbox.sh >/var/log/boxhaven-sandbox.log 2>&1 </dev/null &", { user: "root", timeoutMs: 10_000 });
  }
  protected async remove(id: string) { await Sandbox.kill(id, this.options); this.access.delete(id); this.renewal.delete(id); this.renewalRetryAfter.delete(id); }
  protected async portAccess(id: string, port: number) {
    const sandbox = await this.connect(id);
    if (!sandbox.trafficAccessToken) throw new Error("E2B did not return a private traffic token");
    return { url: `https://${sandbox.getHost(port)}`, headers: { "E2B-Traffic-Access-Token": sandbox.trafficAccessToken } };
  }
  async maintainMachine(machine: RemoteMachine) {
    const id = this.id(machine);
    if ((this.renewalRetryAfter.get(id) || 0) > Date.now()) return;
    await this.renewal.get(id, Date.now() + 15 * 60_000, async () => {
      try { await Sandbox.setTimeout(id, leaseMs, this.options); this.renewalRetryAfter.delete(id); }
      catch { this.renewalRetryAfter.set(id, Date.now() + 60_000); throw new Error("E2B lease renewal failed"); }
    });
  }
  async ensureMachineRunning(machine: RemoteMachine) {
    const id = this.id(machine);
    let pending = this.resuming.get(id);
    if (!pending) {
      pending = (async () => {
        await this.owned(machine);
        // connect resumes paused memory; cached transport metadata alone cannot wake it.
        await Sandbox.connect(id, { ...this.options, timeoutMs: leaseMs });
      })().finally(() => this.resuming.delete(id));
      this.resuming.set(id, pending);
    }
    await pending;
  }
  private connect(id: string) { return this.access.get(id, Date.now() + 15 * 60_000, () => Sandbox.connect(id, { ...this.options, timeoutMs: leaseMs })); }
  private record(s: Awaited<ReturnType<typeof Sandbox.getInfo>>): SandboxRecord {
    return { id: s.sandboxId, labels: s.metadata, state: s.state, image: s.templateId, createdAt: s.startedAt.toISOString() };
  }
}
export function e2bProviderFromEnv(env = process.env) {
  return new E2BProvider({ apiKey: env.E2B_API_KEY?.trim() || "", template: env.BOXHAVEN_REMOTE_IMAGE_E2B?.trim() || "",
    cpu: Number(env.BOXHAVEN_E2B_TEMPLATE_CPU || 2), memoryMB: Number(env.BOXHAVEN_E2B_TEMPLATE_MEMORY_MB || 4096), diskGB: Number(env.BOXHAVEN_E2B_TEMPLATE_DISK_GB || 0) });
}
