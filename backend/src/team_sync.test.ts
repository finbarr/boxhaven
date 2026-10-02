import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { StateStore } from "./state.js";
import { registerTeamSync, teamSnapshot } from "./team_sync.js";
import type { RemoteMachine } from "./types.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-team-sync-"));
  const path = join(dir, "state.db");
  const store = new StateStore(path, "fake");
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, path };
}

function box(name = "work", user = "alice", team = "team-a"): RemoteMachine {
  return { name, user_id: user, org_id: team, provider: "fake", provider_id: `${user}-${name}` };
}

test("resource IDs survive rename, team move, and restart; replacement gets a new ID", async t => {
  const { store, path } = await fixture(t);
  await store.putMachine(box());
  await store.putMachine(box("work", "bob"));
  const initial = (await store.getMachine("alice", "work"))!;
  assert.ok(initial.resource_id);
  assert.notEqual(initial.resource_id, (await store.getMachine("bob", "work"))!.resource_id);
  await store.renameMachine("alice", "work", { ...initial, name: "renamed" });
  const renamed = (await store.getResource(initial.resource_id))!;
  assert.equal(renamed.name, "renamed");
  await store.putMachine({ ...renamed, org_id: "team-b" });
  assert.equal((await store.getResource(initial.resource_id))!.org_id, "team-b");
  const reopened = new StateStore(path, "fake");
  assert.equal((await reopened.getResource(initial.resource_id))!.name, "renamed");
  reopened.close();
  await store.deleteMachine("alice", "renamed");
  await store.putMachine(box("renamed"));
  assert.notEqual((await store.getMachine("alice", "renamed"))!.resource_id, initial.resource_id);
});

test("team snapshots and event payloads exclude secrets and other teams", async t => {
  const { store } = await fixture(t);
  await store.putMachine({ ...box(), agent_token_hash: "private-agent-hash", last_command: ["env", "KEY=private-command"], source_path: "/private/laptop" });
  await store.putMachine(box("secret", "carol", "team-b"));
  const snapshot = teamSnapshot(store, "team-a");
  assert.equal(snapshot.resources.length, 1);
  assert.equal(snapshot.resources[0].name, "work");
  assert.doesNotMatch(JSON.stringify(snapshot), /private|carol|secret/);
  const events = store.db.prepare("SELECT * FROM core_team_events WHERE team_id = ?").all("team-a");
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /private|carol|secret/);
  assert.equal(snapshot.cursor, 2);
});

test("events commit atomically, suppress heartbeats, and notify both sides of a team move", async t => {
  const { store } = await fixture(t);
  await store.putMachine(box());
  const initial = (await store.getMachine("alice", "work"))!;
  await store.putMachine({ ...initial, updated_at: "2026-10-01T01:00:00Z", agent_last_seen_at: "2026-10-01T01:00:00Z" });
  assert.equal(teamSnapshot(store, "team-a").cursor, 1);
  assert.throws(() => store.db.transaction(() => {
    store.db.prepare("DELETE FROM core_machines WHERE user_id = ?").run("alice");
    throw new Error("rollback");
  })(), /rollback/);
  assert.equal(teamSnapshot(store, "team-a").cursor, 1);
  await store.putMachine({ ...initial, org_id: "team-b" });
  const events = store.db.prepare("SELECT team_id, resource_id, kind FROM core_team_events WHERE sequence > 1 ORDER BY sequence").all();
  assert.deepEqual(events, [
    { team_id: "team-a", resource_id: initial.resource_id, kind: "resource.removed" },
    { team_id: "team-b", resource_id: initial.resource_id, kind: "resource.changed" },
  ]);
});

test("SSE replays committed events to two devices, excludes other teams, and closes on revocation", async t => {
  const { store } = await fixture(t);
  let allowed = true;
  const app = Fastify();
  registerTeamSync(app, {
    store,
    async authorize(headers, team) {
      if (headers.authorization !== "Bearer member") return "unauthorized";
      return allowed && team === "team-a" ? "allowed" : "forbidden";
    },
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const controllers = [new AbortController(), new AbortController()];
  t.after(() => controllers.forEach(controller => controller.abort()));
  const streams = await Promise.all(controllers.map(async controller => {
    const response = await fetch(`${url}/v1/teams/team-a/events?cursor=0`, {
      headers: { authorization: "Bearer member" }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    return response.body!.getReader();
  }));
  const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, pattern: RegExp) => {
    let text = "";
    const deadline = setTimeout(() => controllers.forEach(controller => controller.abort()), 4000);
    try {
      while (!pattern.test(text)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      assert.match(text, pattern);
      return text;
    } finally { clearTimeout(deadline); }
  };
  await store.putMachine(box("hidden", "carol", "team-b"));
  await store.putMachine(box());
  const resource = (await store.getMachine("alice", "work"))!;
  for (const stream of streams) {
    const text = await readUntil(stream, /event: resource.changed/);
    assert.match(text, new RegExp(resource.resource_id!));
    assert.doesNotMatch(text, /hidden|team-b/);
  }
  const denied = await fetch(`${url}/v1/teams/team-b/resources`, { headers: { authorization: "Bearer member" } });
  assert.equal(denied.status, 403);
  const unauthenticated = await fetch(`${url}/v1/teams/team-a/events`);
  assert.equal(unauthenticated.status, 401);
  allowed = false;
  await store.putMachine({ ...resource, bootstrap_complete: true });
  for (const stream of streams) await readUntil(stream, /event: access.revoked/);
});

test("retention is bounded and old or invalid cursors require a new snapshot", async t => {
  const { store } = await fixture(t);
  store.db.transaction(() => {
    const insert = store.db.prepare("INSERT INTO core_team_events(team_id, resource_id, kind) VALUES ('team-a', 'resource', 'resource.changed')");
    for (let i = 0; i < 10003; i++) insert.run();
  })();
  assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM core_team_events").get() as { count: number }).count, 10000);
  const app = Fastify();
  registerTeamSync(app, { store, async authorize() { return "allowed"; } });
  t.after(() => app.close());
  const expired = await app.inject("/v1/teams/team-a/events?cursor=2");
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.json().id, "cursor_expired");
  for (const cursor of ["-1", "NaN", "1.5", "10004", "9007199254740992"]) {
    assert.equal((await app.inject(`/v1/teams/team-a/events?cursor=${cursor}`)).statusCode, 400);
  }
});
