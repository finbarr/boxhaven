import { sanitizeResourceName, sandboxSetupScript } from "./cloudinit.js";
import { defaultSSHUser, MachineCreateError } from "./types.js";
import type { CreateMachineRequest, ListProviderMachinesRequest, MachinePlan, MachineProvider, MachineProviderInfo, RemoteMachine, SSHAccess } from "./types.js";

export const sandboxPreviewPort = 8081;
export const sandboxSSHPort = 9898;
export type SandboxRecord = {
  id: string; labels: Record<string, string>; state?: string; image?: string; region?: string;
  createdAt?: string; expiresAt?: string;
};
export type SandboxPortAccess = { url: string; headers: Record<string, string> };
/** Only adapter-authored guidance may cross the provider-error boundary. */
export class SandboxSetupError extends Error {}

/** The common BoxHaven contract; provider lifecycle and authentication stay in each driver. */
export abstract class SandboxProvider implements MachineProvider {
  abstract readonly name: string;
  abstract readonly label: string;
  abstract readonly info: MachineProviderInfo;
  abstract listPlans(): Promise<MachinePlan[]>;
  protected abstract inventory(team?: string): Promise<SandboxRecord[]>;
  protected abstract inspect(id: string): Promise<SandboxRecord | undefined>;
  protected abstract provision(name: string, labels: Record<string, string>, plan: MachinePlan, region?: string): Promise<SandboxRecord>;
  protected abstract bootstrap(id: string, script: string): Promise<void>;
  protected abstract remove(id: string): Promise<void>;
  protected abstract portAccess(id: string, port: number, expiresAt: string): Promise<SandboxPortAccess>;
  constructor(protected readonly image: string, protected readonly region?: string) {}

  async createMachine(request: CreateMachineRequest) {
    let labels: Record<string, string>, plan: MachinePlan, setup: string, name: string;
    try {
      if (request.image && request.image !== this.image) throw new Error(`${this.label} requires the configured prepared runtime image`);
      if (request.ssh_user && request.ssh_user !== defaultSSHUser) throw new Error("Sandbox runtimes use the boxhaven SSH user");
      if (request.region && request.region !== this.region) throw new Error(`${this.label} uses the backend's configured region`);
      const providerName = request.provider_name || request.name;
      const team = providerName.match(/-([a-f0-9]{10})$/)?.[1];
      if (!team) throw new Error("Sandbox creation requires a team-scoped provider name");
      labels = { boxhaven: "true", boxhaven_team: team, boxhaven_name: request.name, boxhaven_provider_name: providerName };
      name = sandboxResourceName(providerName);
      plan = (await this.listPlans()).find(p => p.slug === (request.provider_size || this.info.default_sizes?.small))!;
      if (!plan) throw new Error(`Unknown ${this.label} size`);
      labels.boxhaven_size = plan.slug;
      setup = sandboxSetupScript(request);
    } catch (error) { throw new MachineCreateError((error as Error).message, "not_created"); }
    let existing: SandboxRecord[];
    try { existing = await this.inventory(labels.boxhaven_team); }
    catch { throw new MachineCreateError(`${this.label} inventory lookup failed before creation`, "not_created"); }
    if (existing.some(s => s.labels.boxhaven_provider_name === labels.boxhaven_provider_name)) {
      throw new MachineCreateError(`${this.label} sandbox already exists for this box`, "not_created");
    }
    try {
      const sandbox = await this.provision(name, labels, plan, this.region);
      this.assertOwned(sandbox);
      await this.bootstrap(sandbox.id, setup);
      return { machine: { ...this.machine(sandbox), bootstrap_complete: true }, status: sandbox.state || "created" };
    } catch (error) {
      // A rejected response or bootstrap failure can leave a billable sandbox.
      // Keep the durable recovery reservation; never blindly retry creation.
      const message = error instanceof SandboxSetupError ? error.message : `${this.label} creation or runtime setup failed`;
      throw new MachineCreateError(`${message}; reconcile the reserved box before retrying`, "unknown");
    }
  }

  async getMachine(machine: RemoteMachine) {
    const sandbox = await this.owned(machine);
    return { machine: { ...this.machine(sandbox), name: machine.name }, status: sandbox.state };
  }
  async listMachines(request: ListProviderMachinesRequest) {
    if (!request.provider_name_suffix) return [];
    const team = request.provider_name_suffix;
    return (await this.inventory(team)).filter(s => this.isOwned(s) && s.labels.boxhaven_team === team)
      .map(s => ({ machine: this.machine(s), status: s.state }));
  }
  async releaseMachine(machine: RemoteMachine) {
    let id = machine.provider_id;
    if (!id) {
      const team = machine.provider_name?.match(/-([a-f0-9]{10})$/)?.[1];
      if (machine.provider !== this.name || !team) throw new Error("Sandbox recovery requires a team-scoped provider name");
      const matches = (await this.inventory(team)).filter(s => this.isOwned(s) && s.labels.boxhaven_provider_name === machine.provider_name);
      if (matches.length === 0) return;
      if (matches.length !== 1) throw new Error("Multiple sandboxes match this recovery record; inspect them before destruction");
      id = matches[0].id;
    }
    id = this.id({ ...machine, provider_id: id });
    const sandbox = await this.inspect(id);
    if (!sandbox) return;
    this.assertOwned(sandbox, machine);
    await this.remove(id);
    if (await this.inspect(id)) throw new Error(`${this.label} has not confirmed deletion; retry destruction to reconcile`);
  }
  async issueSSHAccess(machine: RemoteMachine, expiresAt: string): Promise<SSHAccess> {
    const access = await this.portAccess(this.id(machine), sandboxSSHPort, expiresAt);
    return { kind: "websocket", url: privatePortOrigin(access.url).replace(/^https:/, "wss:") + "/ssh", headers: access.headers, expires_at: expiresAt };
  }
  async issuePreviewAccess(machine: RemoteMachine, expiresAt: string) {
    const access = await this.portAccess(this.id(machine), sandboxPreviewPort, expiresAt);
    return { ...access, url: privatePortOrigin(access.url) };
  }
  protected id(machine: RemoteMachine) {
    if (machine.provider !== this.name || !machine.provider_id || !/^[a-zA-Z0-9-]{1,128}$/.test(machine.provider_id)) throw new Error(`Invalid ${this.label} sandbox identity`);
    return machine.provider_id;
  }
  protected async owned(machine: RemoteMachine) {
    const sandbox = await this.inspect(this.id(machine));
    if (!sandbox) throw new Error(`${this.label} sandbox was not found`);
    this.assertOwned(sandbox, machine);
    return sandbox;
  }
  private isOwned(sandbox: SandboxRecord) {
    const labels = sandbox.labels;
    return labels.boxhaven === "true" && /^[a-f0-9]{10}$/.test(labels.boxhaven_team || "")
      && !!labels.boxhaven_name && labels.boxhaven_provider_name?.endsWith(`-${labels.boxhaven_team}`);
  }
  private assertOwned(sandbox: SandboxRecord, machine?: RemoteMachine) {
    if (!this.isOwned(sandbox) || (machine?.provider_name && sandbox.labels.boxhaven_provider_name !== machine.provider_name)) throw new Error(`${this.label} sandbox ownership metadata does not match`);
  }
  private machine(sandbox: SandboxRecord): RemoteMachine {
    return { name: sandbox.labels.boxhaven_name, provider_name: sandbox.labels.boxhaven_provider_name,
      provider: this.name, provider_id: sandbox.id, ssh_user: defaultSSHUser, ssh_transport: "websocket",
      preview_transport: "provider", preview_target_port: sandboxPreviewPort, image: sandbox.image || this.image,
      size: sandbox.labels.boxhaven_size, region: sandbox.region || this.region, created_at: sandbox.createdAt,
      provider_expires_at: sandbox.expiresAt };
  }
}

function privatePortOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Provider returned an unsafe private port endpoint");
  return url.origin;
}

// Blaxel has the shortest name limit (49); preserve the team suffix on every provider.
export function sandboxResourceName(value: string) {
  const clean = sanitizeResourceName(value), suffix = clean.match(/-[a-f0-9]{10}$/)?.[0] || "";
  return `boxhaven-${clean.slice(0, suffix ? -suffix.length : undefined).slice(0, 40-suffix.length).replace(/-+$/, "")}${suffix}`;
}

/** Coalesce concurrent access requests without storing credentials in machine records. */
export class SandboxAccessCache<T> {
  private readonly entries = new Map<string, { expires: number; value: Promise<T> }>();
  get(key: string, expires: number, create: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expires > Date.now() + 60_000) return cached.value;
    for (const [id, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(id);
    const value = create().catch(error => { if (this.entries.get(key)?.value === value) this.entries.delete(key); throw error; });
    this.entries.set(key, { expires, value });
    return value;
  }
  delete(key: string) { this.entries.delete(key); }
}

export function sandboxPlan(provider: string, slug: string, cpu: number, memory: number, disk: number, region?: string): MachinePlan {
  return { provider, slug, label: `${cpu} CPU / ${memory / 1024} GB`, vcpus: cpu, memory_mb: memory, disk_gb: disk,
    available: true, regions: region ? [region] : [], prices: [], description: "Billed by your sandbox provider. Provider capacity and retention limits apply." };
}
