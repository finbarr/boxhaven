import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { createBackendAuth, migrateBackendAuth } from "./auth.js";
import { ProviderRegistry } from "./providers.js";
import { StateStore } from "./state.js";
import { createBackend } from "./server.js";
import { SSHCertificateAuthority } from "./ssh_ca.js";
import { CreateMachineRequest, MachineImage, MachineProvider, RemoteMachine, defaultSSHUser } from "./types.js";

const testSSHUserPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBxsqJzPGdcbwFthXVe2lyIImV6BwTw4Ee5WcoeczwJf test";

class FakeProvider implements MachineProvider {
  readonly name: string;
  readonly label: string;
  created: CreateMachineRequest[] = [];
  released: string[] = [];
  discovered: RemoteMachine[] = [];
  images: MachineImage[] = [];
  snapshotted: Array<{ machine: string; name: string }> = [];
  deletedImages: string[] = [];
  publicIPv4 = "203.0.113.10";

  constructor(name = "fake", label = "Fake Cloud") {
    this.name = name;
    this.label = label;
  }

  async createMachine(request: CreateMachineRequest) {
    this.created.push(request);
    return {
      status: "created",
      machine: {
        name: request.name,
        provider_name: request.provider_name,
        provider: this.name,
        provider_id: `fake-${request.provider_name || request.name}`,
        public_ipv4: this.publicIPv4,
        ssh_user: request.ssh_user || defaultSSHUser,
        bootstrap_complete: true,
      },
    };
  }

  async getMachine(machine: RemoteMachine) {
    return {
      status: "active",
      machine: {
        ...machine,
        public_ipv4: machine.public_ipv4 || this.publicIPv4,
      },
    };
  }

  failList = false;

  async listMachines() {
    if (this.failList) throw new Error(`${this.name} API is unavailable`);
    return this.discovered.map((machine) => ({
      status: "active",
      machine: {
        provider: this.name,
        ssh_user: defaultSSHUser,
        ...machine,
      },
    }));
  }

  async releaseMachine(machine: RemoteMachine) {
    this.released.push(machine.name);
  }

  async listImages() {
    return this.images;
  }

  async createImage(machine: RemoteMachine, name: string) {
    this.snapshotted.push({ machine: machine.name, name });
    return { id: `img-${this.snapshotted.length}`, name, status: "creating" };
  }

  async deleteImage(imageID: string) {
    this.deletedImages.push(imageID);
  }
}

test("backend creates, records, lists, and releases one machine", async () => {
  const { app, provider, token } = await createTestBackend();

  const unauthorized = await app.inject({ method: "GET", url: "/v1/machines" });
  assert.equal(unauthorized.statusCode, 401);

  const headers = { authorization: `Bearer ${token}` };
  const created = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: {
      name: "Foo",
      ssh_user: "ubuntu",
      tier: "Medium",
      source_path: "/Users/example/project",
      repo_url: "git@example.com:repo.git",
      branch: "main",
    },
  });
  assert.equal(created.statusCode, 201);
  const createBody = created.json();
  assert.equal(createBody.machine.name, "foo");
  assert.equal(createBody.machine.user_id.length > 0, true);
  assert.match(createBody.machine.provider_name, /^foo-[a-f0-9]{10}$/);
  assert.match(createBody.machine.preview_hostname, /^[a-z0-9]+-[a-z0-9]+-[a-f0-9]{6}\.hosted\.test$/);
  assert.equal(createBody.machine.preview_url, `https://${createBody.machine.preview_hostname}`);
  assert.equal(createBody.machine.project_path, "/opt/boxhaven/project");
  assert.equal(createBody.machine.agent_token_hash, undefined);
  assert.match(createBody.machine.ssh_principal, /^boxhaven:foo-[a-f0-9]{10}$/);
  assert.equal(provider.created.length, 1);
  assert.equal(provider.created[0].tier, "medium");
  assert.match(provider.created[0].agent_token || "", /^[A-Za-z0-9_-]{64}$/);
  assert.equal(provider.created[0].agent_backend_url, "https://api.hosted.test");
  assert.match(provider.created[0].ssh_user_ca_public_key || "", /^ssh-ed25519 /);
  assert.equal(provider.created[0].ssh_authorized_principal, createBody.machine.ssh_principal);

  const recorded = await app.inject({
    method: "POST",
    url: "/v1/machines/foo/commands/record",
    headers,
    payload: { command: ["codex"] },
  });
  assert.equal(recorded.statusCode, 200);
  assert.deepEqual(recorded.json().machine.last_command, ["codex"]);
  assert.equal(recorded.json().machine.bootstrap_complete, true);
  assert.equal(recorded.json().machine.preview_hostname, createBody.machine.preview_hostname);

  const listed = await app.inject({ method: "GET", url: "/v1/machines", headers });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().machines.length, 1);
  assert.equal(listed.json().machines[0].name, "foo");
  assert.equal(listed.json().machines[0].provider_label, "Fake Cloud");
  assert.equal(listed.json().machines[0].agent_token_hash, undefined);

  const fetched = await app.inject({ method: "GET", url: "/v1/machines/foo", headers });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().status, "active");

  const deleted = await app.inject({ method: "DELETE", url: "/v1/machines/foo", headers });
  assert.equal(deleted.statusCode, 204);
  assert.deepEqual(provider.released, ["foo"]);
});

test("backend authenticates machine agents only by opaque token", async () => {
  const { app, provider, token } = await createTestBackend();
  const created = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "foo" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const agentToken = provider.created[0].agent_token || "";
  assert.match(agentToken, /^[A-Za-z0-9_-]{64}$/);

  const spoofedName = await app.inject({
    method: "POST",
    url: "/v1/agent/heartbeat?name=not-foo",
    headers: { authorization: `Bearer ${agentToken}` },
  });
  assert.equal(spoofedName.statusCode, 200, spoofedName.body);
  assert.equal(spoofedName.json().machine.name, "foo");
  assert.equal(typeof spoofedName.json().machine.agent_last_seen_at, "string");
  assert.equal(spoofedName.json().machine.agent_token_hash, undefined);

  const guessedName = await app.inject({
    method: "POST",
    url: "/v1/agent/heartbeat",
    headers: { authorization: "Bearer foo" },
  });
  assert.equal(guessedName.statusCode, 401, guessedName.body);
});

test("backend waits for a created machine to trust SSH certificates before returning", async () => {
  const { app, provider, token } = await createTestBackend("ready@example.com", "password123", { machineReadyTimeoutMs: 2000 });
  const headers = { authorization: `Bearer ${token}` };
  const create = app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: { name: "foo" },
  });

  for (let i = 0; i < 50 && provider.created.length === 0; i++) {
    await delay(10);
  }
  const agentToken = provider.created[0]?.agent_token || "";
  assert.match(agentToken, /^[A-Za-z0-9_-]{64}$/);

  for (let i = 0; i < 50; i++) {
    const fetched = await app.inject({ method: "GET", url: "/v1/machines/foo", headers });
    if (fetched.statusCode === 200) break;
    await delay(10);
  }

  await app.ready();
  const agent = await app.injectWS("/v1/agent/connect", { headers: { authorization: `Bearer ${agentToken}`, host: "127.0.0.1" } });
  const setupRPC = JSON.parse((await nextWSMessage(agent)).toString());
  assert.equal(setupRPC.type, "rpc");
  assert.equal(setupRPC.action, "run_setup");
  assert.match(setupRPC.payload.commands[0], /cloud-init status --wait/);
  assert.match(setupRPC.payload.commands[0], /TrustedUserCAKeys \/etc\/ssh\/boxhaven_user_ca_keys/);
  assert.match(setupRPC.payload.commands[0], /AuthorizedPrincipalsFile \/etc\/ssh\/auth_principals\/%u/);
  assert.match(setupRPC.payload.commands[0], /boxhaven:foo-/);
  agent.send(JSON.stringify({
    type: "rpc_result",
    rpc_id: setupRPC.rpc_id,
    ok: true,
    result: { stdout: "", stderr: "" },
  }));
  const created = await create;
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(typeof created.json().machine.agent_last_seen_at, "string");
  agent.terminate();
});

test("backend signs short-lived SSH certificates for owned machines", async () => {
  const { app, provider, token } = await createTestBackend();
  const created = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "foo" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const agentToken = provider.created[0].agent_token || "";
  assert.match(agentToken, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(provider.created[0].ssh_authorized_principal, created.json().machine.ssh_principal);

  const cert = await app.inject({
    method: "POST",
    url: "/v1/machines/foo/ssh-cert",
    headers: { authorization: `Bearer ${token}` },
    payload: { public_key: testSSHUserPublicKey },
  });
  assert.equal(cert.statusCode, 200, cert.body);
  assert.match(cert.json().certificate, /^ssh-ed25519-cert-v01@openssh.com /);
  assert.equal(cert.json().principal, created.json().machine.ssh_principal);
  assert.equal(cert.json().host, "203.0.113.10");
  assert.equal(cert.json().ssh_user, defaultSSHUser);
});

test("backend signs SSH certificates without a connected machine agent", async () => {
  const { app, token } = await createTestBackend();
  const created = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "foo" },
  });
  assert.equal(created.statusCode, 201, created.body);

  const cert = await app.inject({
    method: "POST",
    url: "/v1/machines/foo/ssh-cert",
    headers: { authorization: `Bearer ${token}` },
    payload: { public_key: testSSHUserPublicKey },
  });
  assert.equal(cert.statusCode, 200, cert.body);
  assert.match(cert.json().certificate, /^ssh-ed25519-cert-v01@openssh.com /);
});

test("backend delegates session lifecycle to the machine agent", async () => {
  const { app, provider, token } = await createTestBackend();
  const headers = { authorization: `Bearer ${token}` };
  const created = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: { name: "foo" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const agentToken = provider.created[0].agent_token || "";

  await app.ready();
  const agent = await app.injectWS("/v1/agent/connect", { headers: { authorization: `Bearer ${agentToken}`, host: "127.0.0.1" } });

  const sessionRequest = app.inject({
    method: "POST",
    url: "/v1/machines/foo/sessions/boxhaven/prepare",
    headers,
    payload: { command: ["codex"], attach: true },
  });
  const sessionRPC = JSON.parse((await nextWSMessage(agent)).toString());
  assert.equal(sessionRPC.type, "rpc");
  assert.equal(sessionRPC.action, "prepare_session");
  assert.deepEqual(sessionRPC.payload.command, ["codex"]);
  assert.equal(sessionRPC.payload.ssh_user, defaultSSHUser);
  assert.equal(sessionRPC.payload.preview_url, created.json().machine.preview_url);
  assert.equal(sessionRPC.payload.preview_hostname, created.json().machine.preview_hostname);
  assert.equal(sessionRPC.payload.preview_target_port, 80);
  assert.equal(sessionRPC.payload.preview_bind_host, "0.0.0.0");
  assert.equal(sessionRPC.payload.attach, true);
  agent.send(JSON.stringify({
    type: "rpc_result",
    rpc_id: sessionRPC.rpc_id,
    ok: true,
    result: { status: "started", attach_command: "tmux set-option -g mouse on >/dev/null 2>&1 || true; tmux attach-session -t 'boxhaven'", record_command: true },
  }));
  const session = await sessionRequest;
  assert.equal(session.statusCode, 200, session.body);
  assert.equal(session.json().result.attach_command, "tmux set-option -g mouse on >/dev/null 2>&1 || true; tmux attach-session -t 'boxhaven'");

  const fetched = await app.inject({ method: "GET", url: "/v1/machines/foo", headers });
  assert.deepEqual(fetched.json().machine.last_command, ["codex"]);

  agent.terminate();
});

test("backend has no user-callable workspace preparation endpoint", async () => {
  const { app, token } = await createTestBackend();
  const response = await app.inject({
    method: "POST",
    url: "/v1/machines/foo/workspace",
    headers: { authorization: `Bearer ${token}` },
    payload: { source_path: "/Users/example/project" },
  });
  assert.equal(response.statusCode, 404);
});

test("backend rejects duplicate machine creates", async () => {
  const { app, provider, token } = await createTestBackend();
  const headers = { authorization: `Bearer ${token}` };

  const first = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: { name: "foo" },
  });
  assert.equal(first.statusCode, 201, first.body);

  const duplicate = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: { name: "foo" },
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.match(duplicate.body, /remote machine foo already exists/);
  assert.equal(provider.created.length, 1);
});

test("backend renames machine records without changing provider identity", async () => {
  const { app, provider, token } = await createTestBackend();
  const headers = { authorization: `Bearer ${token}` };

  const created = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: { name: "foo" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const original = created.json().machine;

  const renamed = await app.inject({
    method: "PATCH",
    url: "/v1/machines/foo",
    headers,
    payload: { name: "bar" },
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().machine.name, "bar");
  assert.equal(renamed.json().machine.provider_name, original.provider_name);
  assert.equal(renamed.json().machine.provider_id, original.provider_id);
  assert.equal(renamed.json().machine.preview_hostname, original.preview_hostname);
  assert.equal(renamed.json().machine.ssh_principal, original.ssh_principal);

  const oldFetch = await app.inject({ method: "GET", url: "/v1/machines/foo", headers });
  assert.equal(oldFetch.statusCode, 404, oldFetch.body);

  const newFetch = await app.inject({ method: "GET", url: "/v1/machines/bar", headers });
  assert.equal(newFetch.statusCode, 200, newFetch.body);
  assert.equal(newFetch.json().machine.name, "bar");
  assert.equal(newFetch.json().machine.provider_name, original.provider_name);

  const listed = await app.inject({ method: "GET", url: "/v1/machines", headers });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().machines.map((machine: RemoteMachine) => machine.name), ["bar"]);

  const duplicate = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: { name: "bar" },
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.equal(provider.created.length, 1);
});

test("backend rejects rename collisions", async () => {
  const { app, token } = await createTestBackend();
  const headers = { authorization: `Bearer ${token}` };

  assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "foo" } })).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "bar" } })).statusCode, 201);

  const renamed = await app.inject({
    method: "PATCH",
    url: "/v1/machines/foo",
    headers,
    payload: { name: "bar" },
  });
  assert.equal(renamed.statusCode, 409, renamed.body);
  assert.match(renamed.body, /remote machine bar already exists/);
});

test("backend rejects unknown machine tiers", async () => {
  const { app, token } = await createTestBackend();
  const response = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      name: "foo",
      tier: "enormous",
    },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.body, /invalid machine tier/);
});

test("backend imports provider machines for the authenticated user", async () => {
  const { app, provider, token } = await createTestBackend();
  const headers = { authorization: `Bearer ${token}` };
  const user = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers });
  assert.equal(user.statusCode, 200);
  const suffix = hashUserID(user.json().user.id);

  provider.discovered = [{
    name: "already-there",
    provider_name: `already-there-${suffix}`,
    provider: provider.name,
    provider_id: "fake-imported",
    public_ipv4: "203.0.113.20",
  }];

  const listed = await app.inject({ method: "GET", url: "/v1/machines", headers });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().machines.length, 1);
  assert.equal(listed.json().machines[0].name, "already-there");

  const fetched = await app.inject({ method: "GET", url: "/v1/machines/already-there", headers });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().machine.public_ipv4, "203.0.113.20");

  const connect = await app.inject({ method: "GET", url: "/v1/machines/already-there/connect", headers });
  assert.equal(connect.statusCode, 200);
  assert.equal(connect.json().connect.transport, "direct_ssh_certificate");
  assert.equal(connect.json().connect.cli, "bh connect already-there");
  assert.equal(connect.json().connect.cli_run, "bh run already-there");
});

test("backend rejects creates that collide with provider-owned machines", async () => {
  const { app, provider, token } = await createTestBackend();
  const headers = { authorization: `Bearer ${token}` };
  const user = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers });
  assert.equal(user.statusCode, 200);
  const suffix = hashUserID(user.json().user.id);

  provider.discovered = [{
    name: "already-there",
    provider_name: `already-there-${suffix}`,
    provider: provider.name,
    provider_id: "fake-imported",
    public_ipv4: "203.0.113.20",
  }];

  const response = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: { name: "already-there" },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.body, /remote machine already-there already exists/);
  assert.equal(provider.created.length, 0);
});

test("backend auth supports multiple users with isolated machine names", async () => {
  const { app, provider, token } = await createTestBackend("first@example.com");
  const secondToken = await signUp(app, "second@example.com");

  const firstHeaders = { authorization: `Bearer ${token}` };
  const secondHeaders = { authorization: `Bearer ${secondToken}` };

  const firstCreate = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers: firstHeaders,
    payload: { name: "foo" },
  });
  assert.equal(firstCreate.statusCode, 201);

  const secondListBefore = await app.inject({ method: "GET", url: "/v1/machines", headers: secondHeaders });
  assert.equal(secondListBefore.statusCode, 200);
  assert.equal(secondListBefore.json().machines.length, 0);

  const secondFetchBefore = await app.inject({ method: "GET", url: "/v1/machines/foo", headers: secondHeaders });
  assert.equal(secondFetchBefore.statusCode, 404);

  const secondCreate = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers: secondHeaders,
    payload: { name: "foo" },
  });
  assert.equal(secondCreate.statusCode, 201);
  assert.notEqual(firstCreate.json().machine.user_id, secondCreate.json().machine.user_id);
  assert.notEqual(firstCreate.json().machine.provider_name, secondCreate.json().machine.provider_name);
  assert.equal(provider.created.length, 2);
});

test("backend registers preview hostnames and proxies them to the machine", async () => {
  let previewHost = "";
  const upstream = createServer((request, response) => {
    assert.equal(request.headers["x-forwarded-host"], previewHost);
    response.setHeader("content-type", "text/plain");
    response.end(`preview:${request.url}`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const address = upstream.address();
    assert.equal(typeof address, "object");
    const { app, provider, token } = await createTestBackend("preview@example.com", "password123", { previewTargetPort: (address as AddressInfo).port });
    provider.publicIPv4 = "127.0.0.1";
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers,
      payload: { name: "preview" },
    });
    assert.equal(created.statusCode, 201, created.body);
    previewHost = created.json().machine.preview_hostname;
    assert.equal(created.json().machine.preview_url, `https://${previewHost}`);

    const tlsCheck = await app.inject({ method: "GET", url: `/v1/preview/tls-check?domain=${encodeURIComponent(previewHost)}` });
    assert.equal(tlsCheck.statusCode, 200, tlsCheck.body);

    const unknownTLSCheck = await app.inject({ method: "GET", url: "/v1/preview/tls-check?domain=missing.hosted.test" });
    assert.equal(unknownTLSCheck.statusCode, 404);

    const proxied = await app.inject({ method: "GET", url: `/v1/preview/proxy/${previewHost}/hello?x=1` });
    assert.equal(proxied.statusCode, 200, proxied.body);
    assert.equal(proxied.headers["x-boxhaven-preview-machine"], "preview");
    assert.equal(proxied.body, "preview:/hello?x=1");
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("backend proxies preview websocket upgrades to the machine", async () => {
  let previewHost = "";
  const upstreamServer = createServer();
  const upstream = new WebSocketServer({ server: upstreamServer });
  upstream.on("connection", (socket, request) => {
    assert.equal(request.headers["x-forwarded-host"], previewHost);
    assert.equal(request.headers["x-forwarded-proto"], "https");
    assert.equal(request.url, "/hmr?token=1");
    socket.send("ready");
    socket.on("message", (message) => socket.send(`echo:${message.toString()}`));
  });
  await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = upstreamServer.address();
    assert.equal(typeof address, "object");
    const { app, provider, token } = await createTestBackend("preview-ws@example.com", "password123", { previewTargetPort: (address as AddressInfo).port });
    provider.publicIPv4 = "127.0.0.1";
    const created = await app.inject({
      method: "POST",
      url: "/v1/machines",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "preview-ws" },
    });
    assert.equal(created.statusCode, 201, created.body);
    previewHost = created.json().machine.preview_hostname;

    const client = await app.injectWS(`/v1/preview/proxy/${previewHost}/hmr?token=1`);
    assert.equal((await nextWSMessageWithTimeout(client)).toString(), "ready");
    client.send("ping");
    assert.equal((await nextWSMessageWithTimeout(client)).toString(), "echo:ping");
    client.terminate();
  } finally {
    for (const socket of upstream.clients) socket.terminate();
    upstream.close();
    await new Promise<void>((resolve, reject) => upstreamServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("backend warms preview TLS before returning created machines", async () => {
  const warmed: string[] = [];
  const { app, token } = await createTestBackend("preview-warmup@example.com", "password123", {
    previewTLSWarmup: async (url) => {
      warmed.push(url);
    },
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers: { authorization: `Bearer ${token}` },
    payload: { name: "preview-warmup" },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(warmed, [created.json().machine.preview_url]);
});

test("backend login and logout are handled by Better Auth", async () => {
  const { app, token } = await createTestBackend("login@example.com", "correct horse battery staple");

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-in/email",
    payload: {
      email: "login@example.com",
      password: "correct horse battery staple",
    },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(typeof login.json().token, "string");

  const whoami = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers: { authorization: `Bearer ${login.json().token}` } });
  assert.equal(whoami.statusCode, 200);
  assert.equal(whoami.json().user.email, "login@example.com");

  const logout = await app.inject({ method: "POST", url: "/v1/auth/sign-out", headers: { authorization: `Bearer ${token}` } });
  assert.equal(logout.statusCode, 200);

  const afterLogout = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers: { authorization: `Bearer ${token}` } });
  assert.equal(afterLogout.statusCode, 401);
});

test("backend supports browser-approved CLI device login", async () => {
  const { app, token } = await createTestBackend("cli@example.com");

  const code = await app.inject({
    method: "POST",
    url: "/v1/auth/device/code",
    payload: {
      client_id: "boxhaven-cli",
      scope: "remote",
    },
  });
  assert.equal(code.statusCode, 200, code.body);
  const device = code.json();
  assert.equal(typeof device.device_code, "string");
  assert.equal(typeof device.user_code, "string");
  assert.match(device.verification_uri_complete, /\/device\?user_code=/);

  const headers = { authorization: `Bearer ${token}` };
  const verified = await app.inject({
    method: "GET",
    url: `/v1/auth/device?user_code=${encodeURIComponent(device.user_code)}`,
    headers,
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json().status, "pending");

  const approved = await app.inject({
    method: "POST",
    url: "/v1/auth/device/approve",
    headers,
    payload: { userCode: device.user_code },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().success, true);

  const exchanged = await app.inject({
    method: "POST",
    url: "/v1/auth/device/token",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: "boxhaven-cli",
    },
  });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  assert.equal(typeof exchanged.json().access_token, "string");

  const whoami = await app.inject({
    method: "GET",
    url: "/v1/auth/whoami",
    headers: { authorization: `Bearer ${exchanged.json().access_token}` },
  });
  assert.equal(whoami.statusCode, 200);
  assert.equal(whoami.json().user.email, "cli@example.com");
});

test("backend routes machine operations to the machine's provider", async () => {
  const second = new FakeProvider("fake2", "Fake Cloud 2");
  const { app, provider, token } = await createTestBackend("multi@example.com", "password123", { extraProviders: [second] });
  const headers = { authorization: `Bearer ${token}` };

  const providersResponse = await app.inject({ method: "GET", url: "/v1/providers" });
  assert.equal(providersResponse.statusCode, 200);
  const providerNames = providersResponse.json().providers.map((info: { name: string }) => info.name);
  assert.deepEqual(providerNames.sort(), ["fake", "fake2"]);
  const defaultInfo = providersResponse.json().providers.find((info: { default?: boolean }) => info.default);
  assert.equal(defaultInfo.name, "fake");

  const created = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: { name: "foo", provider: "fake2" },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().machine.provider, "fake2");
  assert.equal(created.json().machine.provider_label, "Fake Cloud 2");
  assert.equal(second.created.length, 1);
  assert.equal(provider.created.length, 0);

  const deleted = await app.inject({ method: "DELETE", url: "/v1/machines/foo", headers });
  assert.equal(deleted.statusCode, 204);
  assert.deepEqual(second.released, ["foo"]);
  assert.deepEqual(provider.released, []);

  const unknown = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: { name: "bar", provider: "aws" },
  });
  assert.equal(unknown.statusCode, 400, unknown.body);
  assert.match(unknown.body, /provider aws is not configured/);
});

test("backend keeps listing machines when one provider is down", async () => {
  const second = new FakeProvider("fake2", "Fake Cloud 2");
  const { app, token } = await createTestBackend("degraded@example.com", "password123", { extraProviders: [second] });
  const headers = { authorization: `Bearer ${token}` };

  const created = await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "survivor" } });
  assert.equal(created.statusCode, 201, created.body);

  second.failList = true;
  const listed = await app.inject({ method: "GET", url: "/v1/machines", headers });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().machines.map((machine: RemoteMachine) => machine.name), ["survivor"]);
});

test("backend handles non-string image request fields without 500s", async () => {
  const { app, provider, token } = await createTestBackend("admin@example.com", "password123", { adminEmails: ["admin@example.com"] });
  const headers = { authorization: `Bearer ${token}` };
  provider.images = [{ id: "222", name: "boxhaven-remote-new", status: "available", bootstrapped: true }];

  const numericID = await app.inject({ method: "POST", url: "/v1/images/activate", headers, payload: { provider: "fake", id: 222 } });
  assert.equal(numericID.statusCode, 200, numericID.body);
  assert.equal(numericID.json().active.id, "222");

  const numericMachine = await app.inject({ method: "POST", url: "/v1/images", headers, payload: { machine: 123 } });
  assert.equal(numericMachine.statusCode, 404, numericMachine.body);

  const objectMachine = await app.inject({ method: "POST", url: "/v1/images", headers, payload: { machine: { name: "x" } } });
  assert.equal(objectMachine.statusCode, 400, objectMachine.body);

  const numericProvider = await app.inject({ method: "POST", url: "/v1/images/deactivate", headers, payload: { provider: 5 } });
  assert.equal(numericProvider.statusCode, 400, numericProvider.body);
});

test("backend gates image management behind admin emails", async () => {
  const { app, token } = await createTestBackend("user@example.com", "password123", { adminEmails: ["admin@example.com"] });
  const denied = await app.inject({ method: "GET", url: "/v1/images", headers: { authorization: `Bearer ${token}` } });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.match(denied.body, /BOXHAVEN_ADMIN_EMAILS/);
});

test("backend lists, activates, and deletes provider images for admins", async () => {
  const { app, provider, token } = await createTestBackend("admin@example.com", "password123", { adminEmails: ["Admin@example.com"] });
  const headers = { authorization: `Bearer ${token}` };
  provider.images = [
    { id: "111", name: "boxhaven-remote-old", status: "available", bootstrapped: true },
    { id: "222", name: "boxhaven-remote-new", status: "available", bootstrapped: true },
  ];

  const whoami = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers });
  assert.equal(whoami.json().admin, true);

  const listed = await app.inject({ method: "GET", url: "/v1/images", headers });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().images.length, 2);
  assert.equal(listed.json().images.every((image: MachineImage) => image.active === false), true);

  const activated = await app.inject({
    method: "POST",
    url: "/v1/images/activate",
    headers,
    payload: { provider: "fake", id: "222" },
  });
  assert.equal(activated.statusCode, 200, activated.body);
  assert.equal(activated.json().active.id, "222");

  const listedAfter = await app.inject({ method: "GET", url: "/v1/images", headers });
  const activeImage = listedAfter.json().images.find((image: MachineImage) => image.active);
  assert.equal(activeImage.id, "222");

  const created = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: { name: "uses-active" },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(provider.created[0].image, "222");
  assert.equal(provider.created[0].image_bootstrapped, true);

  const deleteActive = await app.inject({ method: "DELETE", url: "/v1/images/222?provider=fake", headers });
  assert.equal(deleteActive.statusCode, 409, deleteActive.body);

  const deleteOld = await app.inject({ method: "DELETE", url: "/v1/images/111?provider=fake", headers });
  assert.equal(deleteOld.statusCode, 204, deleteOld.body);
  assert.deepEqual(provider.deletedImages, ["111"]);

  const deactivated = await app.inject({ method: "POST", url: "/v1/images/deactivate", headers, payload: { provider: "fake" } });
  assert.equal(deactivated.statusCode, 204, deactivated.body);

  const explicitImage = await app.inject({
    method: "POST",
    url: "/v1/machines",
    headers,
    payload: { name: "explicit-image", image: "333", region: "fra1" },
  });
  assert.equal(explicitImage.statusCode, 201, explicitImage.body);
  const explicitRequest = provider.created.find((request) => request.name === "explicit-image");
  assert.equal(explicitRequest?.image, "333");
  assert.equal(explicitRequest?.region, "fra1");
  assert.equal(explicitRequest?.image_bootstrapped, undefined);
});

test("backend snapshots a machine into a managed image", async () => {
  const { app, provider, token } = await createTestBackend("admin@example.com", "password123", { adminEmails: ["admin@example.com"] });
  const headers = { authorization: `Bearer ${token}` };
  const created = await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "golden" } });
  assert.equal(created.statusCode, 201, created.body);

  const snapshot = await app.inject({
    method: "POST",
    url: "/v1/images",
    headers,
    payload: { machine: "golden", name: "My Custom Build" },
  });
  assert.equal(snapshot.statusCode, 202, snapshot.body);
  assert.equal(snapshot.json().image.name, "boxhaven-remote-my-custom-build");
  assert.deepEqual(provider.snapshotted, [{ machine: "golden", name: "boxhaven-remote-my-custom-build" }]);
});

test("backend creates a personal team automatically and scopes boxes to teams", async () => {
  const { app, token } = await createTestBackend("solo@example.com");
  const headers = { authorization: `Bearer ${token}` };

  const whoami = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers });
  assert.equal(whoami.statusCode, 200, whoami.body);
  assert.equal(whoami.json().team?.name, "solo's team");
  assert.match(whoami.json().team?.slug, /^solo-[a-f0-9]{6}$/);
  assert.equal(whoami.json().teams.length, 1);

  const created = await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "foo" } });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().machine.team_id, whoami.json().team.id);
  assert.equal(created.json().machine.team_slug, whoami.json().team.slug);

  const listed = await app.inject({ method: "GET", url: "/v1/machines", headers });
  assert.equal(listed.json().machines[0].team_slug, whoami.json().team.slug);
});

test("backend enforces the per-user machine limit", async () => {
  const { app, token } = await createTestBackend("limited@example.com", "password123", { maxMachinesPerUser: 1 });
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "one" } })).statusCode, 201);
  const second = await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "two" } });
  assert.equal(second.statusCode, 403, second.body);
  assert.match(second.body, /limit of 1 boxes/);
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/machines/one", headers })).statusCode, 204);
  assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "two" } })).statusCode, 201);
});

test("backend scopes team machine listing and destroy to the box's team", async () => {
  const { app, provider, token } = await createTestBackend("owner@example.com");
  const memberToken = await signUp(app, "member@example.com");
  const ownerHeaders = { authorization: `Bearer ${token}` };
  const memberHeaders = { authorization: `Bearer ${memberToken}` };

  // The member touches the API before joining, so they get a personal team,
  // and their pre-existing box stays in it.
  assert.equal((await app.inject({ method: "GET", url: "/v1/auth/whoami", headers: memberHeaders })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers: memberHeaders, payload: { name: "private-box" } })).statusCode, 201);

  const orgCreated = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/create",
    headers: ownerHeaders,
    payload: { name: "Acme", slug: "acme" },
  });
  assert.equal(orgCreated.statusCode, 200, orgCreated.body);
  const orgID = orgCreated.json().id || orgCreated.json().organization?.id;
  assert.equal(typeof orgID, "string");

  const invited = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/invite-member",
    headers: ownerHeaders,
    payload: { email: "member@example.com", role: "member", organizationId: orgID },
  });
  assert.equal(invited.statusCode, 200, invited.body);

  const accepted = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/accept-invitation",
    headers: memberHeaders,
    payload: { invitationId: invited.json().id },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);

  // Boxes land in the requested team. Accepting an invitation switches the
  // member's active team, so their next create defaults to Acme, while the
  // box created beforehand stays in (and is only visible to) their personal
  // team.
  assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers: ownerHeaders, payload: { name: "owner-box", team: "acme" } })).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers: memberHeaders, payload: { name: "team-box" } })).statusCode, 201);

  const memberView = await app.inject({ method: "GET", url: `/v1/orgs/${orgID}/machines`, headers: memberHeaders });
  assert.equal(memberView.statusCode, 200, memberView.body);
  assert.equal(memberView.json().role, "member");
  const names = memberView.json().machines.map((machine: { name: string }) => machine.name).sort();
  assert.deepEqual(names, ["owner-box", "team-box"]);
  const ownerBox = memberView.json().machines.find((machine: { name: string }) => machine.name === "owner-box");
  assert.equal(ownerBox.owner_email, "owner@example.com");
  assert.equal(ownerBox.agent_token_hash, undefined);

  const memberDestroy = await app.inject({
    method: "DELETE",
    url: `/v1/orgs/${orgID}/machines/${ownerBox.user_id}/owner-box`,
    headers: memberHeaders,
  });
  assert.equal(memberDestroy.statusCode, 403, memberDestroy.body);

  const teamBox = memberView.json().machines.find((machine: { name: string }) => machine.name === "team-box");
  const privateDestroy = await app.inject({
    method: "DELETE",
    url: `/v1/orgs/${orgID}/machines/${teamBox.user_id}/private-box`,
    headers: ownerHeaders,
  });
  assert.equal(privateDestroy.statusCode, 404, privateDestroy.body);

  const ownerDestroy = await app.inject({
    method: "DELETE",
    url: `/v1/orgs/${orgID}/machines/${teamBox.user_id}/team-box`,
    headers: ownerHeaders,
  });
  assert.equal(ownerDestroy.statusCode, 204, ownerDestroy.body);
  assert.deepEqual(provider.released, ["team-box"]);

  const outsiderToken = await signUp(app, "outsider@example.com");
  const outsiderView = await app.inject({
    method: "GET",
    url: `/v1/orgs/${orgID}/machines`,
    headers: { authorization: `Bearer ${outsiderToken}` },
  });
  assert.equal(outsiderView.statusCode, 403, outsiderView.body);
});

test("backend never places a removed member's boxes in the old team", async () => {
  const { app, token } = await createTestBackend("boss@example.com");
  const memberToken = await signUp(app, "kicked@example.com");
  const ownerHeaders = { authorization: `Bearer ${token}` };
  const memberHeaders = { authorization: `Bearer ${memberToken}` };

  const orgCreated = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/create",
    headers: ownerHeaders,
    payload: { name: "Strict Co", slug: "strict-co" },
  });
  assert.equal(orgCreated.statusCode, 200, orgCreated.body);
  const orgID = orgCreated.json().id || orgCreated.json().organization?.id;

  const invited = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/invite-member",
    headers: ownerHeaders,
    payload: { email: "kicked@example.com", role: "member", organizationId: orgID },
  });
  assert.equal(invited.statusCode, 200, invited.body);
  // The member joins without ever creating a personal team, so the joined
  // team becomes their session's active team.
  const accepted = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/accept-invitation",
    headers: memberHeaders,
    payload: { invitationId: invited.json().id },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);

  const removed = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/remove-member",
    headers: ownerHeaders,
    payload: { memberIdOrEmail: "kicked@example.com", organizationId: orgID },
  });
  assert.equal(removed.statusCode, 200, removed.body);

  // The removed member's session still claims the old team as active; the
  // backend must not honor it.
  const whoami = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers: memberHeaders });
  assert.equal(whoami.statusCode, 200, whoami.body);
  assert.notEqual(whoami.json().team?.id, orgID);
  assert.equal(typeof whoami.json().team?.id, "string");

  const created = await app.inject({ method: "POST", url: "/v1/machines", headers: memberHeaders, payload: { name: "after-kick" } });
  assert.equal(created.statusCode, 201, created.body);
  assert.notEqual(created.json().machine.team_id, orgID);
  assert.equal(created.json().machine.team_id, whoami.json().team.id);

  const ownerView = await app.inject({ method: "GET", url: `/v1/orgs/${orgID}/machines`, headers: ownerHeaders });
  assert.equal(ownerView.statusCode, 200, ownerView.body);
  assert.deepEqual(ownerView.json().machines, []);
});

test("backend rejects ambiguous team name references", async () => {
  const { app, token } = await createTestBackend("dupes@example.com");
  const headers = { authorization: `Bearer ${token}` };
  for (const slug of ["same-a", "same-b"]) {
    const created = await app.inject({
      method: "POST",
      url: "/v1/auth/organization/create",
      headers,
      payload: { name: "Same Name", slug },
    });
    assert.equal(created.statusCode, 200, created.body);
  }

  const ambiguous = await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "box", team: "Same Name" } });
  assert.equal(ambiguous.statusCode, 400, ambiguous.body);
  assert.match(ambiguous.body, /ambiguous/);

  const bySlug = await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "box", team: "same-b" } });
  assert.equal(bySlug.statusCode, 201, bySlug.body);
  assert.equal(bySlug.json().machine.team_slug, "same-b");
});

test("backend moves boxes between the owner's teams", async () => {
  const { app, token } = await createTestBackend("mover@example.com");
  const headers = { authorization: `Bearer ${token}` };

  const orgCreated = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/create",
    headers,
    payload: { name: "Side Project", slug: "side-project" },
  });
  assert.equal(orgCreated.statusCode, 200, orgCreated.body);

  assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "wanderer" } })).statusCode, 201);

  const denied = await app.inject({ method: "POST", url: "/v1/machines/wanderer/move", headers, payload: { team: "not-a-team" } });
  assert.equal(denied.statusCode, 400, denied.body);

  const moved = await app.inject({ method: "POST", url: "/v1/machines/wanderer/move", headers, payload: { team: "side-project" } });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().machine.team_slug, "side-project");

  const orgID = orgCreated.json().id || orgCreated.json().organization?.id;
  const teamView = await app.inject({ method: "GET", url: `/v1/orgs/${orgID}/machines`, headers });
  assert.deepEqual(teamView.json().machines.map((machine: { name: string }) => machine.name), ["wanderer"]);
});

test("backend starts GitHub sign-in", async () => {
  const { app } = await createTestBackend("gh@example.com", "password123", { github: true });
  const social = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-in/social",
    payload: { provider: "github", callbackURL: "http://127.0.0.1/auth/github" },
  });
  assert.equal(social.statusCode, 200, social.body);
  assert.match(social.json().url, /github\.com\/login\/oauth\/authorize/);
  assert.match(social.json().url, /client_id=test-client-id/);
});

async function createTestBackend(
  email = "user@example.com",
  password = "password123",
  options: {
    previewTargetPort?: number;
    machineReadyTimeoutMs?: number;
    adminEmails?: string[];
    extraProviders?: MachineProvider[];
    maxMachinesPerUser?: number;
    github?: boolean;
    previewTLSWarmup?: (previewURL: string) => Promise<void>;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-backend-"));
  const provider = new FakeProvider();
  const providers = new ProviderRegistry([provider, ...(options.extraProviders || [])], provider.name);
  const store = new StateStore(join(dir, "state.json"), provider.name);
  const sshCA = new SSHCertificateAuthority(join(dir, "ssh_ca_ed25519"));
  const authOptions = {
    baseURL: "http://127.0.0.1/v1/auth",
    databasePath: join(dir, "auth.sqlite"),
    secret: "test-secret-with-at-least-thirty-two-bytes",
    deviceVerificationURL: "http://127.0.0.1/device",
    ...(options.github ? { github: { clientId: "test-client-id", clientSecret: "test-client-secret" } } : {}),
  };
  await migrateBackendAuth(authOptions);
  const auth = createBackendAuth(authOptions);
  const app = createBackend({
    auth,
    providers,
    store,
    sshCA,
    adminEmails: options.adminEmails,
    maxMachinesPerUser: options.maxMachinesPerUser,
    apiPublicURL: "https://api.hosted.test",
    appPublicURL: "https://app.hosted.test",
    previewBaseDomain: "hosted.test",
    previewTargetPort: options.previewTargetPort,
    previewTLSWarmup: options.previewTLSWarmup,
    machineReadyTimeoutMs: options.machineReadyTimeoutMs ?? 0,
  });
  const token = await signUp(app, email, password);
  return { app, provider, token };
}

async function signUp(app: ReturnType<typeof createBackend>, email: string, password = "password123"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: {
      email,
      password,
      name: email.split("@")[0],
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(typeof body.token, "string");
  return body.token;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashUserID(userID: string): string {
  return createHash("sha256").update(userID).digest("hex").slice(0, 10);
}

function nextWSMessage(socket: { once: (event: "message" | "error", handler: (data: Buffer | Error) => void) => void }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer)));
    socket.once("error", (error) => reject(error));
  });
}

async function nextWSMessageWithTimeout(socket: { once: (event: "message" | "error", handler: (data: Buffer | Error) => void) => void }, ms = 2_000): Promise<Buffer> {
  return Promise.race([
    nextWSMessage(socket),
    delay(ms).then(() => {
      throw new Error("timed out waiting for websocket message");
    }),
  ]);
}
