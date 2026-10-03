import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { SandboxAccessCache, SandboxProvider, sandboxPlan, sandboxResourceName } from "./sandbox_provider.js";
import type { SandboxRecord } from "./sandbox_provider.js";
import { sandboxSetupScript } from "./cloudinit.js";
import { MachineCreateError } from "./types.js";
import type { CreateMachineRequest, MachineProviderInfo, RemoteMachine } from "./types.js";

const request: CreateMachineRequest = { name: "test", provider_name: "test-0123456789", agent_token: "secret'$(touch /tmp/nope)", agent_backend_url: "https://backend.example", ssh_user_ca_public_key: "ssh-ed25519 ABCD", ssh_authorized_principal: "principal" };
class FakeProvider extends SandboxProvider {
  readonly name = "sandbox"; readonly label = "Sandbox";
  readonly info: MachineProviderInfo = { name: this.name, label: this.label, capabilities: ["create", "destroy", "list", "connect"], default_sizes: { small: "test", medium: "test", large: "test" } };
  records: SandboxRecord[] = []; created = 0; deleted = 0; failBootstrap = false; failProvision = false; retainDeleted = false;
  constructor() { super("prepared"); }
  async listPlans() { return [sandboxPlan(this.name, "test", 2, 4096, 10)]; }
  protected async inventory() { return this.records; }
  protected async inspect(id: string) { return this.records.find(s => s.id === id); }
  protected async provision(name: string, labels: Record<string, string>) { this.created++; if (this.failProvision) throw new Error("credentials secret"); const record = { id: name, labels }; this.records.push(record); return record; }
  protected async bootstrap() { if (this.failBootstrap) throw new Error("setup secret"); }
  protected async remove(id: string) { this.deleted++; if (!this.retainDeleted) this.records = this.records.filter(s => s.id !== id); }
  protected async portAccess() { return { url: "https://private.example", headers: { "X-Private": "secret" } }; }
}
test("sandbox inventory and destruction honor immutable team ownership", async () => {
  const provider = new FakeProvider();
  const { machine } = await provider.createMachine(request);
  assert.equal(machine.preview_target_port, 8081);
  assert.equal(machine.ssh_transport, "websocket");
  assert.equal(machine.bootstrap_complete, true);
  assert.equal(JSON.stringify(machine).includes("secret"), false);
  provider.records.push({ id: "unmanaged", labels: { boxhaven_team: "0123456789" } });
  assert.equal((await provider.listMachines({ provider_name_suffix: "0123456789" })).length, 1);
  assert.equal((await provider.listMachines({ provider_name_suffix: "9876543210" })).length, 0);
  assert.equal((await provider.listMachines({})).length, 0);
  await assert.rejects(provider.releaseMachine({ ...machine, provider_name: "someone-9876543210" }), /ownership/);
  await assert.rejects(provider.releaseMachine({ ...machine, provider_id: "unmanaged" }), /ownership/);
  assert.equal(provider.deleted, 0);
  provider.retainDeleted = true;
  await assert.rejects(provider.releaseMachine(machine), /not confirmed deletion/);
  provider.retainDeleted = false;
  await provider.releaseMachine(machine);
  await provider.releaseMachine(machine);
  assert.equal(provider.deleted, 2);
});
test("sandbox validation cannot create resources; ambiguous failures preserve recovery without exposing credentials", async () => {
  const provider = new FakeProvider();
  for (const invalid of [{ region: "elsewhere" }, { image: "unprepared" }, { provider_name: "missing-team" }, { provider_size: "unknown" }, { agent_token: "" }]) {
    await assert.rejects(provider.createMachine({ ...request, ...invalid }), e => e instanceof MachineCreateError && e.outcome === "not_created");
  }
  assert.equal(provider.created, 0);
  provider.failProvision = true;
  await assert.rejects(provider.createMachine(request), e => e instanceof MachineCreateError && e.outcome === "unknown" && !e.message.includes("secret"));
  provider.failProvision = false; provider.failBootstrap = true;
  await assert.rejects(provider.createMachine(request), e => e instanceof MachineCreateError && e.outcome === "unknown" && !e.message.includes("secret"));
  assert.equal((await provider.listMachines({ provider_name_suffix: "0123456789" })).length, 1);
  await provider.releaseMachine({ name: request.name, provider: provider.name, provider_name: request.provider_name });
  assert.equal(provider.records.length, 0, "ambiguous creates can be reconciled without knowing the native ID");
});
test("sandbox names preserve the ownership suffix within the shortest provider limit", () => {
  const name = sandboxResourceName("very-long-name-".repeat(10) + "0123456789");
  assert.ok(name.length <= 49); assert.match(name, /-0123456789$/);
});
test("runtime bootstrap is valid shell and does not execute credential substitutions", () => {
  const script = sandboxSetupScript(request);
  execFileSync("bash", ["-n"], { input: script });
  assert.ok(script.includes("flock -n"));
  assert.ok(script.includes("AuthorizedKeysFile none"));
  assert.ok(script.includes("chmod 0600 /etc/boxhaven/agent.env"));
  assert.ok(!script.includes("apt-get"));
});
test("access cache coalesces concurrent calls and retries failures", async () => {
  const cache = new SandboxAccessCache<number>(); let calls = 0;
  const create = async () => ++calls;
  const values = await Promise.all(Array.from({ length: 20 }, () => cache.get("box", Date.now()+120_000, create)));
  assert.deepEqual(new Set(values), new Set([1]));
  await assert.rejects(cache.get("bad", Date.now()+120_000, async () => { throw new Error("transient"); }));
  assert.equal(await cache.get("bad", Date.now()+120_000, create), 2);
  cache.delete("box"); assert.equal(await cache.get("box", Date.now()+120_000, create), 3);
});
