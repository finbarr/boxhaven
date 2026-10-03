import { randomUUID } from "node:crypto";
import { SandboxAccessCache, SandboxProvider, sandboxPlan, sandboxPreviewPort, sandboxSSHPort } from "./sandbox_provider.js";
import type { SandboxRecord, SandboxPortAccess } from "./sandbox_provider.js";
import type { MachinePlan, MachineProviderInfo } from "./types.js";

type Config = { apiKey: string; workspace: string; image: string; region?: string; fetch?: typeof fetch };
type Sandbox = { metadata: { name: string; labels?: Record<string, string>; createdAt?: string; url?: string }; status?: string; spec: { region?: string; runtime?: { image?: string; ttl?: string | null; expires?: string | null } } };
type Preview = { spec: { url?: string; port?: number; public?: boolean } };
class BlaxelHTTPError extends Error { constructor(readonly status: number) { super(`Blaxel API returned HTTP ${status}`); } }
const sizes = { small: "m4096", medium: "m8192", large: "m16384" };

/** Explicit per-instance credentials avoid the SDK's process-global login state. */
export class BlaxelProvider extends SandboxProvider {
  readonly name = "blaxel";
  readonly label = "Blaxel";
  readonly info: MachineProviderInfo = { name: this.name, label: this.label, capabilities: ["create", "destroy", "list", "connect"], default_sizes: sizes };
  private readonly access = new SandboxAccessCache<SandboxPortAccess>();
  constructor(private readonly config: Config) {
    super(config.image, config.region);
    if (!config.apiKey || !config.workspace || !config.image) throw new Error("Blaxel requires BL_API_KEY, BL_WORKSPACE, and BOXHAVEN_REMOTE_IMAGE_BLAXEL");
    if (!/^[a-z0-9-]+$/.test(config.workspace)) throw new Error("Invalid Blaxel workspace");
  }
  async listPlans() { return [4096, 8192, 16384].map(memory => ({ ...sandboxPlan(this.name, `m${memory}`, memory / 2048, memory, 0, this.region),
    description: "Billed by Blaxel. Tier 0 sandboxes expire after seven days; Tier 1 after 30 days. Save work before the provider deletion deadline." })); }
  protected async inventory() {
    const records: SandboxRecord[] = [], cursors = new Set<string>();
    let cursor = "";
    do {
      const page = await this.api<{ data: Sandbox[]; meta?: { hasMore?: boolean; nextCursor?: string } }>(`/sandboxes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!Array.isArray(page.data)) throw new Error("Blaxel returned an invalid sandbox inventory");
      records.push(...page.data.filter(s => s.status !== "TERMINATED").map(s => this.record(s)));
      cursor = page.meta?.hasMore ? page.meta.nextCursor || "" : "";
      if (page.meta?.hasMore && (!cursor || cursors.has(cursor))) throw new Error("Blaxel returned an invalid inventory cursor");
      cursors.add(cursor);
    } while (cursor);
    return records;
  }
  protected async inspect(id: string) {
    try { const sandbox = await this.api<Sandbox>(`/sandboxes/${id}`); return sandbox.status === "TERMINATED" ? undefined : this.record(sandbox); }
    catch (error) { if (error instanceof BlaxelHTTPError && error.status === 404) return undefined; throw error; }
  }
  protected async provision(name: string, labels: Record<string, string>, plan: MachinePlan, region?: string) {
    let sandbox = await this.api<Sandbox>("/sandboxes", "POST", {
      metadata: { name, labels }, spec: { region, runtime: { image: this.image, memory: plan.memory_mb,
        ports: [{ target: sandboxSSHPort, protocol: "HTTP" }, { target: sandboxPreviewPort, protocol: "HTTP" }],
        envs: [{ name: "SANDBOX_DISABLE_PROCESS_LOGGING", value: "true" }] } },
    });
    // Ask for persistence. Lower account tiers enforce a maximum lifetime even
    // after clearing TTL; retain that native expiry in shared box metadata.
    sandbox = await this.api<Sandbox>(`/sandboxes/${sandbox.metadata.name}`, "PUT", {
      ...sandbox, spec: { ...sandbox.spec, runtime: { ...sandbox.spec.runtime, ttl: null, expires: null } },
    });
    return this.record(sandbox);
  }
  protected async bootstrap(id: string, script: string) {
    await this.runtime(id, "/filesystem/root/boxhaven-setup.sh", "PUT", { content: script, permissions: "0600" });
    const setup = await this.runtime<{ exitCode?: number }>(id, "/process", "POST", { command: "bash /root/boxhaven-setup.sh && rm /root/boxhaven-setup.sh", waitForCompletion: true, timeout: 45 });
    if (setup.exitCode !== 0) throw new Error("Blaxel prepared runtime setup failed");
    await this.runtime(id, "/process", "POST", { name: "boxhaven-runtime", command: "/etc/boxhaven/run-sandbox.sh",
      keepAlive: true, timeout: 0, waitForCompletion: false, waitForPorts: [sandboxSSHPort], restartOnFailure: true, maxRestarts: -1 });
    for (const port of [sandboxSSHPort, sandboxPreviewPort]) {
      await this.api(`/sandboxes/${id}/previews`, "POST", { metadata: { name: `boxhaven-${port}` }, spec: { port, public: false } });
    }
  }
  protected async remove(id: string) {
    await this.api(`/sandboxes/${id}`, "DELETE");
    for (let i = 0; i < 30; i++) { if (!(await this.inspect(id))) return; await new Promise(resolve => setTimeout(resolve, 1000)); }
    throw new Error("Blaxel sandbox deletion is still pending");
  }
  protected async portAccess(id: string, port: number, expiresAt: string) {
    // Tokens last beyond all backend grants served by this cache. They never leave the backend.
    return this.access.get(`${id}:${port}`, Date.now() + 10 * 60_000, async () => {
      const path = `/sandboxes/${id}/previews/boxhaven-${port}`;
      const preview = await this.api<Preview>(path);
      if (preview.spec.public !== false || preview.spec.port !== port || !preview.spec.url) throw new Error("Blaxel preview must remain private on its configured port");
      const token = await this.api<{ spec: { token?: string } }>(path + "/tokens", "POST", {
        metadata: { name: `boxhaven-${randomUUID()}` }, spec: { expiresAt: new Date(Math.max(Date.parse(expiresAt), Date.now() + 2 * 60 * 60_000)).toISOString() },
      });
      if (!token.spec.token) throw new Error("Blaxel did not return a private preview token");
      return { url: preview.spec.url, headers: { "X-Blaxel-Preview-Token": token.spec.token } };
    });
  }
  private record(s: Sandbox): SandboxRecord {
    if (!/^[a-z0-9-]{1,49}$/.test(s.metadata.name)) throw new Error("Blaxel returned an invalid sandbox identity");
    const runtime = s.spec.runtime;
    const ttl = runtime?.ttl?.match(/^(\d+)(s|m|h|d|w)$/);
    const factor: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    const expiry = runtime?.expires || (ttl && s.metadata.createdAt ? new Date(Date.parse(s.metadata.createdAt) + Number(ttl[1]) * factor[ttl[2]]).toISOString() : undefined);
    return { id: s.metadata.name, labels: s.metadata.labels || {}, state: s.status, image: runtime?.image, region: s.spec.region, createdAt: s.metadata.createdAt, expiresAt: expiry };
  }
  private api<T>(path: string, method = "GET", body?: unknown): Promise<T> { return this.request(`https://api.blaxel.ai/v0${path}`, method, body); }
  private async runtime<T>(id: string, path: string, method: string, body?: unknown): Promise<T> {
    const sandbox = await this.api<Sandbox>(`/sandboxes/${id}`);
    const url = new URL(sandbox.metadata.url || "https://invalid");
    if (url.protocol !== "https:" || !url.hostname.endsWith(".bl.run") || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Blaxel returned an invalid runtime endpoint");
    return this.request(url.origin + path, method, body);
  }
  private async request<T>(url: string, method: string, body?: unknown): Promise<T> {
    const response = await (this.config.fetch || fetch)(url, { method, headers: {
      "X-Blaxel-Authorization": `Bearer ${this.config.apiKey}`, "X-Blaxel-Workspace": this.config.workspace,
      "Blaxel-Version": "2026-09-22", "Content-Type": "application/json",
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(65_000) })
      .catch(() => { throw new Error("Blaxel API connection failed or timed out"); });
    if (!response.ok) { await response.body?.cancel(); throw new BlaxelHTTPError(response.status); }
    if (response.status === 204) return undefined as T;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Blaxel returned an empty response");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2 * 1024 * 1024) throw new Error("oversize"); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch { throw new Error("Blaxel returned an invalid or oversized response"); }
    finally { await reader.cancel(); }
  }
}
export function blaxelProviderFromEnv(env = process.env) {
  return new BlaxelProvider({ apiKey: env.BL_API_KEY?.trim() || "", workspace: env.BL_WORKSPACE?.trim() || "", image: env.BOXHAVEN_REMOTE_IMAGE_BLAXEL?.trim() || "", region: env.BL_REGION?.trim() });
}
