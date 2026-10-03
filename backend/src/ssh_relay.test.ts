import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket, WebSocketServer } from "ws";
import { SSHRelay } from "./ssh_relay.js";
import { StateStore } from "./state.js";
import { ProviderRegistry } from "./providers.js";
import type { MachineProvider } from "./types.js";

async function fixture(t: TestContext, transport: "tcp" | "websocket" = "tcp") {
  const temp = await mkdtemp(join(tmpdir(), "bh-relay-test-"));
  const store = new StateStore(join(temp, "state.db"), "fake");
  store.db.exec("CREATE TABLE member(id TEXT, organizationId TEXT, userId TEXT, role TEXT)");
  store.db.prepare("INSERT INTO member VALUES ('membership', 'team', 'owner', 'owner')").run();
  await store.putMachine({ name: "box", user_id: "owner", org_id: "team", provider: "fake", bootstrap_complete: true, public_ipv4: "127.0.0.1" });
  const machine = (await store.getMachine("owner", "box"))!;
  const tcp = createServer(socket => { socket.on("error", () => {}); socket.pipe(socket); });
  await new Promise<void>(resolve => tcp.listen(0, "127.0.0.1", resolve));
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  wss.on("connection", socket => socket.on("message", data => socket.send(data)));
  const providers = new ProviderRegistry([{ name: "fake" } as MachineProvider], "fake");
  const app = Fastify();
  let dials = 0;
  const relay = new SSHRelay(store, providers, Promise.resolve("test-secret"), "https://backend.test", async (_p, _m, _a, expires_at) => {
    dials++;
    return transport === "tcp" ? { kind: "tcp", host: "127.0.0.1", port: (tcp.address() as { port: number }).port }
      : { kind: "websocket", url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`, headers: {}, expires_at };
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  relay.register(app);
  await app.ready();
  t.after(async () => { await app.close(); await new Promise<void>(r => tcp.close(() => r())); for (const client of wss.clients) client.terminate(); await new Promise<void>(r => wss.close(() => r())); store.close(); await rm(temp, { recursive: true, force: true }); });
  const grant = async (ttl = 60000) => {
    const access = await relay.issue(machine, "owner", new Date(Date.now()+ttl).toISOString());
    assert.equal(access.kind, "websocket");
    if (access.kind !== "websocket") throw new Error();
    assert.equal(new URL(access.url).host, "backend.test");
    assert.deepEqual(Object.keys(access.headers), ["Authorization"]);
    return access;
  };
  const open = async (input?: Awaited<ReturnType<typeof grant>>) => { const access = input || await grant(); return app.injectWS(new URL(access.url).pathname, { headers: { authorization: access.headers.Authorization } }); };
  return { app, store, machine, relay, grant, open, dials: () => dials };
}

for (const transport of ["tcp", "websocket"] as const) test(`backend relay transfers binary files over ${transport} and revokes an active connection`, async t => {
  const f = await fixture(t, transport);
  const socket = await f.open();
  const payload = randomBytes(5 * 1024 * 1024);
  const received: Buffer[] = []; let size = 0;
  const transferred = new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", data => { const chunk = Buffer.from(data as Buffer); received.push(chunk); size += chunk.length; if (size === payload.length) resolve(); });
  });
  // Starts immediately, while the backend is still resolving upstream access.
  for (let i=0; i<payload.length; i+=32768) socket.send(payload.subarray(i, i+32768));
  await transferred;
  assert.deepEqual(Buffer.concat(received), payload);
  const closed = once(socket, "close");
  f.store.db.prepare("DELETE FROM member").run();
  await closed;
  assert.equal(f.dials(), 1);
});

test("relay rejects wrong resource, tampering, removed/re-added membership, and changed runtime before dialing", async t => {
  const f = await fixture(t); const access = await f.grant();
  assert.equal((await f.app.inject({ url: new URL(access.url).pathname })).statusCode, 403);
  assert.equal((await f.app.inject({ url: new URL(access.url).pathname, headers: { Authorization: access.headers.Authorization + "x" } })).statusCode, 403);
  assert.equal((await f.app.inject({ url: "/v1/resources/another/relay/ssh", headers: access.headers })).statusCode, 403);
  await f.store.putMachine({ ...f.machine, agent_token_hash: "new-runtime" });
  assert.equal((await f.app.inject({ url: new URL(access.url).pathname, headers: access.headers })).statusCode, 403);
  await f.store.putMachine(f.machine);
  f.store.db.prepare("UPDATE member SET id = 'replacement'").run();
  assert.equal((await f.app.inject({ url: new URL(access.url).pathname, headers: access.headers })).statusCode, 403);
  assert.equal(f.dials(), 0);
});

test("relay expires established streams and bounds parallel attachments", async t => {
  const f = await fixture(t);
  const short = await f.open(await f.grant(2000));
  await once(short, "close");
  const sockets = await Promise.all(Array.from({ length: 8 }, () => f.open()));
  const extra = await f.open();
  const [code] = await once(extra, "close"); assert.equal(code, 1013);
  const closed = sockets.map(socket => once(socket, "close"));
  await f.app.close(); await Promise.all(closed);
});

test("preview and SSH grants are not interchangeable and preview grants survive a backend restart", async t => {
  const f = await fixture(t);
  const preview = await f.relay.preview({ ...f.machine, preview_hostname: "box.preview.test" }, "owner");
  const token = new URL(preview.url).hash.slice(1);
  const next = new SSHRelay(f.store, new ProviderRegistry([{ name: "fake" } as MachineProvider], "fake"), Promise.resolve("test-secret"), "https://backend.test");
  await next.authorize(token, f.machine.resource_id!, "preview");
  await assert.rejects(next.authorize(token, f.machine.resource_id!));
  const access = await f.grant();
  await assert.rejects(next.authorize(access.headers.Authorization.slice(7), f.machine.resource_id!, "preview"));
});
