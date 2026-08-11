import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { applyBackendMigrations, type BackendDatabaseMigration } from "./database.js";
import { policyMachineIdentity } from "./policy.js";
import type { MachineLifecycleAction, MachineLifecycleEvent } from "./policy.js";
import { BackendState, MachineSizeShortcut, RemoteMachine, TeamImageRecord, stateVersion } from "./types.js";

type PayloadRow = { payload_json: string };
type MetadataRow = { value: string };

export type MachineCleanupRecord = {
  machine_id: string;
  team_id: string;
  reason: string;
  requested_at: string;
  event_id: string;
  machine: RemoteMachine;
};

type MachineCleanupRow = Omit<MachineCleanupRecord, "machine"> & { payload_json: string };

export class MachineCleanupPendingError extends Error {
  constructor(readonly machineName: string) {
    super(`machine ${machineName} is pending policy cleanup`);
  }
}

export class StateStore {
  readonly db: Database.Database;
  private pendingUpdate: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly provider: string,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  async load(): Promise<BackendState> {
    return this.snapshot();
  }

  async listMachines(): Promise<RemoteMachine[]> {
    return this.payloads<RemoteMachine>("SELECT payload_json FROM core_machines ORDER BY rowid");
  }

  async captureMachineSnapshot(now = () => new Date()): Promise<{ generatedAt: string; machines: RemoteMachine[] }> {
    return this.enqueue(async () => {
      await this.beforeMutation();
      return this.db.transaction(() => {
        const generatedAt = this.reservePolicyTimestamp(now().toISOString());
        this.touch();
        return { generatedAt, machines: this.listMachinesSync() };
      })();
    });
  }

  async listMachinesForUser(userID: string): Promise<RemoteMachine[]> {
    return this.payloads<RemoteMachine>(
      "SELECT payload_json FROM core_machines WHERE user_id = ? ORDER BY rowid",
      userID,
    );
  }

  async listMachinesForOrg(orgID: string): Promise<RemoteMachine[]> {
    return this.payloads<RemoteMachine>(
      "SELECT payload_json FROM core_machines WHERE org_id = ? ORDER BY rowid",
      orgID,
    );
  }

  async getMachine(userID: string, name: string): Promise<RemoteMachine | undefined> {
    const row = this.db.prepare(
      "SELECT payload_json FROM core_machines WHERE user_id = ? AND name = ?",
    ).get(userID, name) as PayloadRow | undefined;
    return row ? parsePayload<RemoteMachine>(row.payload_json, "machine") : undefined;
  }

  async putMachine(machine: RemoteMachine, policyEvent?: MachineLifecycleEvent): Promise<void> {
    if (!machine.user_id) throw new Error("machine user_id is required");
    await this.mutate(() => {
      this.writeMachine(machine);
      if (policyEvent) this.writePolicyEvent(policyEvent, true);
    });
  }

  async renameMachine(userID: string, fromName: string, machine: RemoteMachine): Promise<void> {
    if (!machine.user_id) throw new Error("machine user_id is required");
    if (machine.user_id !== userID) throw new Error("machine user_id does not match rename owner");
    await this.mutate(() => {
      if (this.machineCleanupRow(userID, fromName)) throw new MachineCleanupPendingError(fromName);
      this.db.prepare("DELETE FROM core_machines WHERE user_id = ? AND name = ?").run(userID, fromName);
      this.writeMachine(machine);
    });
  }

  async deleteMachine(userID: string, name: string, policyEvent?: MachineLifecycleEvent): Promise<void> {
    await this.mutate(() => {
      const deleted = this.db.prepare("DELETE FROM core_machines WHERE user_id = ? AND name = ?").run(userID, name);
      this.db.prepare("DELETE FROM core_machine_cleanups WHERE user_id = ? AND name = ?").run(userID, name);
      if (policyEvent && deleted.changes === 1) this.writePolicyEvent(policyEvent, true);
    });
  }

  async requestMachineCleanup(action: MachineLifecycleAction, requestedAt = new Date()): Promise<boolean> {
    return this.mutate(() => {
      if (action.type !== "machine.destroy") throw new Error(`unsupported machine lifecycle action: ${action.type}`);
      const machine = this.listMachinesSync().find((candidate) => policyMachineIdentity(candidate).id === action.machine_id);
      if (!machine?.user_id) return false;
      const teamID = machine.org_id || machine.user_id;
      if (teamID !== action.team_id) return false;
      const requested = requestedAt.toISOString();
      const eventID = cleanupEventID(action, machine);
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO core_machine_cleanups (
          machine_id, user_id, name, team_id, reason, requested_at, event_id, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        action.machine_id,
        machine.user_id,
        machine.name,
        action.team_id,
        action.reason,
        requested,
        eventID,
        JSON.stringify(machine),
      );
      return inserted.changes === 1;
    });
  }

  async listMachineCleanups(): Promise<MachineCleanupRecord[]> {
    const rows = this.db.prepare(`
      SELECT machine_id, team_id, reason, requested_at, event_id, payload_json
      FROM core_machine_cleanups ORDER BY requested_at, machine_id
    `).all() as MachineCleanupRow[];
    return rows.map(({ payload_json, ...row }) => ({
      ...row,
      machine: parsePayload<RemoteMachine>(payload_json, "machine cleanup"),
    }));
  }

  async completeMachineCleanup(machineID: string, providerEndedAt = new Date()): Promise<boolean> {
    return this.mutate(() => {
      const cleanup = this.db.prepare(`
        SELECT machine_id, team_id, reason, requested_at, event_id, payload_json
        FROM core_machine_cleanups WHERE machine_id = ?
      `).get(machineID) as MachineCleanupRow | undefined;
      if (!cleanup) return false;
      const snapshot = parsePayload<RemoteMachine>(cleanup.payload_json, "machine cleanup");
      if (!snapshot.user_id) throw new Error(`machine cleanup ${machineID} has no user identity`);
      const current = this.db.prepare(
        "SELECT payload_json FROM core_machines WHERE user_id = ? AND name = ?",
      ).get(snapshot.user_id, snapshot.name) as PayloadRow | undefined;
      if (!current) {
        this.db.prepare("DELETE FROM core_machine_cleanups WHERE machine_id = ?").run(machineID);
        return false;
      }
      const machine = parsePayload<RemoteMachine>(current.payload_json, "machine");
      if (policyMachineIdentity(machine).id !== machineID) {
        throw new Error(`machine cleanup ${machineID} no longer matches stored machine ${machine.name}`);
      }
      const deleted = this.db.prepare(
        "DELETE FROM core_machines WHERE user_id = ? AND name = ?",
      ).run(snapshot.user_id, snapshot.name);
      if (deleted.changes !== 1) return false;
      this.writePolicyEvent({
        version: 1,
        id: cleanup.event_id,
        occurred_at: providerEndedAt.toISOString(),
        type: "machine.destroyed",
        team: {
          id: cleanup.team_id,
          name: machine.org_name || cleanup.team_id,
          ...(machine.org_slug ? { slug: machine.org_slug } : {}),
        },
        actor: { id: "boxhaven-policy", email: "" },
        machine: policyMachineIdentity(machine),
      }, true);
      this.db.prepare("DELETE FROM core_machine_cleanups WHERE machine_id = ?").run(machineID);
      return true;
    });
  }

  machineCleanupPending(userID: string, name: string): boolean {
    return Boolean(this.machineCleanupRow(userID, name));
  }

  async listPolicyEvents(): Promise<MachineLifecycleEvent[]> {
    return this.payloads<MachineLifecycleEvent>(
      "SELECT payload_json FROM core_policy_events ORDER BY occurred_at, event_id",
    );
  }

  async deletePolicyEvent(id: string): Promise<void> {
    await this.mutate(() => {
      this.db.prepare("DELETE FROM core_policy_events WHERE event_id = ?").run(id);
    });
  }

  async listImagesForOrg(orgID: string): Promise<TeamImageRecord[]> {
    return this.payloads<TeamImageRecord>(
      "SELECT payload_json FROM core_images WHERE org_id = ? ORDER BY rowid",
      orgID,
    );
  }

  async getImageForOrg(orgID: string, provider: string, idOrName: string): Promise<TeamImageRecord | undefined> {
    const want = idOrName.trim();
    if (!want) return undefined;
    const rows = this.db.prepare(`
      SELECT payload_json FROM core_images
      WHERE org_id = ? AND provider = ? AND (image_id = ? OR name = ?)
      ORDER BY rowid LIMIT 1
    `).all(orgID, provider, want, want) as PayloadRow[];
    return rows[0] ? parsePayload<TeamImageRecord>(rows[0].payload_json, "image") : undefined;
  }

  async putImage(image: TeamImageRecord): Promise<void> {
    if (!image.org_id) throw new Error("image org_id is required");
    if (!image.provider) throw new Error("image provider is required");
    if (!image.name) throw new Error("image name is required");
    await this.mutate(() => this.writeImage(image));
  }

  async deleteImageForOrg(orgID: string, provider: string, idOrName: string): Promise<void> {
    const want = idOrName.trim();
    if (!want) return;
    await this.mutate(() => {
      this.db.prepare(`
        DELETE FROM core_images
        WHERE org_id = ? AND provider = ? AND (image_id = ? OR name = ?)
      `).run(orgID, provider, want, want);
    });
  }

  async listSizeShortcutsForOrg(orgID: string): Promise<MachineSizeShortcut[]> {
    return this.payloads<MachineSizeShortcut>(
      "SELECT payload_json FROM core_size_shortcuts WHERE org_id = ? ORDER BY name",
      orgID,
    );
  }

  async getSizeShortcutForOrg(orgID: string, name: string): Promise<MachineSizeShortcut | undefined> {
    const row = this.db.prepare(
      "SELECT payload_json FROM core_size_shortcuts WHERE org_id = ? AND name = ?",
    ).get(orgID, name) as PayloadRow | undefined;
    return row ? parsePayload<MachineSizeShortcut>(row.payload_json, "size shortcut") : undefined;
  }

  async putSizeShortcut(shortcut: MachineSizeShortcut): Promise<void> {
    await this.mutate(() => {
      this.db.prepare(`
        INSERT INTO core_size_shortcuts (org_id, name, provider, plan, payload_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(org_id, name) DO UPDATE SET
          provider = excluded.provider,
          plan = excluded.plan,
          payload_json = excluded.payload_json
      `).run(shortcut.org_id, shortcut.name, shortcut.provider, shortcut.plan, JSON.stringify(shortcut));
    });
  }

  async deleteSizeShortcutForOrg(orgID: string, name: string): Promise<void> {
    await this.mutate(() => {
      this.db.prepare("DELETE FROM core_size_shortcuts WHERE org_id = ? AND name = ?").run(orgID, name);
    });
  }

  protected async beforeMutation(): Promise<void> {}

  private async mutate<T>(fn: () => T): Promise<T> {
    return this.enqueue(async () => {
      await this.beforeMutation();
      return this.db.transaction(() => {
        const result = fn();
        this.touch();
        return result;
      })();
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const update = this.pendingUpdate.then(fn);
    this.pendingUpdate = update.then(() => {}, () => {});
    return update;
  }

  private writeMachine(machine: RemoteMachine): void {
    const userID = machine.user_id;
    if (!userID) throw new Error("machine user_id is required");
    const cleanup = this.machineCleanupRow(userID, machine.name);
    if (cleanup && (machine.org_id || userID) !== cleanup.team_id) {
      throw new MachineCleanupPendingError(machine.name);
    }
    this.db.prepare(`
      INSERT INTO core_machines (user_id, name, org_id, provider, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, name) DO UPDATE SET
        org_id = excluded.org_id,
        provider = excluded.provider,
        payload_json = excluded.payload_json
    `).run(userID, machine.name, machine.org_id || null, machine.provider || null, JSON.stringify(machine));
  }

  private machineCleanupRow(userID: string, name: string): MachineCleanupRow | undefined {
    return this.db.prepare(`
      SELECT machine_id, team_id, reason, requested_at, event_id, payload_json
      FROM core_machine_cleanups WHERE user_id = ? AND name = ?
    `).get(userID, name) as MachineCleanupRow | undefined;
  }

  private writeImage(image: TeamImageRecord): void {
    if (!image.org_id || !image.provider || !image.name) throw new Error("image identity is required");
    this.db.prepare(`
      DELETE FROM core_images
      WHERE org_id = ? AND provider = ? AND (name = ? OR (? IS NOT NULL AND image_id = ?))
    `).run(image.org_id, image.provider, image.name, image.id || null, image.id || null);
    this.db.prepare(`
      INSERT INTO core_images (org_id, provider, identity, image_id, name, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      image.org_id,
      image.provider,
      image.id || image.name,
      image.id || null,
      image.name,
      JSON.stringify(image),
    );
  }

  private writePolicyEvent(event: MachineLifecycleEvent, reserveTimestamp: boolean): void {
    const occurredAt = reserveTimestamp ? this.reservePolicyTimestamp(event.occurred_at) : normalizedTimestamp(event.occurred_at);
    const persisted = { ...event, occurred_at: occurredAt };
    this.db.prepare(`
      INSERT INTO core_policy_events (event_id, occurred_at, payload_json)
      VALUES (?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        occurred_at = excluded.occurred_at,
        payload_json = excluded.payload_json
    `).run(event.id, occurredAt, JSON.stringify(persisted));
  }

  private reservePolicyTimestamp(candidate: string): string {
    const candidateMs = Date.parse(candidate);
    if (!Number.isFinite(candidateMs)) throw new Error(`invalid policy timestamp: ${candidate}`);
    const previous = this.metadata("policy_timestamp");
    const previousMs = Date.parse(previous || "");
    const reservedMs = Number.isFinite(previousMs) ? Math.max(candidateMs, previousMs + 1) : candidateMs;
    const reserved = new Date(reservedMs).toISOString();
    this.setMetadata("policy_timestamp", reserved);
    return reserved;
  }

  private touch(): void {
    this.setMetadata("updated_at", new Date().toISOString());
  }

  private metadata(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM core_metadata WHERE key = ?").get(key) as MetadataRow | undefined)?.value;
  }

  private setMetadata(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO core_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private payloads<T>(sql: string, ...params: unknown[]): T[] {
    const rows = this.db.prepare(sql).all(...params) as PayloadRow[];
    return rows.map((row) => parsePayload<T>(row.payload_json, "state"));
  }

  private listMachinesSync(): RemoteMachine[] {
    return this.payloads<RemoteMachine>("SELECT payload_json FROM core_machines ORDER BY rowid");
  }

  private snapshot(): BackendState {
    return {
      version: stateVersion,
      provider: this.metadata("provider") || this.provider,
      machines: Object.fromEntries(this.listMachinesSync().map((machine) => [machineKey(machine.user_id || "", machine.name), machine])),
      images: Object.fromEntries(this.payloads<TeamImageRecord>(
        "SELECT payload_json FROM core_images ORDER BY rowid",
      ).map((image) => [imageKey(image), image])),
      policy_events: Object.fromEntries(this.payloads<MachineLifecycleEvent>(
        "SELECT payload_json FROM core_policy_events ORDER BY occurred_at, event_id",
      ).map((event) => [event.id, event])),
      ...(this.metadata("policy_timestamp") ? { policy_timestamp: this.metadata("policy_timestamp") } : {}),
      ...(this.metadata("updated_at") ? { updated_at: this.metadata("updated_at") } : {}),
    };
  }

  private migrate(): void {
    applyBackendMigrations(this.db, "core", coreMigrations);
    this.db.prepare("INSERT OR IGNORE INTO core_metadata (key, value) VALUES ('provider', ?)").run(this.provider);
  }
}

const coreMigrations: BackendDatabaseMigration[] = [{
  version: 1,
  migrate(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS core_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS core_machines (
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        org_id TEXT,
        provider TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(user_id, name)
      );
      CREATE INDEX IF NOT EXISTS core_machines_org ON core_machines(org_id);
      CREATE INDEX IF NOT EXISTS core_machines_provider ON core_machines(provider);
      CREATE TABLE IF NOT EXISTS core_images (
        org_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        identity TEXT NOT NULL,
        image_id TEXT,
        name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(org_id, provider, identity)
      );
      CREATE INDEX IF NOT EXISTS core_images_lookup ON core_images(org_id, provider, name, image_id);
      CREATE TABLE IF NOT EXISTS core_policy_events (
        event_id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
  },
}, {
  version: 2,
  migrate(database) {
    database.exec(`
      CREATE TABLE core_size_shortcuts (
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        plan TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(org_id, name)
      );
      CREATE INDEX core_size_shortcuts_provider ON core_size_shortcuts(provider, plan);
    `);
  },
}, {
  version: 3,
  migrate(database) {
    database.exec(`
      CREATE TABLE core_machine_cleanups (
        machine_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        team_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX core_machine_cleanups_machine_name
        ON core_machine_cleanups(user_id, name);
    `);
  },
}];

function parsePayload<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`invalid ${label} JSON in BoxHaven database`);
  }
}

function normalizedTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`invalid policy timestamp: ${value}`);
  return timestamp.toISOString();
}

function machineKey(userID: string, name: string): string {
  return `${userID}:${name}`;
}

function imageKey(image: TeamImageRecord): string {
  return `${image.org_id}:${image.provider}:${image.id || image.name}`;
}

function cleanupEventID(action: MachineLifecycleAction, machine: RemoteMachine): string {
  const generation = machine.created_at || machine.provider_id || machine.provider_name || machine.name;
  const digest = createHash("sha256")
    .update(`${action.team_id}\n${action.machine_id}\n${generation}`)
    .digest("hex");
  return `policy-cleanup:${digest}`;
}
