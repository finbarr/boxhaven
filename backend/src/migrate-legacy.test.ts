import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateLegacyDatabase } from "./migrate-legacy.js";
import type { MachineLifecycleEvent } from "./policy.js";
import { StateStore } from "./state.js";

const event: MachineLifecycleEvent = {
  version: 1,
  id: "legacy-event-1",
  occurred_at: "2026-07-31T00:00:00.000Z",
  type: "machine.created",
  team: { id: "team-1", name: "Team One" },
  actor: { id: "user-1", email: "user@example.com" },
  machine: { id: "digitalocean:box-1", name: "box", tier: "small" },
};

test("legacy auth and JSON state migrate into one verified SQLite database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-migrate-"));
  const authPath = join(dir, "auth.sqlite");
  const statePath = join(dir, "backend.json");
  const databasePath = join(dir, "boxhaven.sqlite");
  const auth = new Database(authPath);
  auth.exec("CREATE TABLE legacy_auth_marker (id TEXT PRIMARY KEY); INSERT INTO legacy_auth_marker VALUES ('user-1')");
  auth.close();
  await writeFile(statePath, JSON.stringify({
    version: 7,
    provider: "digitalocean",
    machines: {
      "user-1:box": { name: "box", user_id: "user-1", org_id: "team-1", provider: "digitalocean" },
    },
    images: {
      "team-1:digitalocean:100": { id: "100", name: "base", provider: "digitalocean", org_id: "team-1" },
    },
    policy_events: { [event.id]: event },
  }));

  const result = await migrateLegacyDatabase({ databasePath, authDatabasePath: authPath, statePath, provider: "digitalocean" });
  assert.deepEqual(result, { databasePath, machines: 1, images: 1, policyEvents: 1 });

  const migrated = new Database(databasePath, { readonly: true });
  assert.equal((migrated.prepare("SELECT id FROM legacy_auth_marker").get() as { id: string }).id, "user-1");
  assert.equal(migrated.pragma("quick_check", { simple: true }), "ok");
  migrated.close();

  const store = new StateStore(databasePath, "digitalocean");
  assert.equal((await store.getMachine("user-1", "box"))?.org_id, "team-1");
  assert.equal((await store.getImageForOrg("team-1", "digitalocean", "100"))?.name, "base");
  assert.deepEqual(await store.listPolicyEvents(), [event]);
  store.close();

  await assert.rejects(
    migrateLegacyDatabase({ databasePath, authDatabasePath: authPath, statePath, provider: "digitalocean" }),
    /destination database already exists/,
  );
});

test("legacy migration rejects malformed state without publishing a destination", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-migrate-invalid-"));
  const authPath = join(dir, "auth.sqlite");
  const statePath = join(dir, "backend.json");
  const databasePath = join(dir, "boxhaven.sqlite");
  const auth = new Database(authPath);
  auth.exec("CREATE TABLE marker (id TEXT)");
  auth.close();
  await writeFile(statePath, "{not json");

  await assert.rejects(
    migrateLegacyDatabase({ databasePath, authDatabasePath: authPath, statePath, provider: "digitalocean" }),
    /not valid JSON/,
  );
  await assert.rejects(stat(databasePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});
