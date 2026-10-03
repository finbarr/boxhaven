import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentSetupScript, sanitizeResourceName } from "./cloudinit.js";
import { exeDevSSHCommand } from "./exedev_ssh.js";
import { MachineCreateError, defaultSSHUser } from "./types.js";
import type { CreateMachineRequest, ListProviderMachinesRequest, MachinePlan, MachineProvider, MachineProviderInfo, RemoteMachine, SSHAccess } from "./types.js";

const exec = promisify(execFile);
type VM = { vm_name: string; status?: string; region?: string; image?: string; created_at?: string; tags?: string[] };
type Config = { signingKey: string; image: string; registryAuth?: string; fetch?: typeof fetch; ssh?: (command: string, setup: string) => Promise<string> };
const sizes = { small: "c2-m4", medium: "c4-m8", large: "c8-m16" };

/** Implements exe.dev's documented SSHSIG tokens, without registering a key per attachment. */
export async function exeDevToken(signingKey: string, namespace: string, permissions: { exp: number; cmds?: string[] }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "boxhaven-exe-token-"));
  try {
    const payload = JSON.stringify(permissions);
    const file = join(directory, "permissions");
    await writeFile(file, payload, { mode: 0o600 });
    try {
      await exec("ssh-keygen", ["-Y", "sign", "-f", signingKey, "-n", namespace, file], { timeout: 5000, env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" } });
    } catch { throw new Error("Cannot sign exe.dev access token; check the backend's registered, unencrypted signing key"); }
    const pem = await readFile(file + ".sig", "utf8");
    const signature = Buffer.from(pem.replace(/-----[^\n]+-----/g, "").replace(/\s/g, ""), "base64").toString("base64url");
    return `exe0.${Buffer.from(payload).toString("base64url")}.${signature}`;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export class ExeDevProvider implements MachineProvider {
  readonly name = "exedev";
  readonly label = "exe.dev";
  readonly info: MachineProviderInfo = { name: this.name, label: this.label, capabilities: ["create", "destroy", "list", "connect"], default_sizes: sizes };
  constructor(private readonly config: Config) {
    if (!config.signingKey || !config.image) throw new Error("exe.dev requires EXE_DEV_SIGNING_KEY and BOXHAVEN_REMOTE_IMAGE_EXEDEV");
  }

  async listPlans(): Promise<MachinePlan[]> {
    return Object.values(sizes).map(slug => {
      const [, cpu, memory] = /^c(\d+)-m(\d+)$/.exec(slug)!;
      return { provider: this.name, slug, label: `${cpu} CPU / ${memory} GB`, vcpus: Number(cpu), memory_mb: Number(memory)*1024, disk_gb: 20, regions: [], prices: [], available: true, description: "Uses your exe.dev account's capacity and default region. Consult exe.dev for billing." };
    });
  }

  async createMachine(request: CreateMachineRequest) {
    let name: string, plan: MachinePlan, setup: string;
    try {
      if (request.region) throw new Error("exe.dev uses the account's default region; per-machine region selection is unavailable");
      if (request.image && request.image !== this.config.image) throw new Error("exe.dev requires the configured prepared OCI image");
      if (request.ssh_user && request.ssh_user !== defaultSSHUser) throw new Error("The exe.dev image uses the boxhaven SSH user");
      name = exeDevResourceName(request.provider_name || request.name);
      plan = (await this.listPlans()).find(p => p.slug === (request.provider_size || sizes.small))!;
      if (!plan) throw new Error("Unknown exe.dev size");
      setup = agentSetupScript(request);
      if ((await this.listVMs()).some(vm => vm.vm_name === name)) throw new Error(`exe.dev VM for ${request.name} already exists`);
    } catch (error) { throw new MachineCreateError((error as Error).message, "not_created"); }
    let created: VM;
    try {
      const command = [
        "new", "--json", `--name=${name}`, `--image=${JSON.stringify(this.config.image)}`,
        ...(this.config.registryAuth ? [`--registry-auth=${JSON.stringify(this.config.registryAuth)}`] : []),
        `--cpu=${plan.vcpus}`, `--memory=${plan.memory_mb/1024}GB`, `--disk=${plan.disk_gb}GB`,
        "--tag=boxhaven", "--no-email", "--setup-script=/dev/stdin",
      ].join(" ");
      const output = await (this.config.ssh || ((command, setup) => exeDevSSHCommand(this.config.signingKey, command, setup)))(command, setup);
      try { created = JSON.parse(output) as VM; }
      catch { throw new Error("exe.dev returned invalid creation metadata"); }
      if (created.vm_name !== name) throw new Error("exe.dev returned an unexpected VM identity");
      // Change only the destination port. Keep the provider's default private visibility.
      await this.command(`share port ${name} 80`);
    } catch (error) {
      // Timeout, malformed success, or a failed post-create operation may leave
      // a billable VM. Preserve the core recovery reservation; never retry new.
      throw new MachineCreateError((error as Error).message, "unknown");
    }
    return { machine: { ...this.machine(created), name: request.name, provider_name: request.provider_name || request.name, size: plan.slug, image: this.config.image, bootstrap_complete: true }, status: created.status || "created" };
  }

  async getMachine(machine: RemoteMachine) {
    const vm = (await this.listVMs()).find(candidate => candidate.vm_name === this.vmName(machine));
    if (!vm) throw new Error(`exe.dev VM for ${machine.name} was not found`);
    return { machine: { ...this.machine(vm), name: machine.name, provider_name: machine.provider_name }, status: vm.status };
  }

  async listMachines(request: ListProviderMachinesRequest) {
    if (!request.provider_name_suffix) return [];
    const suffix = `-${request.provider_name_suffix}`;
    return (await this.listVMs()).filter(vm => vm.vm_name.startsWith("boxhaven-") && vm.vm_name.endsWith(suffix) && vm.tags?.includes("boxhaven"))
      .map(vm => ({ machine: { ...this.machine(vm), name: vm.vm_name.slice(9, -suffix.length), provider_name: vm.vm_name.slice(9) }, status: vm.status }));
  }

  async releaseMachine(machine: RemoteMachine) {
    const name = this.vmName(machine);
    if (!(await this.listVMs()).some(vm => vm.vm_name === name)) return;
    await this.command(`rm ${name}`);
    if ((await this.listVMs()).some(vm => vm.vm_name === name)) throw new Error("exe.dev has not confirmed VM deletion; retry destruction to reconcile");
  }

  async issueSSHAccess(machine: RemoteMachine, expiresAt: string): Promise<SSHAccess> {
    const name = this.vmName(machine);
    const token = await exeDevToken(this.config.signingKey, `v0@${name}.exe.xyz`, { exp: Math.floor(Date.parse(expiresAt)/1000) });
    return { kind: "websocket", url: `wss://${name}.exe.xyz:9898/ssh`, headers: { "X-Exedev-Authorization": `Bearer ${token}` }, expires_at: expiresAt };
  }

  private machine(vm: VM): RemoteMachine {
    if (!validVMName(vm.vm_name)) throw new Error("exe.dev returned an invalid VM name");
    return { name: vm.vm_name, provider: this.name, provider_id: vm.vm_name, ssh_transport: "websocket", ssh_user: defaultSSHUser,
      region: vm.region, image: vm.image, created_at: vm.created_at, preview_transport: "provider", preview_url: `https://${vm.vm_name}.exe.xyz` };
  }
  private vmName(machine: RemoteMachine): string {
    const name = machine.provider_id || exeDevResourceName(machine.provider_name || machine.name);
    if (!validVMName(name) || !name.startsWith("boxhaven-")) throw new Error("Invalid exe.dev VM identity");
    return name;
  }
  private async listVMs(): Promise<VM[]> {
    const result = await this.command<{ vms: VM[] }>("ls -l");
    if (!Array.isArray(result.vms) || result.vms.some(vm => !vm || !validVMName(vm.vm_name))) throw new Error("exe.dev returned an invalid VM inventory");
    return result.vms;
  }
  private async command<T>(command: string): Promise<T> {
    const token = await exeDevToken(this.config.signingKey, "v0@exe.dev", { exp: Math.floor(Date.now()/1000)+60, cmds: ["ls", "rm", "share port"] });
    const response = await (this.config.fetch || fetch)("https://exe.dev/exec", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" }, body: command, redirect: "error", signal: AbortSignal.timeout(35000),
    }).catch(() => { throw new Error("exe.dev API connection failed or timed out"); });
    // Never include request/response bodies: setup scripts contain agent credentials.
    if (!response.ok) { await response.body?.cancel(); throw new Error(`exe.dev API returned HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("exe.dev returned an empty response");
    const chunks: Uint8Array[]=[]; let size=0;
    try {
      for (;;) { const {done,value}=await reader.read(); if(done) break; size+=value.length; if(size>1048576) throw new Error("exe.dev response exceeds 1 MiB"); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch { throw new Error("exe.dev returned an invalid or oversized response"); }
    finally { await reader.cancel(); }
  }
}

function validVMName(name: unknown): name is string { return typeof name === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name); }
export function exeDevResourceName(value: string): string {
  const clean = sanitizeResourceName(value);
  const suffix = clean.match(/-[a-f0-9]{10}$/)?.[0] || "";
  const stem = suffix ? clean.slice(0, -suffix.length) : clean;
  return `boxhaven-${stem.slice(0, 54-suffix.length).replace(/-+$/, "")}${suffix}`;
}
export function exeDevProviderFromEnv(env = process.env): ExeDevProvider {
  return new ExeDevProvider({ signingKey: env.EXE_DEV_SIGNING_KEY?.trim() || "", image: env.BOXHAVEN_REMOTE_IMAGE_EXEDEV?.trim() || "", registryAuth: env.EXE_DEV_REGISTRY_AUTH });
}
