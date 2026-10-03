import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BackendModuleContext } from "./module.js";
import type { ResourceOperation, ResourceResponse, ResourceRole, ResourceSharing, SharedResource } from "./resource_types.js";
import type { RemoteMachine } from "./types.js";

type Member = { id: string; role: string };
type ResourceRequest = FastifyRequest<{ Params: { resourceID: string } }>;

export function registerResourceControl(app: FastifyInstance, options: {
  context: BackendModuleContext;
  describe(machine: RemoteMachine): SharedResource;
  preview(machine: RemoteMachine, actorID: string): Promise<{ url: string; authentication: string }>;
  runtimeConnected(machine: RemoteMachine): boolean;
  issueSSH(machine: RemoteMachine, actorID: string, publicKey: string, ttl?: number): Promise<unknown>;
  ensureRuntime(machine: RemoteMachine): Promise<void>;
  prepareSession(machine: RemoteMachine, command: string[], attach: boolean): Promise<unknown>;
}) {
  const { context } = options;
  const { store } = context;
  store.recoverResourceOperations();

  async function authorize(request: ResourceRequest, reply: FastifyReply, required: ResourceRole = "viewer", expectedTeam?: string) {
    reply.header("Cache-Control", "no-store");
    const user = await context.authenticate(request, reply);
    if (!user) return;
    const machine = await store.getResource(request.params.resourceID);
    const member = machine?.org_id ? store.db.prepare("SELECT id, role FROM member WHERE organizationId = ? AND userId = ?")
      .get(machine.org_id, user.userID) as Member | undefined : undefined;
    // Never disclose whether another team's resource ID exists.
    if (!machine || !member || !user.teams.some(team => team.id === machine.org_id) || (expectedTeam !== undefined && expectedTeam !== machine.org_id)) {
      reply.code(404).send({ id: "not_found", message: "Resource is unavailable to this team member." });
      return;
    }
    const sharing = store.resourceSharing(machine.resource_id!);
    const role: ResourceRole = machine.user_id === user.userID || context.roleCanManage(member.role) ? "manager"
      : sharing.members.find(grant => grant.member_id === member.id)?.role || sharing.team_role;
    if ((required === "manager" && role !== "manager") || (required === "operator" && role === "viewer")) {
      reply.code(403).send({ id: "forbidden", message: required === "manager" ? "The resource owner or a team administrator must manage sharing." : "Ask the resource owner or a team administrator for operator access." });
      return;
    }
    return { machine, user, role, sharing };
  }

  app.get<{ Params: { resourceID: string } }>("/v1/resources/:resourceID", async (request, reply): Promise<ResourceResponse | undefined> => {
    const auth = await authorize(request, reply);
    if (!auth) return;
    const { machine } = auth;
    const resource = options.describe(machine);
    return {
      resource, role: auth.role,
      url: `${context.appPublicURL.replace(/\/+$/, "")}/boxes/${machine.resource_id}`,
      capabilities: {
        terminal: !machine.bootstrap_complete || machine.create_state ? "unavailable"
          : machine.ssh_transport || machine.public_ipv4 ? "backend-ssh-relay" : "unavailable",
        session_prepare: machine.bootstrap_complete === true && !machine.create_state && options.runtimeConnected(machine),
        preview: resource.preview,
        active_access_expiry: "lease",
      },
    };
  });

  app.get<{ Params: { resourceID: string } }>("/v1/resources/:resourceID/sharing", async (request, reply) => {
    const auth = await authorize(request, reply, "manager");
    if (auth) return { sharing: auth.sharing };
  });

  app.put<{ Params: { resourceID: string }; Body: ResourceSharing }>("/v1/resources/:resourceID/sharing", async (request, reply) => {
    const auth = await authorize(request, reply, "manager");
    if (!auth) return;
    const sharing = parseSharing(request.body);
    if (!sharing) return reply.code(400).send({ id: "invalid_sharing", message: "Supply the current revision, a viewer/operator team role, and at most 100 distinct member grants." });
    if (sharing.team_id !== auth.machine.org_id) return reply.code(409).send({ id: "team_changed", message: "The resource moved to another team. Reload it before saving sharing." });
    // Grants bind to these membership IDs, so removal invalidates them even during a save.
    const valid = sharing.members.every(grant => !!store.db.prepare("SELECT id FROM member WHERE id = ? AND organizationId = ?")
      .get(grant.member_id, auth.machine.org_id));
    if (!valid) return reply.code(400).send({ id: "invalid_member", message: "Every grant must refer to a current membership of this resource's team." });
    if (!await store.setResourceSharing(auth.machine.resource_id!, auth.machine.org_id!, auth.user.userID, sharing)) {
      return reply.code(409).send({ id: "revision_conflict", message: "Resource sharing changed. Reload it before saving." });
    }
    return { sharing: store.resourceSharing(auth.machine.resource_id!) };
  });

  app.post<{ Params: { resourceID: string }; Body: { public_key?: string; ttl_seconds?: number } }>("/v1/resources/:resourceID/access/ssh", async (request, reply) => {
    const auth = await authorize(request, reply, "operator");
    if (!auth) return;
    if (!auth.machine.bootstrap_complete || auth.machine.create_state) return reply.code(409).send({ id: "not_ready", message: "Resource runtime is not ready." });
    const publicKey = request.body?.public_key;
    const ttl = request.body?.ttl_seconds;
    if (typeof publicKey !== "string" || publicKey.length > 8192 || !/^ssh-[A-Za-z0-9-]+\s+\S+/.test(publicKey)
      || (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 60 || ttl > 900))) {
      return reply.code(400).send({ id: "bad_request", message: "Supply an SSH public key and an optional lifetime of 60–900 seconds." });
    }
    const grant = await options.issueSSH(auth.machine, auth.user.userID, publicKey, ttl);
    const latest = await authorize(request, reply, "operator", auth.machine.org_id);
    if (!latest) return;
    store.db.prepare("INSERT INTO core_resource_audit(resource_id, team_id, actor_id, action, occurred_at) VALUES (?, ?, ?, 'access.ssh', ?)")
      .run(auth.machine.resource_id, auth.machine.org_id, auth.user.userID, new Date().toISOString());
    return { grant };
  });

  app.get<{ Params: { resourceID: string } }>("/v1/resources/:resourceID/preview", async (request, reply) => {
    const auth = await authorize(request, reply, "operator");
    if (!auth) return;
    const resource = options.describe(auth.machine);
    if (resource.preview === "unavailable") return reply.code(409).send({ id: "not_ready", message: "Resource has no preview endpoint." });
    return resource.preview === "team" ? options.preview(auth.machine, auth.user.userID) : { url: resource.preview_url, authentication: "public" };
  });

  app.get<{ Params: { resourceID: string } }>("/v1/resources/:resourceID/operations", async (request, reply) => {
    const auth = await authorize(request, reply, "operator");
    if (auth) return { operations: store.resourceOperations(auth.machine.resource_id!) };
  });

  app.post<{ Params: { resourceID: string }; Body: { command?: string[]; attach?: boolean } }>("/v1/resources/:resourceID/sessions/prepare", async (request, reply) => {
    const auth = await authorize(request, reply, "operator");
    if (!auth) return;
    const key = request.headers["idempotency-key"];
    const command = request.body?.command ?? [];
    const attach = request.body?.attach ?? true;
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)
      || !Array.isArray(command) || command.length > 128 || !command.every(arg => typeof arg === "string" && !arg.includes("\0"))
      || JSON.stringify(command).length > 16384 || typeof attach !== "boolean") {
      return reply.code(400).send({ id: "bad_request", message: "Supply an Idempotency-Key (8–128 characters), command arguments, and an optional attach boolean." });
    }
    const requestHash = createHash("sha256").update(JSON.stringify({ command, attach })).digest("hex");
    const resourceID = auth.machine.resource_id!;
    const replay = () => {
      const saved = store.resourceOperation(resourceID, auth.user.userID, key);
      if (!saved) return reply.code(409).send({ id: "resource_changed", message: "Resource changed while preparing the session." });
      if (saved.requestHash !== requestHash) return reply.code(409).send({ id: "idempotency_conflict", message: "This key was already used for different session arguments." });
      const state = saved.operation.state;
      return reply.code(operationStatus(saved.operation)).send({ operation: saved.operation,
        ...(state === "unknown" ? { id: "outcome_unknown", message: "The session request may have run. Inspect the resource before submitting new work." }
          : state === "failed" ? { id: saved.operation.error_code || "session_failed", message: saved.operation.error_code === "session_exists" ? "A session is already running. Attach to it instead of starting another." : "The session request failed." } : {}),
      });
    };
    if (store.resourceOperation(resourceID, auth.user.userID, key)) return replay();
    if (!auth.machine.bootstrap_complete || auth.machine.create_state || !options.runtimeConnected(auth.machine)) {
      return reply.code(409).send({ id: "not_ready", message: "Resource runtime is not connected. No session request was sent." });
    }
    const operation = await store.reserveResourceOperation(resourceID, auth.machine.org_id!, auth.user.userID, key, requestHash);
    if (!operation) return replay();
    try {
      await options.ensureRuntime(auth.machine);
      // Resuming a sandbox can take a minute. Recheck access before any work starts.
      const latest = await authorize(request, reply, "operator", auth.machine.org_id);
      if (!latest) {
        await store.finishResourceOperation({ ...operation, state: "failed", error_code: "access_changed", updated_at: new Date().toISOString() });
        return;
      }
      const result = sessionResult(await options.prepareSession(latest.machine, command, attach));
      await store.finishResourceOperation({ ...operation, state: "completed", result, updated_at: new Date().toISOString() });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "agent_rpc_failed";
      // A timed-out/disconnected RPC may have started work. Never replay it automatically.
      await store.finishResourceOperation({ ...operation, state: code === "session_exists" ? "failed" : "unknown", error_code: code, updated_at: new Date().toISOString() });
    }
    const latest = await authorize(request, reply, "operator", auth.machine.org_id);
    if (!latest) return;
    return replay();
  });
}

function operationStatus(operation: ResourceOperation): number {
  return operation.state === "completed" ? 200 : operation.state === "pending" ? 202 : 409;
}

function sessionResult(value: unknown): ResourceOperation["result"] {
  if (!value || typeof value !== "object") throw new Error("Invalid runtime session result");
  const result = value as Record<string, unknown>;
  if (!["exists", "started", "started_detached"].includes(String(result.status)) || typeof result.attach_command !== "string" || result.attach_command.length > 8192) {
    throw new Error("Invalid runtime session result");
  }
  return { status: result.status as string, attach_command: result.attach_command, record_command: result.record_command === true };
}

function parseSharing(value: unknown): ResourceSharing | undefined {
  if (!value || typeof value !== "object") return;
  const sharing = value as ResourceSharing;
  if (typeof sharing.team_id !== "string" || !sharing.team_id || sharing.team_id.length > 128
    || !Number.isSafeInteger(sharing.revision) || sharing.revision < 0 || !["viewer", "operator"].includes(sharing.team_role)
    || !Array.isArray(sharing.members) || sharing.members.length > 100) return;
  const members: ResourceSharing["members"] = [];
  const ids = new Set<string>();
  for (const grant of sharing.members) {
    if (!grant || typeof grant.member_id !== "string" || grant.member_id.length > 128 || !grant.member_id || ids.has(grant.member_id) || !["viewer", "operator"].includes(grant.role)) return;
    ids.add(grant.member_id);
    members.push({ member_id: grant.member_id, role: grant.role });
  }
  return { team_id: sharing.team_id, revision: sharing.revision, team_role: sharing.team_role, members };
}
