import type Database from "better-sqlite3";

export type BackendDatabaseMigration = {
  version: number;
  migrate(database: Database.Database): void;
};

export function applyBackendMigrations(
  database: Database.Database,
  moduleName: string,
  migrations: BackendDatabaseMigration[],
): void {
  if (!/^[a-z][a-z0-9_]*$/.test(moduleName)) {
    throw new Error(`invalid backend module name: ${moduleName}`);
  }
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].version !== index + 1) {
      throw new Error(`backend module ${moduleName} migrations must be sequential from version 1`);
    }
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS boxhaven_migrations (
      module TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY(module, version)
    )
  `);
  const applied = database.prepare(
    "SELECT version FROM boxhaven_migrations WHERE module = ? ORDER BY version",
  ).all(moduleName) as Array<{ version: number }>;
  const available = new Set(ordered.map((migration) => migration.version));
  for (const migration of applied) {
    if (!available.has(migration.version)) {
      throw new Error(`database has unknown ${moduleName} migration version ${migration.version}`);
    }
  }

  const appliedVersions = new Set(applied.map((migration) => migration.version));
  for (const migration of ordered) {
    if (appliedVersions.has(migration.version)) continue;
    database.transaction(() => {
      migration.migrate(database);
      database.prepare(`
        INSERT INTO boxhaven_migrations (module, version, applied_at)
        VALUES (?, ?, ?)
      `).run(moduleName, migration.version, new Date().toISOString());
    })();
  }
}
