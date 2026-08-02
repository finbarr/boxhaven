import { chmod, chown, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { StateStore } from "./state.js";
import type { BackendState } from "./types.js";

export type LegacyMigrationInput = {
  databasePath: string;
  authDatabasePath: string;
  statePath: string;
  provider: string;
};

export type LegacyMigrationResult = {
  databasePath: string;
  machines: number;
  images: number;
  policyEvents: number;
};

export async function migrateLegacyDatabase(input: LegacyMigrationInput): Promise<LegacyMigrationResult> {
  const databasePath = resolve(input.databasePath);
  const authDatabasePath = resolve(input.authDatabasePath);
  const statePath = resolve(input.statePath);
  if (await exists(databasePath)) throw new Error(`destination database already exists: ${databasePath}`);
  if (!(await exists(authDatabasePath))) throw new Error(`legacy auth database does not exist: ${authDatabasePath}`);
  if (!(await exists(statePath))) throw new Error(`legacy state file does not exist: ${statePath}`);

  const sourceOwnership = await stat(authDatabasePath);
  const state = parseLegacyState(await readFile(statePath, "utf8"));
  await mkdir(dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.${process.pid}.migration`;
  if (await exists(temporaryPath)) throw new Error(`temporary migration database already exists: ${temporaryPath}`);

  const source = new Database(authDatabasePath, { readonly: true, fileMustExist: true });
  try {
    if (source.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error("legacy auth database failed SQLite quick_check");
    }
    await source.backup(temporaryPath);
  } finally {
    source.close();
  }

  try {
    const store = new StateStore(temporaryPath, input.provider);
    try {
      await store.importLegacyState(state);
      if (store.db.pragma("quick_check", { simple: true }) !== "ok") {
        throw new Error("migrated BoxHaven database failed SQLite quick_check");
      }
    } finally {
      store.close();
    }
    await chmod(temporaryPath, 0o600);
    if (process.getuid?.() === 0) {
      await chown(temporaryPath, sourceOwnership.uid, sourceOwnership.gid);
    }
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return {
    databasePath,
    machines: Object.keys(state.machines || {}).length,
    images: Object.keys(state.images || {}).length,
    policyEvents: Object.keys(state.policy_events || {}).length,
  };
}

function parseLegacyState(value: string): BackendState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("legacy backend state is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("legacy backend state must be a JSON object");
  }
  const state = parsed as Partial<BackendState>;
  if (!state.machines || typeof state.machines !== "object" || Array.isArray(state.machines)) {
    throw new Error("legacy backend state must contain a machines object");
  }
  return state as BackendState;
}

function parseArgs(argv: string[]): LegacyMigrationInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error(usage());
    values.set(name, value);
  }
  const databasePath = values.get("--database");
  const authDatabasePath = values.get("--auth-db");
  const statePath = values.get("--state");
  if (!databasePath || !authDatabasePath || !statePath) throw new Error(usage());
  return {
    databasePath,
    authDatabasePath,
    statePath,
    provider: values.get("--provider") || "digitalocean",
  };
}

function usage(): string {
  return "usage: npm run migrate:legacy -- --database <boxhaven.sqlite> --auth-db <auth.sqlite> --state <backend.json> [--provider <name>]";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  migrateLegacyDatabase(parseArgs(process.argv.slice(2)))
    .then((result) => {
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error((error as Error).message);
      process.exitCode = 1;
    });
}
