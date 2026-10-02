import type { FastifyInstance } from "fastify";
import type { StateStore } from "./state.js";
import type { RemoteMachine } from "./types.js";

type Headers = Record<string, string | string[] | undefined>;
type TeamEvent = { sequence: number; team_id: string; resource_id: string; kind: "resource.changed" | "resource.removed" };

/** Explicit allowlist: shared snapshots never contain agent credentials or commands. */
export function teamResource(machine: RemoteMachine) {
  return {
    resource_id: machine.resource_id!, name: machine.name, team_id: machine.org_id,
    owner_id: machine.user_id, provider: machine.provider, provider_id: machine.provider_id,
    provider_label: machine.provider_label, region: machine.region, size: machine.size,
    image: machine.image, image_name: machine.image_name, created_at: machine.created_at,
    bootstrap_complete: machine.bootstrap_complete === true, create_state: machine.create_state,
    preview_url: machine.preview_url, project_path: machine.project_path,
    runtime_protocol: machine.runtime_protocol, runtime_version: machine.runtime_version,
  };
}

export function teamSnapshot(store: StateStore, teamID: string) {
  return store.db.transaction(() => ({
    cursor: eventHead(store),
    resources: (store.db.prepare("SELECT payload_json FROM core_machines WHERE org_id = ? ORDER BY name, user_id")
      .all(teamID) as Array<{ payload_json: string }>).map(row => teamResource(JSON.parse(row.payload_json))),
  }))();
}

function eventHead(store: StateStore): number {
  return (store.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS cursor FROM core_team_events").get() as { cursor: number }).cursor;
}

function eventFloor(store: StateStore): number {
  return Number((store.db.prepare("SELECT value FROM core_metadata WHERE key = 'team_event_floor'").get() as { value: string }).value);
}

export function registerTeamSync(app: FastifyInstance, options: {
  store: StateStore;
  authorize(headers: Headers, teamID: string): Promise<"allowed" | "unauthorized" | "forbidden">;
}) {
  const { store, authorize } = options;
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => { for (const close of streams) close(); });

  app.get<{ Params: { teamID: string } }>("/v1/teams/:teamID/resources", async (request, reply) => {
    const access = await authorize(request.headers, request.params.teamID);
    if (access !== "allowed") return reply.code(access === "unauthorized" ? 401 : 403).send({ id: access, message: "Team access is required." });
    reply.header("Cache-Control", "no-store");
    return teamSnapshot(store, request.params.teamID);
  });

  app.get<{ Params: { teamID: string }; Querystring: { cursor?: string } }>("/v1/teams/:teamID/events", async (request, reply) => {
    const teamID = request.params.teamID;
    const access = await authorize(request.headers, teamID);
    if (access !== "allowed") return reply.code(access === "unauthorized" ? 401 : 403).send({ id: access, message: "Team access is required." });
    const rawCursor = request.headers["last-event-id"] ?? request.query.cursor ?? "0";
    let cursor = typeof rawCursor === "string" && /^\d+$/.test(rawCursor) ? Number(rawCursor) : NaN;
    if (!Number.isSafeInteger(cursor) || cursor > eventHead(store)) {
      return reply.code(400).send({ id: "invalid_cursor", message: "Load a team resource snapshot before subscribing." });
    }
    if (cursor < eventFloor(store)) {
      return reply.code(409).send({ id: "cursor_expired", message: "Reload the team resource snapshot." });
    }
    if (streams.size >= 1000) return reply.code(503).send({ id: "stream_limit", message: "Too many active subscriptions." });

    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (typeof value === "string" || typeof value === "number" || Array.isArray(value)) reply.raw.setHeader(name, value);
    }
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no", "X-BoxHaven-Protocol": "1",
    });
    let closed = false;
    let flushing = false;
    let pending = false;
    let blocked = false;
    let drainTimer: NodeJS.Timeout | undefined;
    let unsubscribe = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearTimeout(drainTimer);
      unsubscribe();
      streams.delete(close);
      if (blocked) reply.raw.destroy();
      else reply.raw.end();
    };
    const write = (value: string) => {
      if (closed || blocked) return;
      if (!reply.raw.write(value)) {
        blocked = true;
        drainTimer = setTimeout(close, 10_000).unref();
        reply.raw.once("drain", () => {
          clearTimeout(drainTimer);
          blocked = false;
          void flush();
        });
      }
    };
    const flush = async () => {
      if (closed || blocked) return;
      if (flushing) { pending = true; return; }
      flushing = true;
      try {
        if (await authorize(request.headers, teamID) !== "allowed") {
          write("event: access.revoked\ndata: {}\n\n");
          close();
          return;
        }
        if (closed) return;
        if (cursor < eventFloor(store)) {
          write("event: sync.reset\ndata: {}\n\n");
          close();
          return;
        }
        const head = eventHead(store);
        const events = store.db.prepare("SELECT sequence, team_id, resource_id, kind FROM core_team_events WHERE team_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 128")
          .all(teamID, cursor, head) as TeamEvent[];
        for (const event of events) {
          write(`id: ${event.sequence}\nevent: ${event.kind}\ndata: ${JSON.stringify({ resource_id: event.resource_id, cursor: event.sequence })}\n\n`);
          cursor = event.sequence;
          if (blocked) break;
        }
        if (events.length === 128 || blocked) pending = true;
        else {
          cursor = head;
          write(`id: ${cursor}\nevent: sync.checkpoint\ndata: {}\n\n`);
        }
      } catch {
        close();
      } finally {
        flushing = false;
        if (pending && !closed && !blocked) { pending = false; queueMicrotask(() => void flush()); }
      }
    };
    // Also catches revoked membership/session and changes from another DB writer.
    const timer = setInterval(() => void flush(), 10_000).unref();
    unsubscribe = store.subscribeChanges(() => void flush(), close);
    streams.add(close);
    reply.raw.on("close", close);
    reply.raw.on("error", close);
    write("retry: 1000\n\n");
    void flush();
  });
}
