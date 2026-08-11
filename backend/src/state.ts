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
type MachineCreateReservationRow = {
  operation_id: string;
  org_id: string;
  user_id: string;
  name: string;
  provider: string | null;
  provider_name: string | null;
  started_at: string;
};

export type TeamDeletionBlockers = {
  machines: number;
  provisioning: number;
  policies: Array<{ policy: string; message: string }>;
  deletionState?: "deleting" | "deleted";
};

export type DeletionAuditRecord = {
  id: number;
  occurred_at: string;
  action: "team.delete";
  actor_user_id: string;
  actor_email: string;
  target_id: string;
  target_name: string;
  outcome: "succeeded" | "denied" | "failed";
  detail: string;
};

export class DeletionGuardError extends Error {
  constructor(
    readonly code: "team_deleting" | "user_deleting",
    message: string,
  ) {
    super(message);
    this.name = "DeletionGuardError";
  }
}

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
    this.recoverInterruptedMachineCreates();
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
        return { generatedAt, machines: this.listMachinesSync().filter((machine) => !machine.create_state) };
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

  async reserveMachineCreate(input: {
    operationID: string;
    orgID: string;
    userID: string;
    name: string;
    provider: string;
    providerName: string;
    machine: RemoteMachine;
  }): Promise<void> {
    await this.enqueue(async () => {
      await this.beforeMutation();
      this.db.transaction(() => {
        const teamDeletion = this.db.prepare(
          "SELECT state FROM core_team_deletions WHERE org_id = ?",
        ).get(input.orgID) as { state: "deleting" | "deleted" } | undefined;
        if (teamDeletion) {
          throw new DeletionGuardError(
            "team_deleting",
            teamDeletion.state === "deleted"
              ? "This team has been deleted. Choose another team before creating a box."
              : "This team is being deleted. Wait for deletion to finish or choose another team.",
          );
        }
        const userDeletion = this.db.prepare(
          "SELECT state FROM core_user_deletions WHERE user_id = ?",
        ).get(input.userID) as { state: "deleting" | "deleted" } | undefined;
        if (userDeletion) {
          throw new DeletionGuardError(
            "user_deleting",
            "This account is being deleted and cannot create boxes.",
          );
        }
        if (
          input.machine.user_id !== input.userID
          || input.machine.org_id !== input.orgID
          || input.machine.name !== input.name
          || input.machine.provider !== input.provider
          || input.machine.provider_name !== input.providerName
          || input.machine.create_operation_id !== input.operationID
          || input.machine.create_state !== "provisioning"
        ) {
          throw new Error("machine create reservation does not match its durable provisioning record");
        }
        const startedAt = new Date().toISOString();
        this.db.prepare(`
          INSERT INTO core_machine_creates (
            operation_id, org_id, user_id, name, provider, provider_name, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.operationID,
          input.orgID,
          input.userID,
          input.name,
          input.provider,
          input.providerName,
          startedAt,
        );
        this.db.prepare(`
          INSERT INTO core_machines (user_id, name, org_id, provider, payload_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          input.userID,
          input.name,
          input.orgID,
          input.provider,
          JSON.stringify(input.machine),
        );
        this.touch();
      })();
    });
  }

  async releaseMachineCreate(operationID: string): Promise<void> {
    await this.mutate(() => {
      const reservation = this.db.prepare(`
        SELECT operation_id, org_id, user_id, name, provider, provider_name, started_at
        FROM core_machine_creates WHERE operation_id = ?
      `).get(operationID) as MachineCreateReservationRow | undefined;
      if (reservation) this.markMachineCreateRecoveryRequired(reservation);
      this.db.prepare("DELETE FROM core_machine_creates WHERE operation_id = ?").run(operationID);
    });
  }

  async cancelMachineCreate(operationID: string): Promise<void> {
    await this.mutate(() => {
      const reservation = this.db.prepare(`
        SELECT operation_id, org_id, user_id, name, provider, provider_name, started_at
        FROM core_machine_creates WHERE operation_id = ?
      `).get(operationID) as MachineCreateReservationRow | undefined;
      if (reservation) {
        const row = this.db.prepare(`
          SELECT payload_json FROM core_machines WHERE user_id = ? AND name = ?
        `).get(reservation.user_id, reservation.name) as PayloadRow | undefined;
        if (row) {
          const machine = parsePayload<RemoteMachine>(row.payload_json, "machine");
          if (machine.create_operation_id === operationID) {
            this.db.prepare("DELETE FROM core_machines WHERE user_id = ? AND name = ?")
              .run(reservation.user_id, reservation.name);
          }
        }
      }
      this.db.prepare("DELETE FROM core_machine_creates WHERE operation_id = ?").run(operationID);
    });
  }

  async beginTeamDeletion(input: {
    operationID: string;
    orgID: string;
    actorUserID: string;
    actorEmail: string;
  }): Promise<TeamDeletionBlockers> {
    return this.enqueue(async () => {
      await this.beforeMutation();
      return this.db.transaction(() => {
        const blockers = this.teamDeletionBlockersSync(input.orgID);
        if (blockers.machines > 0 || blockers.provisioning > 0 || blockers.policies.length > 0 || blockers.deletionState) {
          return blockers;
        }
        const now = new Date().toISOString();
        this.db.prepare(`
          INSERT INTO core_team_deletions (
            org_id, operation_id, state, actor_user_id, actor_email, started_at, updated_at
          ) VALUES (?, ?, 'deleting', ?, ?, ?, ?)
        `).run(input.orgID, input.operationID, input.actorUserID, input.actorEmail, now, now);
        this.touch();
        return blockers;
      })();
    });
  }

  async cancelTeamDeletion(orgID: string, operationID: string): Promise<void> {
    await this.mutate(() => {
      this.db.prepare(`
        DELETE FROM core_team_deletions
        WHERE org_id = ? AND operation_id = ? AND state = 'deleting'
      `).run(orgID, operationID);
    });
  }

  async completeTeamDeletion(orgID: string, operationID: string): Promise<void> {
    await this.mutate(() => {
      const updated = this.db.prepare(`
        UPDATE core_team_deletions SET state = 'deleted', updated_at = ?
        WHERE org_id = ? AND operation_id = ? AND state = 'deleting'
      `).run(new Date().toISOString(), orgID, operationID);
      if (updated.changes === 1) return;
      const existing = this.db.prepare(`
        SELECT state FROM core_team_deletions WHERE org_id = ? AND operation_id = ?
      `).get(orgID, operationID) as { state: "deleting" | "deleted" } | undefined;
      if (existing?.state !== "deleted") throw new Error("team deletion guard was lost before completion");
    });
  }

  async repairCompletedTeamDeletion(input: {
    orgID: string;
    operationID: string;
    actorUserID: string;
    actorEmail: string;
  }): Promise<void> {
    await this.mutate(() => {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO core_team_deletions (
          org_id, operation_id, state, actor_user_id, actor_email, started_at, updated_at
        ) VALUES (?, ?, 'deleted', ?, ?, ?, ?)
        ON CONFLICT(org_id) DO UPDATE SET
          operation_id = excluded.operation_id,
          state = 'deleted',
          actor_user_id = excluded.actor_user_id,
          actor_email = excluded.actor_email,
          updated_at = excluded.updated_at
      `).run(input.orgID, input.operationID, input.actorUserID, input.actorEmail, now, now);
    });
  }

  async teamDeletionBlockers(orgID: string): Promise<TeamDeletionBlockers> {
    return this.teamDeletionBlockersSync(orgID);
  }

  async setTeamDeletionPolicyBlocker(orgID: string, policy: string, message?: string): Promise<void> {
    await this.mutate(() => {
      if (!message) {
        this.db.prepare(`
          DELETE FROM core_team_deletion_policy_blockers WHERE org_id = ? AND policy = ?
        `).run(orgID, policy);
        return;
      }
      this.db.prepare(`
        INSERT INTO core_team_deletion_policy_blockers (org_id, policy, message, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(org_id, policy) DO UPDATE SET
          message = excluded.message,
          updated_at = excluded.updated_at
      `).run(orgID, policy, message.slice(0, 500), new Date().toISOString());
    });
  }

  async recordDeletionAudit(input: Omit<DeletionAuditRecord, "id" | "occurred_at">): Promise<void> {
    await this.mutate(() => {
      this.db.prepare(`
        INSERT INTO core_deletion_audit (
          occurred_at, action, actor_user_id, actor_email,
          target_id, target_name, outcome, detail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        new Date().toISOString(),
        input.action,
        input.actor_user_id,
        input.actor_email,
        input.target_id,
        input.target_name,
        input.outcome,
        input.detail.slice(0, 500),
      );
    });
  }

  async listDeletionAudit(): Promise<DeletionAuditRecord[]> {
    return this.db.prepare(`
      SELECT id, occurred_at, action, actor_user_id, actor_email,
        target_id, target_name, outcome, detail
      FROM core_deletion_audit ORDER BY id
    `).all() as DeletionAuditRecord[];
  }

  // Better Auth deletes organizations in its own transaction/connection. This
  // trigger is the final race barrier after auth migrations have created the
  // organization table; a late machine reservation or module blocker aborts
  // that whole Better Auth transaction, including member deletion.
  ensureOrganizationDeletionSafety(): void {
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS core_safe_organization_delete
      BEFORE DELETE ON organization
      WHEN EXISTS (SELECT 1 FROM core_machines WHERE org_id = OLD.id)
        OR EXISTS (SELECT 1 FROM core_machine_creates WHERE org_id = OLD.id)
        OR EXISTS (SELECT 1 FROM core_team_deletion_policy_blockers WHERE org_id = OLD.id)
      BEGIN
        SELECT RAISE(ABORT, 'BOXHAVEN_TEAM_DELETION_BLOCKED');
      END;
    `);
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
    const userDeletion = this.db.prepare(
      "SELECT state FROM core_user_deletions WHERE user_id = ?",
    ).get(userID) as { state: "deleting" | "deleted" } | undefined;
    if (userDeletion) {
      throw new DeletionGuardError(
        "user_deleting",
        userDeletion.state === "deleted"
          ? "This account has been deleted."
          : "This account is being deleted.",
      );
    }
    if (machine.org_id) {
      const deletion = this.db.prepare(
        "SELECT state FROM core_team_deletions WHERE org_id = ?",
      ).get(machine.org_id) as { state: "deleting" | "deleted" } | undefined;
      if (deletion) {
        throw new DeletionGuardError(
          "team_deleting",
          deletion.state === "deleted"
            ? "This team has been deleted."
            : "This team is being deleted.",
        );
      }
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

  private teamDeletionBlockersSync(orgID: string): TeamDeletionBlockers {
    const machines = (this.db.prepare(
      "SELECT COUNT(*) AS count FROM core_machines WHERE org_id = ?",
    ).get(orgID) as { count: number }).count;
    const provisioning = (this.db.prepare(
      "SELECT COUNT(*) AS count FROM core_machine_creates WHERE org_id = ?",
    ).get(orgID) as { count: number }).count;
    const policies = this.db.prepare(`
      SELECT policy, message FROM core_team_deletion_policy_blockers
      WHERE org_id = ? ORDER BY policy
    `).all(orgID) as Array<{ policy: string; message: string }>;
    const deletion = this.db.prepare(
      "SELECT state FROM core_team_deletions WHERE org_id = ?",
    ).get(orgID) as { state: "deleting" | "deleted" } | undefined;
    return {
      machines,
      provisioning,
      policies,
      ...(deletion ? { deletionState: deletion.state } : {}),
    };
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

  // Create and capacity reservations are owned by one backend process and are
  // cleared on startup. The paired machine row is durable: it is either already
  // the successfully persisted provider machine or becomes recovery-required,
  // so a crash cannot permanently retain a reservation or reopen deletion.
  private recoverInterruptedMachineCreates(): void {
    this.db.transaction(() => {
      const reservations = this.db.prepare(`
        SELECT operation_id, org_id, user_id, name, provider, provider_name, started_at
        FROM core_machine_creates ORDER BY started_at, operation_id
      `).all() as MachineCreateReservationRow[];
      for (const reservation of reservations) this.markMachineCreateRecoveryRequired(reservation, true);
      if (reservations.length > 0) {
        this.db.prepare("DELETE FROM core_machine_creates").run();
        this.touch();
      }
    })();
  }

  private markMachineCreateRecoveryRequired(reservation: MachineCreateReservationRow, createIfMissing = false): void {
    const row = this.db.prepare(`
      SELECT payload_json FROM core_machines WHERE user_id = ? AND name = ?
    `).get(reservation.user_id, reservation.name) as PayloadRow | undefined;
    if (!row) {
      if (!createIfMissing) return;
      const recovered: RemoteMachine = {
        name: reservation.name,
        user_id: reservation.user_id,
        org_id: reservation.org_id,
        provider: reservation.provider || this.provider,
        provider_name: reservation.provider_name || providerMachineNameForRecovery(reservation.user_id, reservation.name),
        create_state: "recovery_required",
        created_at: reservation.started_at,
        updated_at: new Date().toISOString(),
      };
      this.db.prepare(`
        INSERT INTO core_machines (user_id, name, org_id, provider, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(recovered.user_id, recovered.name, recovered.org_id, recovered.provider, JSON.stringify(recovered));
      return;
    }
    const machine = parsePayload<RemoteMachine>(row.payload_json, "machine");
    if (machine.create_operation_id !== reservation.operation_id) return;
    delete machine.create_operation_id;
    machine.create_state = "recovery_required";
    machine.updated_at = new Date().toISOString();
    this.db.prepare(`
      UPDATE core_machines SET payload_json = ? WHERE user_id = ? AND name = ?
    `).run(JSON.stringify(machine), reservation.user_id, reservation.name);
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
}, {
  version: 4,
  migrate(database) {
    database.exec(`
      CREATE TABLE core_machine_creates (
        operation_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        provider TEXT,
        provider_name TEXT,
        started_at TEXT NOT NULL,
        UNIQUE(user_id, name)
      );
      CREATE INDEX core_machine_creates_org ON core_machine_creates(org_id);
      CREATE INDEX core_machine_creates_user ON core_machine_creates(user_id);
      CREATE TABLE core_team_deletions (
        org_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('deleting', 'deleted')),
        actor_user_id TEXT NOT NULL,
        actor_email TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE core_user_deletions (
        user_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('deleting', 'deleted')),
        actor_user_id TEXT NOT NULL,
        actor_email TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE core_team_deletion_policy_blockers (
        org_id TEXT NOT NULL,
        policy TEXT NOT NULL,
        message TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(org_id, policy)
      );
      CREATE TABLE core_deletion_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('team.delete')),
        actor_user_id TEXT NOT NULL,
        actor_email TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_name TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'denied', 'failed')),
        detail TEXT NOT NULL
      );
      CREATE INDEX core_deletion_audit_target ON core_deletion_audit(target_id, occurred_at DESC);
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

// Keep this deterministic fallback aligned with the provider resource naming
// used by the server. It recovers reservations written by core migration v3,
// before provider identity was persisted in the reservation row.
function providerMachineNameForRecovery(userID: string, machineName: string): string {
  const hash = createHash("sha256").update(userID).digest("hex").slice(0, 10);
  const base = machineName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "machine";
  return `${base.slice(0, 52)}-${hash}`;
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
