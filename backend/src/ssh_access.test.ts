import assert from "node:assert/strict";
import test from "node:test";
import { jwtVerify } from "jose";
import { bridgeAccessToken, machineSSHAccess } from "./ssh_access.js";
import { hashAgentToken } from "./server.js";
import type { MachineProvider } from "./types.js";

const hash = hashAgentToken("guest-secret");
const expiry = () => new Date(Date.now() + 60000).toISOString();

test("SSH grants are signed for one guest, user, purpose, and bounded lifetime", async () => {
  const token = await bridgeAccessToken(hash, "alice", expiry());
  const verified = await jwtVerify(token, Buffer.from(hash, "hex"), { audience: "boxhaven-ssh-bridge", algorithms: ["HS256"] });
  assert.equal(verified.payload.sub, "alice");
  await assert.rejects(jwtVerify(token, Buffer.alloc(32), { audience: "boxhaven-ssh-bridge" }));
  await assert.rejects(jwtVerify(token, Buffer.from(hash, "hex"), { audience: "other" }));
  await assert.rejects(jwtVerify(await bridgeAccessToken(hash, "alice", new Date(0).toISOString()), Buffer.from(hash, "hex")));
  await assert.rejects(bridgeAccessToken("", "alice", expiry()));
});

test("shared SSH contract preserves direct TCP and rejects unsafe provider WebSocket destinations", async () => {
  const provider = { name: "fake", issueSSHAccess: async () => ({ kind: "websocket", url: "wss://vm.example/ssh", headers: { "X-Provider-Access": "scoped" }, expires_at: expiry() }) } as MachineProvider;
  assert.deepEqual(await machineSSHAccess(provider, { name: "one", public_ipv4: "192.0.2.1" }, "alice", expiry()), { kind: "tcp", host: "192.0.2.1", port: 22 });
  const machine = { name: "one", ssh_transport: "websocket" as const, agent_token_hash: hash };
  const access = await machineSSHAccess(provider, machine, "alice", expiry());
  assert.equal(access.kind, "websocket");
  if (access.kind !== "websocket") return;
  assert.equal(access.headers["X-Provider-Access"], "scoped");
  assert.ok(access.headers["X-BoxHaven-Access"]);
  for (const url of ["ws://vm.example/ssh", "wss://user:secret@vm.example/ssh", "wss://vm.example/ssh?token=secret", "wss://vm.example/ssh#secret"]) {
    provider.issueSSHAccess = async () => ({ ...access, url });
    await assert.rejects(machineSSHAccess(provider, machine, "alice", expiry()), /unsafe/);
  }
});
