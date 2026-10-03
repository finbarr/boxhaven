import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { watchTeamResources } from "./fleet_client.js";
import { StateStore } from "./state.js";
import { registerTeamSync } from "./team_sync.js";

test("fleet client consumes live metadata changes and surfaces revoked access", async t => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-fleet-client-"));
  const store = new StateStore(join(dir, "state.db"), "fake");
  const app = Fastify();
  let allowed = true;
  registerTeamSync(app, { store, async authorize(headers) { return headers.authorization !== "Bearer member" ? "unauthorized" : allowed ? "allowed" : "forbidden"; } });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  t.after(async () => { clearTimeout(deadline); controller.abort(); await app.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  await store.putMachine({ name: "first", user_id: "alice", org_id: "team" });
  const box = (await store.getMachine("alice", "first"))!;
  const names: string[] = [];
  let updated!: () => void;
  const change = new Promise<void>(resolve => { updated = resolve; });
  const watch = watchTeamResources(url, "team", "member", controller.signal, snapshot => {
    names.push(snapshot.resources[0].name);
    if (names.length === 1) void store.renameMachine("alice", "first", { ...box, name: "second" });
    if (snapshot.resources[0].name === "second") updated();
  });
  const revoked = assert.rejects(watch, /revoked|access is required/i);
  await change;
  allowed = false;
  await store.putMachine({ ...box, name: "second", size: "large" });
  await revoked;
  assert.deepEqual(names, ["first", "second"]);
});
