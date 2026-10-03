import assert from "node:assert/strict";
import test from "node:test";
import { Sandbox } from "e2b";
import { E2BProvider } from "./e2b.js";

test("E2B lease renewal coalesces heartbeats and paused access resumes memory", async t => {
  const renewed: number[] = [], connected: string[] = [];
  t.mock.method(Sandbox, "setTimeout", async (_id: string, ms: number) => { renewed.push(ms); });
  t.mock.method(Sandbox, "getInfo", async () => ({ sandboxId: "sandbox-id", metadata: { boxhaven: "true", boxhaven_team: "0123456789", boxhaven_name: "box", boxhaven_provider_name: "box-0123456789" }, startedAt: new Date(), state: "paused" }));
  t.mock.method(Sandbox, "connect", async (id: string) => { connected.push(id); return { trafficAccessToken: "scoped-token", getHost: (port: number) => `${port}-${id}.e2b.app` }; });
  const provider = new E2BProvider({ apiKey: "account-secret", template: "runtime" });
  const machine = { name: "box", provider: "e2b", provider_id: "sandbox-id", provider_name: "box-0123456789" };
  await Promise.all(Array.from({ length: 20 }, () => provider.maintainMachine(machine)));
  assert.deepEqual(renewed, [3_600_000]);
  await Promise.all(Array.from({ length: 10 }, () => provider.ensureMachineRunning(machine)));
  assert.deepEqual(connected, ["sandbox-id"]);
  const access = await provider.issueSSHAccess(machine, new Date(Date.now()+900_000).toISOString());
  assert.equal(access.kind, "websocket");
  if (access.kind !== "websocket") throw new Error("wrong transport");
  assert.deepEqual(access.headers, { "E2B-Traffic-Access-Token": "scoped-token" });
  assert.equal(access.url, "wss://9898-sandbox-id.e2b.app/ssh");
});


test("E2B backs off failed lease renewals instead of hitting the provider on every heartbeat", async t => {
  let calls = 0;
  t.mock.method(Sandbox, "setTimeout", async () => { calls++; throw new Error("private provider error"); });
  const provider = new E2BProvider({ apiKey: "account-secret", template: "runtime" });
  const machine = { name: "box", provider: "e2b", provider_id: "sandbox-id" };
  await assert.rejects(provider.maintainMachine(machine), { message: "E2B lease renewal failed" });
  await Promise.all(Array.from({ length: 20 }, () => provider.maintainMachine(machine)));
  assert.equal(calls, 1);
});
