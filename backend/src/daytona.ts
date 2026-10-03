import { Configuration, SandboxApi } from "@daytona/api-client";
import type { Sandbox } from "@daytona/api-client";
import { Configuration as ToolboxConfiguration, FileSystemApi, ProcessApi } from "@daytona/toolbox-api-client";
import { SandboxAccessCache, SandboxProvider, SandboxSetupError, sandboxPlan } from "./sandbox_provider.js";
import type { SandboxRecord, SandboxPortAccess } from "./sandbox_provider.js";
import type { MachinePlan, MachineProviderInfo } from "./types.js";

type Config = { apiKey: string; image: string; region?: string };
const sizes = { small: "c2-m4", medium: "c4-m8", large: "c4-m8" };
const delay = () => new Promise(resolve => setTimeout(resolve, 1000));

/** Official typed API clients, with explicit credentials and bounded requests. */
export class DaytonaProvider extends SandboxProvider {
  readonly name = "daytona";
  readonly label = "Daytona";
  readonly info: MachineProviderInfo = { name: this.name, label: this.label, capabilities: ["create", "destroy", "list", "connect"], default_sizes: sizes };
  private readonly client: SandboxApi;
  private readonly access = new SandboxAccessCache<SandboxPortAccess>();
  private readonly requestOptions;
  constructor(config: Config) {
    super(config.image, config.region);
    if (!config.apiKey || !config.image) throw new Error("Daytona requires DAYTONA_API_KEY and BOXHAVEN_REMOTE_IMAGE_DAYTONA");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/.test(config.image)) throw new Error("Daytona requires an OCI image reference");
    this.requestOptions = { headers: { Authorization: `Bearer ${config.apiKey}` }, timeout: 65_000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024 };
    this.client = new SandboxApi(new Configuration({ basePath: "https://app.daytona.io/api", baseOptions: this.requestOptions }));
  }
  async listPlans() { return [sandboxPlan(this.name, sizes.small, 2, 4096, 10, this.region), sandboxPlan(this.name, sizes.medium, 4, 8192, 10, this.region)]
    .map(plan => ({ ...plan, description: "Billed by Daytona. Your organization must allow outbound access to the BoxHaven backend; Tier 1 and Tier 2 restrict internet access." })); }
  protected async inventory(team?: string) {
    const records: SandboxRecord[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const { data } = await this.client.listSandboxes(undefined, cursor, 100, undefined, undefined,
        JSON.stringify({ boxhaven: "true", ...(team ? { boxhaven_team: team } : {}) }));
      records.push(...data.items.filter(s => s.state !== "destroyed").map(s => this.record(s)));
      cursor = data.nextCursor || undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Daytona returned a repeated inventory cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return records;
  }
  protected async inspect(id: string) {
    const sandbox = await this.get(id);
    return sandbox && sandbox.state !== "destroyed" ? this.record(sandbox) : undefined;
  }
  protected async provision(name: string, labels: Record<string, string>, plan: MachinePlan) {
    let { data: sandbox } = await this.client.createSandbox({ name, user: "root", labels, public: false, target: this.region,
      buildInfo: { dockerfileContent: `FROM ${this.image}\nENTRYPOINT ["/bin/sleep", "infinity"]\n` },
      cpu: plan.vcpus, memory: plan.memory_mb / 1024, disk: plan.disk_gb,
      autoStopInterval: 0, autoPauseInterval: 0, autoDeleteInterval: -1, ttlMinutes: 0 });
    const deadline = Date.now() + 300_000;
    while (sandbox.state !== "started") {
      if (["error", "build_failed", "destroyed"].includes(sandbox.state || "unknown") || Date.now() >= deadline) throw new Error("Daytona prepared image did not start");
      await delay();
      const next = await this.get(sandbox.id);
      if (!next) throw new Error("Daytona sandbox disappeared during creation");
      sandbox = next;
    }
    return this.record(sandbox);
  }
  protected async bootstrap(id: string, script: string) {
    const sandbox = await this.get(id);
    if (!sandbox) throw new Error("Daytona sandbox was not found");
    const url = new URL(sandbox.toolboxProxyUrl);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".daytona.io") || url.port || url.username || url.password || url.search || url.hash) throw new Error("Daytona returned an invalid runtime endpoint");
    const config = new ToolboxConfiguration({ basePath: url.href.replace(/\/+$/, "") + "/" + id, baseOptions: this.requestOptions });
    const files = new FileSystemApi(config), process = new ProcessApi(config);
    const body = new FormData();
    body.append("files[0].path", "/root/boxhaven-setup.sh");
    body.append("files[0].file", new Blob([script]), "boxhaven-setup.sh");
    await files.uploadFiles({ data: body });
    const { data: setup } = await process.executeCommand({ command: "chmod 0600 /root/boxhaven-setup.sh && bash /root/boxhaven-setup.sh && rm /root/boxhaven-setup.sh", cwd: "/root", timeout: 60 });
    if (setup.exitCode !== 0) throw new Error("Daytona prepared runtime setup failed");
    const { data: network } = await process.executeCommand({ command: "bash -c 'source /etc/boxhaven/agent.env; curl --connect-timeout 5 --max-time 15 --silent --show-error --output /dev/null \"$BOXHAVEN_AGENT_BACKEND_URL/healthz\"'", cwd: "/root", timeout: 20 });
    if (network.exitCode !== 0) throw new SandboxSetupError("Daytona cannot reach the BoxHaven backend. Check your organization network policy; Tier 1 and Tier 2 require Daytona support to allow the backend domain");
    const { data: launch } = await process.executeCommand({ command: "nohup /etc/boxhaven/run-sandbox.sh >/var/log/boxhaven-sandbox.log 2>&1 </dev/null &", cwd: "/root", timeout: 10 });
    if (launch.exitCode !== 0) throw new Error("Daytona runtime launch failed");
  }
  protected async remove(id: string) {
    await this.client.deleteSandbox(id);
    for (let i = 0; i < 60; i++) { if (!(await this.inspect(id))) return; await delay(); }
    throw new Error("Daytona sandbox deletion is still pending");
  }
  protected async portAccess(id: string, port: number) {
    return this.access.get(`${id}:${port}`, Date.now() + 10 * 60_000, async () => {
      const sandbox = await this.get(id);
      if (!sandbox || sandbox.public) throw new Error("Daytona sandbox preview must remain private");
      const { data: preview } = await this.client.getPortPreviewUrl(id, port);
      if (!preview.token) throw new Error("Daytona did not return a private preview token");
      return { url: preview.url, headers: { "x-daytona-preview-token": preview.token, "X-Daytona-Skip-Preview-Warning": "true" } };
    });
  }
  private async get(id: string): Promise<Sandbox | undefined> {
    try { return (await this.client.getSandbox(id)).data; }
    catch (error) {
      if ((error as { response?: { status?: number } }).response?.status === 404) return undefined;
      throw new Error("Daytona sandbox lookup failed");
    }
  }
  private record(s: Pick<Sandbox, "id" | "labels" | "state" | "snapshot" | "target" | "createdAt" | "autoDestroyAt">): SandboxRecord { return { id: s.id, labels: s.labels, state: s.state, image: s.snapshot, region: s.target, createdAt: s.createdAt, expiresAt: s.autoDestroyAt }; }
}
export function daytonaProviderFromEnv(env = process.env) {
  return new DaytonaProvider({ apiKey: env.DAYTONA_API_KEY?.trim() || "", image: env.BOXHAVEN_REMOTE_IMAGE_DAYTONA?.trim() || "", region: env.DAYTONA_TARGET?.trim() });
}
