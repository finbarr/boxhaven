import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applyBackendMigrations } from "./database.js";

test("backend module migrations run once in order", () => {
  const database = new Database(":memory:");
  const calls: number[] = [];
  const migrations = [
    { version: 1, migrate(db: Database.Database) { calls.push(1); db.exec("CREATE TABLE example (id TEXT PRIMARY KEY)"); } },
    { version: 2, migrate(db: Database.Database) { calls.push(2); db.exec("ALTER TABLE example ADD COLUMN label TEXT"); } },
  ];

  applyBackendMigrations(database, "example", migrations);
  applyBackendMigrations(database, "example", migrations);

  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(database.prepare(
    "SELECT module, version FROM boxhaven_migrations ORDER BY version",
  ).all(), [
    { module: "example", version: 1 },
    { module: "example", version: 2 },
  ]);
  database.close();
});

test("failed backend module migrations roll back schema and ledger changes", () => {
  const database = new Database(":memory:");
  assert.throws(() => applyBackendMigrations(database, "example", [{
    version: 1,
    migrate(db) {
      db.exec("CREATE TABLE incomplete (id TEXT)");
      throw new Error("migration failed");
    },
  }]), /migration failed/);

  assert.equal(database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'incomplete'",
  ).get(), undefined);
  assert.equal((database.prepare(
    "SELECT COUNT(*) AS count FROM boxhaven_migrations WHERE module = 'example'",
  ).get() as { count: number }).count, 0);
  database.close();
});

test("backend module migrations reject gaps and database downgrades", () => {
  const database = new Database(":memory:");
  assert.throws(() => applyBackendMigrations(database, "example", [
    { version: 2, migrate() {} },
  ]), /sequential from version 1/);

  applyBackendMigrations(database, "example", [{ version: 1, migrate() {} }]);
  assert.throws(() => applyBackendMigrations(database, "example", []), /unknown example migration version 1/);
  database.close();
});
