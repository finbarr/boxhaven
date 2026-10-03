// Real sandbox conformance against an isolated backend. Only authenticated
// agent callbacks and scoped SSH relay upgrades are exposed by the test tunnel.
// Set BOXHAVEN_SMOKE_PROVIDER and the provider credentials/image configuration.
// Run: node --import tsx scripts/smoke-sandbox.mjs
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createBackendAuth, migrateBackendAuth } from "../src/auth.ts";
import { providerRegistryFromEnv } from "../src/providers.ts";
import { createBackend } from "../src/server.ts";
import { SSHRelay } from "../src/ssh_relay.ts";
import { SSHCertificateAuthority } from "../src/ssh_ca.ts";
import { StateStore } from "../src/state.ts";

const exec = promisify(execFile);
const providerName = process.env.BOXHAVEN_SMOKE_PROVIDER;
const expectNetworkBlocked = process.argv.includes("--expect-backend-network-blocked");
assert.ok(!expectNetworkBlocked || providerName === "daytona", "The network restriction check is for Daytona");
assert.ok(["e2b", "daytona", "blaxel"].includes(providerName), "Set BOXHAVEN_SMOKE_PROVIDER to e2b, daytona, or blaxel");
const providers = providerRegistryFromEnv({ ...process.env, BOXHAVEN_BACKEND_PROVIDER: providerName });
const provider = providers.default;
const cloudflared = process.env.CLOUDFLARED || "cloudflared";
const root = resolve(import.meta.dirname, "../..");
const temp = await mkdtemp(join(tmpdir(), `boxhaven-${providerName}-smoke-`));
// Keep provider diagnostics local: SDK errors may contain private request data.
for (const method of ["provision", "bootstrap"]) {
  const original = provider[method].bind(provider);
  provider[method] = async (...args) => {
    try { const result = await original(...args); console.log(`Provider ${method} completed`); return result; }
    catch (error) {
      await writeFile(join(temp, `${method}-private.json`), JSON.stringify({ name: error.name, message: error.message, code: error.code, exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr }, null, 2), { mode: 0o600 });
      throw error;
    }
  };
}
const suffix = randomBytes(5).toString("hex");
const machineName = `${providerName}-smoke-${suffix}`;
const digest = value => createHash("sha256").update(value).digest("hex");
const sockets = new Set();
let app, store, gateway, tunnel, backendPort, resourceID, attempted = false, token, remote;
let tunnelLog = "";
const quote = s => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const delay = ms => new Promise(r => setTimeout(r, ms));
async function api(method, path, body) {
  return app.inject({ method, url: path, headers: { authorization: `Bearer ${token}`, "idempotency-key": `smoke-${suffix}` }, ...(body ? { payload: body } : {}) });
}
function ok(response, expected = 200) {
  let body = {};
  try { body = response.json(); } catch { /* Some auth responses have no body. */ }
  assert.equal(response.statusCode, expected, `HTTP ${response.statusCode}: ${body.id || body.error || "request failed"}: ${body.message || ""}`);
  return body;
}
async function run() {
try {
  gateway = createServer((_req, res) => { res.writeHead(404); res.end(); });
  gateway.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  gateway.on("upgrade", (req, socket, head) => {
    if (!(req.url === "/v1/agent/connect" || /^\/v1\/resources\/[a-f0-9-]+\/relay\/ssh$/.test(req.url)) || !backendPort || !req.headers.authorization) { socket.destroy(); return; }
    const upstream = connect(backendPort, "127.0.0.1", () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy()); upstream.on("close", () => socket.destroy());
  });
  await new Promise(r => gateway.listen(0, "127.0.0.1", r));
  tunnel = spawn(cloudflared, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", `http://127.0.0.1:${gateway.address().port}`], { stdio: ["ignore", "ignore", "pipe"] });
  let tunnelError;
  tunnel.on("error", error => { tunnelError = error; });
  tunnel.stderr.on("data", chunk => { tunnelLog = (tunnelLog + chunk).slice(-65536); });
  let publicURL;
  for (let i = 0; i < 120; i++) {
    if (tunnelError) throw tunnelError;
    if (tunnel.exitCode !== null) throw new Error("Cloudflare test tunnel stopped");
    publicURL = tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    if (publicURL) break;
    await delay(500);
  }
  assert.ok(publicURL, "Cloudflare did not allocate a test tunnel");
  console.log("Test tunnel allocated; waiting for public routing");
  // Confirm the public endpoint cannot expose the backend's account/control API.
  for (let i = 0; ; i++) {
    try { const r = await fetch(`${publicURL}/v1/providers`, { signal: AbortSignal.timeout(5000) }); assert.equal(r.status, 404); await r.body.cancel(); break; }
    catch (error) { if (i === 24) throw error; await delay(5000); }
  }
  const databasePath = join(temp, "backend.sqlite");
  store = new StateStore(databasePath, providerName);
  const emails = [];
  const authOptions = { baseURL: "http://127.0.0.1/v1/auth", databasePath, secret: randomBytes(32).toString("hex"), email: { async send(message) { emails.push(message); } } };
  await migrateBackendAuth(authOptions);
  const sshCA = new SSHCertificateAuthority(join(temp, "ca"));
  const startBackend = () => createBackend({ auth: createBackendAuth(authOptions), providers, store, sshCA, apiPublicURL: publicURL, previewBaseDomain: "preview.smoke.test", machineReadyTimeoutMs: 90000, maxMachinesPerUser: 1 });
  app = startBackend();
  await app.listen({ host: "127.0.0.1", port: 0 }); backendPort = app.server.address().port;
  const email = `smoke-${suffix}@example.com`, password = randomBytes(24).toString("hex");
  ok(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", payload: { email, password, name: `${providerName} smoke` } }));
  const verification = new URL(emails.at(-1).text.match(/https?:\/\/\S+\/verify-email\?\S+/)[0]);
  ok(await app.inject({ url: `${verification.pathname}?token=${encodeURIComponent(verification.searchParams.get("token"))}` }));
  token = ok(await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", payload: { email, password } })).token;
  console.log(`Creating disposable ${providerName} sandbox ${machineName}`);
  attempted = true;
  const createResponse = await api("POST", "/v1/machines", { name: machineName, provider: providerName });
  if (expectNetworkBlocked) {
    assert.equal(createResponse.statusCode, 500);
    assert.match(createResponse.json().message, /Daytona cannot reach the BoxHaven backend/);
    const recovery = ok(await api("GET", "/v1/machines")).machines.find(machine => machine.name === machineName);
    assert.ok(recovery, "Failed setup must retain a discoverable recovery box");
    console.log("PASS: clear network-policy error and recoverable create; full runtime smoke was not run");
    return;
  }
  const created = ok(createResponse, 201);
  resourceID = created.machine.resource_id;
  assert.ok(resourceID);
  console.log("PASS: provider create and authenticated guest callback");

  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(temp, "device")]);
  const detail = ok(await api("GET", `/v1/resources/${resourceID}`));
  assert.equal(detail.role, "manager"); assert.equal(detail.capabilities.session_prepare, true);
  const { grant } = ok(await api("POST", `/v1/resources/${resourceID}/access/ssh`, { public_key: await readFile(join(temp, "device.pub"), "utf8") }));
  assert.equal(grant.access.kind, "websocket");
  assert.equal(new URL(grant.access.url).host, new URL(publicURL).host);
  assert.deepEqual(Object.keys(grant.access.headers), ["Authorization"]);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(grant.access.url, { headers: grant.access.headers, handshakeTimeout: 15000 });
    ws.on("open", () => { ws.close(); resolve(); });
    ws.on("error", error => reject(new Error(`Provider WebSocket handshake failed (${error.code || "protocol error"})`)));
    ws.on("unexpected-response", (_request, response) => {
      response.resume(); ws.terminate(); reject(new Error(`Provider WebSocket handshake returned HTTP ${response.statusCode}`));
    });
  });
  await writeFile(join(temp, "device-cert.pub"), grant.certificate + "\n", { mode: 0o600 });
  await writeFile(join(temp, "access.json"), JSON.stringify(grant.access), { mode: 0o600 });
  const sshArgs = ["-F", "/dev/null", "-i", join(temp, "device"), "-o", `CertificateFile=${temp}/device-cert.pub`, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${temp}/known_hosts`, "-o", `ProxyCommand=${quote(join(root, "bh"))} ssh-proxy ${quote(join(temp, "access.json"))}`];
  const destination = `${grant.ssh_user}@${grant.host}`;
  remote = (command, timeout = 30000) => exec("ssh", [...sshArgs, destination, command], { timeout });
  assert.equal((await remote("printf certificate-over-sandbox-ok")).stdout, "certificate-over-sandbox-ok");
  sshArgs[sshArgs.indexOf("StrictHostKeyChecking=accept-new")] = "StrictHostKeyChecking=yes";
  const payload = randomBytes(2 * 1024 * 1024);
  await writeFile(join(temp, "payload.bin"), payload);
  const rsyncSSH = ["ssh", ...sshArgs].map(quote).join(" ");
  await exec("rsync", ["-a", "-e", rsyncSSH, join(temp, "payload.bin"), `${destination}:/opt/boxhaven/project/payload.bin`], { timeout: 60000 });
  assert.equal((await remote("sha256sum /opt/boxhaven/project/payload.bin")).stdout.split(" ")[0], digest(payload));
  await exec("rsync", ["-a", "-e", rsyncSSH, `${destination}:/opt/boxhaven/project/payload.bin`, join(temp, "download.bin")], { timeout: 60000 });
  assert.equal(digest(await readFile(join(temp, "download.bin"))), digest(payload));
  console.log("PASS: backend-relayed certificate SSH, pinned host, and file upload");
  const prepared = ok(await api("POST", `/v1/resources/${resourceID}/sessions/prepare`, { command: ["bash", "-lc", "sleep 2; printf persistent-session-ok > /opt/boxhaven/project/result.txt; sleep 300"], attach: false }));
  assert.equal(prepared.operation.state, "completed");
  await remote("for i in $(seq 1 45); do test -f /opt/boxhaven/project/result.txt && exit 0; sleep 1; done; tmux list-sessions; tmux capture-pane -p -t boxhaven; exit 1", 60000);
  await exec("rsync", ["-a", "-e", rsyncSSH, `${destination}:/opt/boxhaven/project/result.txt`, join(temp, "result.txt")], { timeout: 30000 });
  assert.equal(await readFile(join(temp, "result.txt"), "utf8"), "persistent-session-ok");
  console.log("PASS: durable session preparation, detached work, reconnect, and file download");
  for (const socket of sockets) socket.destroy();
  await app.close();
  store.close();
  store = new StateStore(databasePath, providerName);
  app = startBackend();
  await app.listen({ host: "127.0.0.1", port: 0 }); backendPort = app.server.address().port;
  for (let i = 0; ; i++) {
    if (ok(await api("GET", `/v1/resources/${resourceID}`)).resource.status === "online") break;
    assert.ok(i < 90, "Guest agent did not reconnect after backend restart");
    await delay(1000);
  }
  const reattached = ok(await app.inject({ method: "POST", url: `/v1/resources/${resourceID}/sessions/prepare`,
    headers: { authorization: `Bearer ${token}`, "idempotency-key": `restart-${suffix}` }, payload: { command: [], attach: true } }));
  assert.equal(reattached.operation.result.status, "exists");
  assert.equal((await remote("cat /opt/boxhaven/project/result.txt")).stdout, "persistent-session-ok");
  console.log("PASS: backend restart, guest reconnect, and detached session recovery");
  const machine = await store.getResource(resourceID);
  if (providerName === "e2b") {
    const { Sandbox } = await import("e2b");
    await Sandbox.pause(machine.provider_id, { apiKey: process.env.E2B_API_KEY, keepMemory: true });
    for (const socket of sockets) socket.destroy();
    await delay(500);
    assert.equal((await Sandbox.getInfo(machine.provider_id, { apiKey: process.env.E2B_API_KEY })).state, "paused");
    const resumed = ok(await app.inject({ method: "POST", url: `/v1/resources/${resourceID}/sessions/prepare`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": `resume-${suffix}` }, payload: { command: [], attach: true } }));
    assert.equal(resumed.operation.result.status, "exists");
    assert.equal((await remote("cat /opt/boxhaven/project/result.txt")).stdout, "persistent-session-ok");
    console.log("PASS: memory-preserving pause, backend-triggered resume, existing session and pinned host survive");
  }
  const relay = new SSHRelay(store, providers, Promise.resolve(authOptions.secret), publicURL);
  const short = await relay.issue(machine, machine.user_id, new Date(Date.now() + 10000).toISOString());
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(short.url, { headers: short.headers }); let opened = false;
    const timeout = setTimeout(() => { ws.terminate(); reject(new Error("Hosted stream remained open after expiry")); }, 15000);
    ws.on("open", () => { opened = true; }); ws.on("error", error => { clearTimeout(timeout); reject(error); });
    ws.on("close", () => {
      clearTimeout(timeout);
      if (!opened) reject(new Error("Hosted stream failed to open"));
      else if (Date.now() < Date.parse(short.expires_at) - 1000) reject(new Error("Hosted stream closed before grant expiry"));
      else resolve();
    });
  });
  // Exercise a real HTTP app through the provider and the authenticated backend proxy.
  await writeFile(join(temp, "preview.cjs"), `
const http = require('node:http');
const {WebSocketServer} = require('/usr/local/lib/boxhaven/node_modules/ws');
const server = http.createServer((req,res) => {res.setHeader('content-type','text/html');res.end('<h1>Private BoxHaven preview</h1><p>persistent-session-ok</p>');});
const wss = new WebSocketServer({server}); wss.on('connection', ws => ws.on('message', data => ws.send(data)));
server.listen(8081,'0.0.0.0');
`);
  await exec("rsync", ["-a", "-e", rsyncSSH, join(temp, "preview.cjs"), `${destination}:/opt/boxhaven/project/preview.cjs`], { timeout: 30000 });
  await remote("nohup node /opt/boxhaven/project/preview.cjs >/tmp/bh-preview-smoke.log 2>&1 </dev/null &");
  await delay(1000);
  const preview = ok(await api("GET", `/v1/resources/${resourceID}/preview`));
  assert.equal(preview.authentication, "team");
  const cliPreview = JSON.parse((await exec(join(root, "bh"), ["preview", machineName, "--json"], {
    cwd: temp, env: { ...process.env, BOXHAVEN_BACKEND_URL: `http://127.0.0.1:${backendPort}`, BOXHAVEN_TOKEN: token }, timeout: 30000,
  })).stdout);
  assert.equal(cliPreview.authentication, "team");
  assert.equal(new URL(cliPreview.url).hostname, new URL(preview.url).hostname);
  const launch = new URL(preview.url), previewPath = `/v1/preview/proxy/${launch.hostname}`;
  assert.equal((await app.inject({ url: `${previewPath}/result.txt`, headers: { host: launch.hostname } })).statusCode, 403);
  const session = await app.inject({ method: "POST", url: `${previewPath}/_boxhaven/session`, headers: {
    host: launch.hostname, origin: launch.origin, authorization: `Bearer ${launch.hash.slice(1)}`,
  } });
  ok(session);
  const cookie = String(session.headers["set-cookie"]).split(";")[0];
  const page = await app.inject({ url: `${previewPath}/result.txt`, headers: { host: launch.hostname, cookie } });
  assert.equal(page.statusCode, 200); assert.match(page.body, /persistent-session-ok/);
  const ws = await app.injectWS(`${previewPath}/hmr`, { headers: { host: launch.hostname, cookie, origin: launch.origin } });
  const echoed = new Promise((resolve, reject) => { ws.once("message", data => resolve(data.toString())); ws.once("error", reject); });
  ws.send("private-hmr-ok"); assert.equal(await echoed, "private-hmr-ok");
  const executablePath = [process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(path => path && existsSync(path));
  assert.ok(executablePath, "Chrome is required for the private preview browser smoke");
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const tab = await browser.newPage();
    // Intercept only the test hostname; exercise the real backend handlers and
    // browser cookie/fragment behavior without changing production DNS or TLS.
    await tab.route(`https://${launch.hostname}/**`, async route => {
      const req = route.request(), url = new URL(req.url());
      const response = await app.inject({ method: req.method(), url: previewPath + url.pathname + url.search,
        headers: { ...req.headers(), host: launch.hostname }, ...(req.postDataBuffer() ? { payload: req.postDataBuffer() } : {}) });
      await route.fulfill({ status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).filter(([name]) => !["content-length", "transfer-encoding", "connection"].includes(name)).map(([name,value]) => [name, Array.isArray(value) ? value.join("\n") : String(value)])), body: response.rawPayload });
    });
    await tab.goto(preview.url);
    await tab.getByRole("heading", { name: "Private BoxHaven preview" }).waitFor();
    assert.equal(new URL(tab.url()).hash, "");
    const out = join(root, `backend/.artifacts/${providerName}-relay`); await mkdir(out, { recursive: true });
    await tab.screenshot({ path: join(out, "private-preview.png"), fullPage: true });
    console.log("PASS: browser exchanges launch fragment for a private preview cookie");
  } finally { await browser.close(); }
  const revoked = new Promise(resolve => ws.once("close", resolve));
  // Removing membership revokes the same preview lease and SSH access.
  store.db.prepare("DELETE FROM member WHERE organizationId = ? AND userId = ?").run(machine.org_id, machine.user_id);
  assert.equal((await app.inject({ url: `${previewPath}/result.txt`, headers: { host: launch.hostname, cookie } })).statusCode, 403);
  await revoked;
  store.db.prepare("INSERT INTO member(id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)").run(`restored-${suffix}`, machine.org_id, machine.user_id, Date.now());
  console.log("PASS: backend relay expiry, private HTTP/WebSocket previews, anonymous rejection, and membership revocation");

} catch (error) {
  process.exitCode = 1;
  if (remote) {
    const diagnostic = await remote("tmux list-sessions; tmux capture-pane -p -t boxhaven; ps -eo user,pid,ppid,args | head -80; sudo tail -80 /var/log/boxhaven-sandbox.log").catch(error => ({ stdout: error.stdout, stderr: error.stderr }));
    await writeFile(join(temp, "guest-private.json"), JSON.stringify(diagnostic), { mode: 0o600 });
  }
  await writeFile(join(temp, "tunnel.log"), tunnelLog, { mode: 0o600 });
  console.error(`Smoke diagnostics: ${temp}`);
  throw error;
} finally {
  if (attempted && app && token) {
    try { ok(await api("DELETE", `/v1/machines/${machineName}`), 204); console.log(`PASS: test VM is absent (${machineName})`); }
    catch { console.error(`CLEANUP REQUIRED: ${machineName}; recovery state retained in ${temp}`); process.exitCode = 1; }
  }
  if (tunnel) tunnel.kill("SIGTERM");
  for (const socket of sockets) socket.destroy();
  if (gateway) await new Promise(r => gateway.close(r));
  if (app) await app.close();
  if (store) store.close();
  if (!process.exitCode) await rm(temp, { recursive: true, force: true });
}
}
await run();
