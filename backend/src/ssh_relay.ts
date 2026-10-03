import { createHash, createHmac } from "node:crypto";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { WebSocket, createWebSocketStream } from "ws";
import type { StateStore } from "./state.js";
import type { ProviderRegistry } from "./providers.js";
import type { RemoteMachine, SSHAccess } from "./types.js";
import { machineSSHAccess } from "./ssh_access.js";

export type RelayLease = { resource: string; actor: string; team: string; member: string; binding: string; expires: number };
type Member = { id: string; role: string };

/** The same live permission check applies to new grants and established relays. */
export function resourceOperator(store: StateStore, machine: RemoteMachine, actor: string): Member | undefined {
  const member = store.db.prepare("SELECT id, role FROM member WHERE organizationId = ? AND userId = ?")
    .get(machine.org_id || "", actor) as Member | undefined;
  if (!member) return;
  const sharing = store.resourceSharing(machine.resource_id!);
  if (machine.user_id === actor || member.role.split(",").some(role => ["owner", "admin"].includes(role.trim()))
    || (sharing.members.find(grant => grant.member_id === member.id)?.role || sharing.team_role) === "operator") return member;
}

function binding(machine: RemoteMachine): string {
  return createHash("sha256").update(JSON.stringify([machine.provider, machine.provider_id, machine.public_ipv4,
    machine.agent_token_hash])).digest("hex");
}

export class SSHRelay {
  private readonly key: Promise<Buffer>;
  private readonly active = new Map<WebSocket, { lease: RelayLease; stop: () => void }>();

  constructor(private readonly store: StateStore, private readonly providers: ProviderRegistry,
    secret: Promise<string>, private readonly apiURL: string,
    private readonly upstreamAccess = machineSSHAccess) {
    this.key = secret.then(value => createHmac("sha256", value).update("boxhaven-backend-ssh-relay:v1").digest());
  }

  async issue(machine: RemoteMachine, actor: string, expiresAt: string): Promise<SSHAccess> {
    const member = resourceOperator(this.store, machine, actor);
    if (!member || !machine.resource_id || !machine.org_id) throw new Error("Resource access changed");
    const url = new URL(this.apiURL);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new Error("Backend relay requires an HTTPS public URL");
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/v1/resources/${machine.resource_id}/relay/ssh`;
    url.search = ""; url.hash = "";
    return { kind: "websocket", url: url.href, headers: { Authorization: `Bearer ${await this.token(machine, actor, expiresAt, "ssh")}` }, expires_at: expiresAt };
  }

  async preview(machine: RemoteMachine, actor: string): Promise<{ url: string; authentication: "team" }> {
    if (!machine.preview_hostname) throw new Error("Configure BOXHAVEN_PREVIEW_BASE_DOMAIN for backend previews");
    const token = await this.token(machine, actor, new Date(Date.now() + 900000).toISOString(), "preview");
    return { url: `https://${machine.preview_hostname}/_boxhaven/access#${token}`, authentication: "team" };
  }

  private async token(machine: RemoteMachine, actor: string, expiresAt: string, purpose: string): Promise<string> {
    const member = resourceOperator(this.store, machine, actor);
    if (!member || !machine.resource_id || !machine.org_id) throw new Error("Resource access changed");
    return new SignJWT({ team: machine.org_id, member: member.id, binding: binding(machine) })
      .setProtectedHeader({ alg: "HS256" }).setAudience(`boxhaven-backend-${purpose}-relay`)
      .setSubject(actor).setJti(machine.resource_id).setIssuedAt()
      .setExpirationTime(Math.floor(Date.parse(expiresAt) / 1000)).sign(await this.key);
  }

  async authorize(token: string, resource: string, purpose = "ssh"): Promise<RelayLease> {
    const { payload: p } = await jwtVerify(token, await this.key, { audience: `boxhaven-backend-${purpose}-relay`, algorithms: ["HS256"] });
    if (p.jti !== resource || typeof p.sub !== "string" || typeof p.team !== "string" || typeof p.member !== "string"
      || typeof p.binding !== "string" || typeof p.exp !== "number") throw new Error("Invalid relay lease");
    const lease = { resource, actor: p.sub, team: p.team, member: p.member, binding: p.binding, expires: p.exp * 1000 };
    if (!await this.current(lease)) throw new Error("Resource access changed");
    return lease;
  }

  async current(lease: RelayLease): Promise<RemoteMachine | undefined> {
    if (lease.expires <= Date.now()) return;
    const machine = await this.store.getResource(lease.resource);
    if (!machine || machine.org_id !== lease.team || machine.create_state || !machine.bootstrap_complete
      || binding(machine) !== lease.binding || resourceOperator(this.store, machine, lease.actor)?.id !== lease.member) return;
    return machine;
  }

  register(app: FastifyInstance): void {
    const authorized = new WeakMap<object, RelayLease>();
    app.get<{ Params: { resourceID: string } }>("/v1/resources/:resourceID/relay/ssh", {
      websocket: true,
      preValidation: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        try {
          const header = request.headers.authorization || "";
          if (!header.startsWith("Bearer ")) throw new Error("Missing relay lease");
          authorized.set(request, await this.authorize(header.slice(7), request.params.resourceID));
        } catch { return reply.code(403).send({ id: "relay_denied", message: "SSH access expired or was revoked. Reconnect to request access." }); }
      },
    }, (socket, request) => {
      const lease = authorized.get(request)!;
      // Reserve synchronously before any upstream work. Limits include dialing streams.
      const leases = [...this.active.values()].map(value => value.lease);
      if (leases.length >= 128 || leases.filter(value => value.actor === lease.actor).length >= 8
        || leases.filter(value => value.team === lease.team).length >= 32) {
        socket.close(1013, "Relay connection limit reached"); return;
      }
      this.open(socket, lease);
    });
    app.addHook("preClose", async () => { for (const value of this.active.values()) value.stop(); });
  }

  private open(socket: WebSocket, lease: RelayLease): void {
    // Install consumers immediately; async provider grants must not lose early SSH bytes.
    const client = createWebSocketStream(socket, { highWaterMark: 64 * 1024 });
    let upstream: Duplex | undefined, providerSocket: WebSocket | undefined, stopped = false, checking = false;
    let uploaded = 0, downloaded = 0, alive = true;
    const started = Date.now();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(expiry); clearTimeout(dialTimeout); clearInterval(check); clearInterval(heartbeat);
      client.destroy(); upstream?.destroy(); socket.terminate(); providerSocket?.terminate(); this.active.delete(socket);
      // Operational measurements only. Billing needs a durable usage ledger.
      console.info(JSON.stringify({ event: "ssh.relay.closed", resource_id: lease.resource, team_id: lease.team,
        actor_id: lease.actor, duration_ms: Date.now() - started, uploaded_bytes: uploaded, downloaded_bytes: downloaded }));
    };
    const expiry = setTimeout(stop, Math.max(1, lease.expires - Date.now()));
    const dialTimeout = setTimeout(stop, 15000);
    const check = setInterval(() => {
      if (checking || stopped) return;
      checking = true;
      void this.current(lease).then(machine => { if (!machine) stop(); }).catch(stop).finally(() => { checking = false; });
    }, 1000);
    const heartbeat = setInterval(() => { if (!alive) return stop(); alive = false; socket.ping(); }, 30000);
    socket.on("pong", () => { alive = true; });
    socket.on("close", stop); socket.on("error", stop); client.on("error", stop);
    // Text frames are not valid SSH transport messages.
    socket.on("message", (_data, binary) => { if (!binary) stop(); });
    this.active.set(socket, { lease, stop });
    void (async () => {
      const machine = await this.current(lease);
      if (!machine || stopped) return stop();
      const access = await this.upstreamAccess(this.providers.forMachine(machine), machine, lease.actor, new Date(lease.expires).toISOString());
      if (stopped) return;
      if (access.kind === "tcp") {
        const tcp = connect({ host: access.host, port: access.port });
        upstream = tcp;
        tcp.once("connect", () => clearTimeout(dialTimeout));
      } else {
        providerSocket = new WebSocket(access.url, { headers: access.headers, maxPayload: 64 * 1024,
          perMessageDeflate: false, followRedirects: false, handshakeTimeout: 15000 });
        providerSocket.on("error", stop);
        providerSocket.on("unexpected-response", (_req, res) => { res.resume(); stop(); });
        providerSocket.once("open", () => clearTimeout(dialTimeout));
        upstream = createWebSocketStream(providerSocket, { highWaterMark: 64 * 1024 });
      }
      upstream.on("error", stop); upstream.on("close", () => { if (!upstream?.readableEnded) stop(); });
      client.on("data", chunk => { uploaded += chunk.length; });
      upstream.on("data", chunk => { downloaded += chunk.length; });
      client.pipe(upstream).pipe(client);
    })().catch(stop);
  }
}
