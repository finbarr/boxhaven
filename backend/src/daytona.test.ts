import assert from "node:assert/strict";
import test from "node:test";
import { SandboxApi } from "@daytona/api-client";
import { FileSystemApi, ProcessApi } from "@daytona/toolbox-api-client";
import { DaytonaProvider } from "./daytona.js";
import { MachineCreateError } from "./types.js";

test("Daytona uses a prepared private runtime, disables idle destruction, and confirms deletion", async t => {
  let deleted = false;
  const commands: string[] = [];
  const labels = { boxhaven: "true", boxhaven_team: "0123456789", boxhaven_name: "work", boxhaven_provider_name: "work-0123456789" };
  const sandbox = { id: "sandbox-id", labels, state: "started", snapshot: "prepared", public: false, toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox" };
  t.mock.method(SandboxApi.prototype, "listSandboxes", async () => ({ data: { items: [], nextCursor: null } }));
  t.mock.method(SandboxApi.prototype, "createSandbox", async (params: Record<string, any>) => {
    assert.deepEqual([params.public, params.autoStopInterval, params.autoPauseInterval, params.autoDeleteInterval, params.ttlMinutes], [false, 0, 0, -1, 0]);
    assert.deepEqual([params.cpu, params.memory, params.disk], [2, 4, 10]);
    assert.equal(params.user, "root");
    assert.match(params.buildInfo.dockerfileContent, /FROM prepared/);
    assert.match(params.buildInfo.dockerfileContent, /ENTRYPOINT.*sleep.*infinity/);
    assert.doesNotMatch(params.buildInfo.dockerfileContent, /RUN/);
    return { data: sandbox };
  });
  t.mock.method(SandboxApi.prototype, "getSandbox", async () => { if (deleted) throw { response: { status: 404 } }; return { data: sandbox }; });
  t.mock.method(SandboxApi.prototype, "deleteSandbox", async () => { deleted = true; });
  t.mock.method(SandboxApi.prototype, "getPortPreviewUrl", async (_id: string, port: number) => ({ data: { url: `https://${port}-sandbox.example`, token: "resource-secret" } }));
  t.mock.method(FileSystemApi.prototype, "uploadFiles", async (options: { data: FormData }) => {
    assert.equal(options.data.get("files[0].path"), "/root/boxhaven-setup.sh");
    assert.match(await (options.data.get("files[0].file") as Blob).text(), /chmod 0600/);
  });
  t.mock.method(ProcessApi.prototype, "executeCommand", async (params: { command: string }) => { commands.push(params.command); return { data: { exitCode: 0 } }; });
  const provider = new DaytonaProvider({ apiKey: "account-secret", image: "prepared" });
  const { machine } = await provider.createMachine({ name: "work", provider_name: "work-0123456789", agent_token: "guest-secret", agent_backend_url: "https://backend.example", ssh_user_ca_public_key: "ssh-ed25519 ABCD", ssh_authorized_principal: "principal" });
  assert.equal(machine.bootstrap_complete, true);
  assert.equal(commands.length, 3);
  assert.match(commands[0], /chmod 0600.*bash.*rm/);
  assert.match(commands[1], /curl.*BOXHAVEN_AGENT_BACKEND_URL/);
  assert.match(commands[2], /nohup.*run-sandbox/);
  const access = await provider.issueSSHAccess(machine, new Date(Date.now() + 900_000).toISOString());
  assert.equal(access.kind, "websocket");
  if (access.kind !== "websocket") throw new Error("wrong transport");
  assert.deepEqual(access.headers, { "x-daytona-preview-token": "resource-secret", "X-Daytona-Skip-Preview-Warning": "true" });
  assert.equal(access.url, "wss://9898-sandbox.example/ssh");
  await provider.releaseMachine(machine);
  assert.equal(deleted, true);
});

test("Daytona keeps a recovery reservation and reports blocked backend access before launching", async t => {
  const labels = { boxhaven: "true", boxhaven_team: "0123456789", boxhaven_name: "work", boxhaven_provider_name: "work-0123456789" };
  const sandbox = { id: "sandbox-id", labels, state: "started", public: false, toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox" };
  const commands: string[] = [];
  t.mock.method(SandboxApi.prototype, "listSandboxes", async () => ({ data: { items: [] } }));
  t.mock.method(SandboxApi.prototype, "createSandbox", async () => ({ data: sandbox }));
  t.mock.method(SandboxApi.prototype, "getSandbox", async () => ({ data: sandbox }));
  t.mock.method(FileSystemApi.prototype, "uploadFiles", async () => ({}));
  t.mock.method(ProcessApi.prototype, "executeCommand", async (params: { command: string }) => {
    commands.push(params.command);
    return { data: { exitCode: commands.length === 1 ? 0 : 35, result: "private provider diagnostics" } };
  });
  const provider = new DaytonaProvider({ apiKey: "account-secret", image: "prepared" });
  await assert.rejects(provider.createMachine({ name: "work", provider_name: "work-0123456789", agent_token: "guest-secret", agent_backend_url: "https://backend.example", ssh_user_ca_public_key: "ssh-ed25519 ABCD", ssh_authorized_principal: "principal" }), error => {
    assert.ok(error instanceof MachineCreateError);
    assert.equal(error.outcome, "unknown");
    assert.match(error.message, /Daytona cannot reach the BoxHaven backend.*network policy/);
    assert.doesNotMatch(error.message, /private provider diagnostics|account-secret|guest-secret/);
    return true;
  });
  assert.equal(commands.length, 2);
  assert.ok(commands.every(command => !command.includes("nohup")));
});
