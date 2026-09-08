import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { StateStore } from "./state.js";

test("image name reservations are atomic across store connections and providers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "boxhaven-image-state-"));
  const first = new StateStore(join(dir, "state.sqlite"), "digitalocean");
  const second = new StateStore(first.path, "hetzner");
  const image = { name: "kyoto-dev", provider_name: "snapshot-one", provider: "digitalocean", org_id: "team-one" };
  try {
    const results = await Promise.all([
      first.reserveImage(image),
      second.reserveImage({ ...image, provider_name: "snapshot-two", provider: "hetzner" }),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal((await first.listImagesForOrg("team-one")).length, 1);
    assert.equal(await second.reserveImage({ ...image, provider_name: "snapshot-three", org_id: "team-two" }), true);
    const [reserved] = await first.listImagesForOrg("team-one");
    await first.putImage({ ...reserved, id: "provider-id" });
    assert.equal((await first.getImageForOrg("team-one", reserved.provider, "kyoto-dev"))?.id, "provider-id");
    await assert.rejects(second.putImage({ ...image, provider: "other" }), /UNIQUE constraint failed/);
    assert.equal((await first.listImagesForOrg("team-one")).length, 1);
  } finally {
    first.close(); second.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("image migration preserves existing names, provider IDs and pending snapshots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "boxhaven-image-migrate-"));
  const file = join(dir, "state.sqlite");
  const seed = new StateStore(file, "digitalocean");
  seed.close();
  const db = new Database(file);
  db.exec("DROP INDEX core_images_team_name; DELETE FROM boxhaven_migrations WHERE module = 'core' AND version = 6");
  for (const [id, name] of [["244559976", "boxhaven-remote-kyoto-dev"], [undefined, "boxhaven-remote-pending"]]) {
    const record = { id, name, org_id: "team", provider: "digitalocean", bootstrapped: true };
    db.prepare("INSERT INTO core_images VALUES (?, ?, ?, ?, ?, ?)").run("team", "digitalocean", id || name, id || null, name, JSON.stringify(record));
  }
  db.close();
  const migrated = new StateStore(file, "digitalocean");
  try {
    const ready = await migrated.getImageForOrg("team", "digitalocean", "244559976");
    assert.equal(ready?.name, "boxhaven-remote-kyoto-dev");
    assert.equal(ready?.provider_name, ready?.name);
    assert.equal(ready?.bootstrapped, true);
    const pending = await migrated.getImageForOrg("team", "digitalocean", "boxhaven-remote-pending");
    assert.equal(pending?.provider_name, "boxhaven-remote-pending");
    assert.equal(pending?.id, undefined);
    assert.equal(await migrated.reserveImage({ name: "kyoto-dev", provider_name: "new-snapshot", provider: "digitalocean", org_id: "team" }), true);
  } finally { migrated.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("image migration reports old cross-provider name collisions without losing records", () => {
  const dir = mkdtempSync(join(tmpdir(), "boxhaven-image-duplicates-"));
  const file = join(dir, "state.sqlite");
  const seed = new StateStore(file, "digitalocean");
  seed.close();
  const db = new Database(file);
  try {
    db.exec("DROP INDEX core_images_team_name; DELETE FROM boxhaven_migrations WHERE module = 'core' AND version = 6");
    for (const provider of ["digitalocean", "hetzner"]) {
      const record = { id: provider, name: "tools", org_id: "team", provider };
      db.prepare("INSERT INTO core_images VALUES (?, ?, ?, ?, ?, ?)").run("team", provider, provider, provider, "tools", JSON.stringify(record));
    }
    assert.throws(() => new StateStore(file, "digitalocean"), /duplicate image name tools/);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM core_images").get() as { count: number }).count, 2);
    assert.equal(db.prepare("SELECT 1 FROM boxhaven_migrations WHERE module = 'core' AND version = 6").get(), undefined);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
