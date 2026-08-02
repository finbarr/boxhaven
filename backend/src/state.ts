import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { applyBackendMigrations, type BackendDatabaseMigration } from "./database.js";
import type { MachineLifecycleEvent } from "./policy.js";
import { BackendState, RemoteMachine, TeamImageRecord, stateVersion } from "./types.js";

type PayloadRow = { payload_json: string };
type MetadataRow = { value: string };

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
      this.db.prepare("DELETE FROM core_machines WHERE user_id = ? AND name = ?").run(userID, fromName);
      this.writeMachine(machine);
    });
  }

  async deleteMachine(userID: string, name: string, policyEvent?: MachineLifecycleEvent): Promise<void> {
    await this.mutate(() => {
      this.db.prepare("DELETE FROM core_machines WHERE user_id = ? AND name = ?").run(userID, name);
      if (policyEvent) this.writePolicyEvent(policyEvent, true);
    });
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

  protected async beforeMutation(): Promise<void> {}

  private async mutate(fn: () => void): Promise<void> {
    await this.enqueue(async () => {
      await this.beforeMutation();
      this.db.transaction(() => {
        fn();
        this.touch();
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
    this.db.prepare(`
      INSERT INTO core_machines (user_id, name, org_id, provider, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, name) DO UPDATE SET
        org_id = excluded.org_id,
        provider = excluded.provider,
        payload_json = excluded.payload_json
    `).run(userID, machine.name, machine.org_id || null, machine.provider || null, JSON.stringify(machine));
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
