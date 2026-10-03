// Real provider conformance, with an isolated local backend and private temporary
// image registry. Only agent callbacks and authenticated image reads are exposed.
// Run from backend: node --import tsx scripts/smoke-exedev.mjs
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createBackendAuth, migrateBackendAuth } from "../src/auth.ts";
import { ExeDevProvider } from "../src/exedev.ts";
import { exeDevHostFingerprint, exeDevSSHCommand } from "../src/exedev_ssh.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { createBackend } from "../src/server.ts";
import { machineSSHAccess } from "../src/ssh_access.ts";
import { SSHCertificateAuthority } from "../src/ssh_ca.ts";
import { StateStore } from "../src/state.ts";

const exec = promisify(execFile);
const signingKey = process.env.EXE_DEV_SIGNING_KEY;
const image = process.env.BOXHAVEN_EXEDEV_LOCAL_IMAGE;
const cloudflared = process.env.CLOUDFLARED || "cloudflared";
assert.ok(signingKey && image, "Set EXE_DEV_SIGNING_KEY and BOXHAVEN_EXEDEV_LOCAL_IMAGE to a verified local runtime image");
const root = resolve(import.meta.dirname, "../..");
const temp = await mkdtemp(join(tmpdir(), "boxhaven-exedev-smoke-"));
const suffix = randomBytes(5).toString("hex");
const registryName = `boxhaven-exedev-registry-${suffix}`;
const machineName = `exe-smoke-${suffix}`;
const registryAuth = `boxhaven:${randomBytes(32).toString("hex")}`;
const registryAuthorization = `Basic ${Buffer.from(registryAuth).toString("base64")}`;
const digest = value => createHash("sha256").update(value).digest("hex");
const manifestAccept = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json";
const sockets = new Set();
let app, store, gateway, tunnel, backendPort, resourceID, registryStarted = false, attempted = false, token;
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
try {
  await exec("docker", ["run", "-d", "--rm", "--name", registryName, "-p", "127.0.0.1::5000", "registry:3"], { timeout: 180000 });
  registryStarted = true;
  const mapping = JSON.parse((await exec("docker", ["inspect", registryName])).stdout)[0].NetworkSettings.Ports["5000/tcp"][0];
  const registryPort = Number(mapping.HostPort);
  const localRef = `127.0.0.1:${registryPort}/boxhaven/exedev:smoke`;
  await exec("docker", ["tag", image, localRef]);
  console.log("Uploading the runtime to the private local test registry");
  await exec("docker", ["push", localRef], { timeout: 600000, maxBuffer: 1024 * 1024 });
  const manifest = await fetch(`http://127.0.0.1:${registryPort}/v2/boxhaven/exedev/manifests/smoke`, { headers: { Accept: manifestAccept } });
  assert.ok(manifest.ok);
  const imageDigest = manifest.headers.get("docker-content-digest");
  assert.match(imageDigest, /^sha256:[a-f0-9]{64}$/);
  await manifest.body.cancel();

  gateway = createServer((req, res) => {
    if (!req.url?.startsWith("/v2/") || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404); res.end(); return; }
    if (digest(req.headers.authorization || "") !== digest(registryAuthorization)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="BoxHaven test image"' }); res.end(); return;
    }
    const upstream = httpRequest({ host: "127.0.0.1", port: registryPort, path: req.url, method: req.method, headers: { accept: req.headers.accept || "*/*" } }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on("error", () => { res.destroy(); });
    res.on("close", () => upstream.destroy()); upstream.end();
  });
  gateway.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  gateway.on("upgrade", (req, socket, head) => {
    if (req.url !== "/v1/agent/connect" || !backendPort || !req.headers.authorization) { socket.destroy(); return; }
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
  // Confirm the public endpoint cannot expose the backend's account/control API.
  for (let i = 0; ; i++) {
    try { const r = await fetch(`${publicURL}/v1/providers`, { signal: AbortSignal.timeout(5000) }); assert.equal(r.status, 404); await r.body.cancel(); break; }
    catch (error) { if (i === 24) throw error; await delay(5000); }
  }
  const denied = await fetch(`${publicURL}/v2/`); assert.equal(denied.status, 401); await denied.body.cancel();
  const privateManifest = await fetch(`${publicURL}/v2/boxhaven/exedev/manifests/smoke`, { headers: { Authorization: registryAuthorization, Accept: manifestAccept }, signal: AbortSignal.timeout(15000) });
  assert.equal(privateManifest.status, 200); assert.equal(privateManifest.headers.get("docker-content-digest"), imageDigest); await privateManifest.body.cancel();

  let diagnosticSize = 0;
  const provider = new ExeDevProvider({ signingKey, image: `${new URL(publicURL).host}/boxhaven/exedev@${imageDigest}`, registryAuth,
    ssh: (command, setup) => exeDevSSHCommand(signingKey, command, setup, {
      host: "exe.dev", port: 22, fingerprint: exeDevHostFingerprint,
      diagnostics: chunk => { if ((diagnosticSize += chunk.length) <= 1024 * 1024) appendFileSync(join(temp, "provider-private.log"), chunk, { mode: 0o600 }); },
    }), fetch: async (url, init) => {
    const response = await fetch(url, init);
    console.log(`exe.dev ${String(init.body).split(" ")[0]}: HTTP ${response.status}`);
    return response;
  } });
  const providers = new ProviderRegistry([provider], "exedev");
  const databasePath = join(temp, "backend.sqlite");
  store = new StateStore(databasePath, "exedev");
  const emails = [];
  const authOptions = { baseURL: "http://127.0.0.1/v1/auth", databasePath, secret: randomBytes(32).toString("hex"), email: { async send(message) { emails.push(message); } } };
  await migrateBackendAuth(authOptions);
  const sshCA = new SSHCertificateAuthority(join(temp, "ca"));
  app = createBackend({ auth: createBackendAuth(authOptions), providers, store, sshCA, apiPublicURL: publicURL, machineReadyTimeoutMs: 300000, maxMachinesPerUser: 1 });
  await app.listen({ host: "127.0.0.1", port: 0 }); backendPort = app.server.address().port;
  const email = `smoke-${suffix}@example.com`, password = randomBytes(24).toString("hex");
  ok(await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", payload: { email, password, name: "exe.dev smoke" } }));
  const verification = new URL(emails.at(-1).text.match(/https?:\/\/\S+\/verify-email\?\S+/)[0]);
  ok(await app.inject({ url: `${verification.pathname}?token=${encodeURIComponent(verification.searchParams.get("token"))}` }));
  token = ok(await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", payload: { email, password } })).token;
  console.log(`Creating disposable exe.dev VM ${machineName}`);
  attempted = true;
  const created = ok(await api("POST", "/v1/machines", { name: machineName, provider: "exedev" }), 201);
  resourceID = created.machine.resource_id;
  assert.ok(resourceID);
  console.log("PASS: provider create and authenticated guest callback");

  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(temp, "device")]);
  const detail = ok(await api("GET", `/v1/resources/${resourceID}`));
  assert.equal(detail.role, "manager"); assert.equal(detail.capabilities.session_prepare, true);
  const { grant } = ok(await api("POST", `/v1/resources/${resourceID}/access/ssh`, { public_key: await readFile(join(temp, "device.pub"), "utf8") }));
  assert.equal(grant.access.kind, "websocket");
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
  const remote = command => exec("ssh", [...sshArgs, destination, command], { timeout: 30000 });
  assert.equal((await remote("printf certificate-over-exedev-ok")).stdout, "certificate-over-exedev-ok");
  sshArgs[sshArgs.indexOf("StrictHostKeyChecking=accept-new")] = "StrictHostKeyChecking=yes";
  const payload = randomBytes(2 * 1024 * 1024);
  await writeFile(join(temp, "payload.bin"), payload);
  const rsyncSSH = ["ssh", ...sshArgs].map(quote).join(" ");
  await exec("rsync", ["-a", "-e", rsyncSSH, join(temp, "payload.bin"), `${destination}:/opt/boxhaven/project/payload.bin`], { timeout: 60000 });
  assert.equal((await remote("sha256sum /opt/boxhaven/project/payload.bin")).stdout.split(" ")[0], digest(payload));
  await exec("rsync", ["-a", "-e", rsyncSSH, `${destination}:/opt/boxhaven/project/payload.bin`, join(temp, "download.bin")], { timeout: 60000 });
  assert.equal(digest(await readFile(join(temp, "download.bin"))), digest(payload));
  console.log("PASS: direct certificate SSH, pinned host, and file upload");
  const prepared = ok(await api("POST", `/v1/resources/${resourceID}/sessions/prepare`, { command: ["bash", "-lc", "sleep 2; printf persistent-session-ok > /opt/boxhaven/project/result.txt; sleep 30"], attach: false }));
  assert.equal(prepared.operation.state, "completed");
  await delay(3000);
  await exec("rsync", ["-a", "-e", rsyncSSH, `${destination}:/opt/boxhaven/project/result.txt`, join(temp, "result.txt")], { timeout: 30000 });
  assert.equal(await readFile(join(temp, "result.txt"), "utf8"), "persistent-session-ok");
  console.log("PASS: durable session preparation, detached work, reconnect, and file download");
  const machine = await store.getResource(resourceID);
  const short = await machineSSHAccess(provider, machine, machine.user_id, new Date(Date.now() + 10000).toISOString());
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
  const preview = ok(await api("GET", `/v1/resources/${resourceID}/preview`));
  const anonymous = await fetch(preview.url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
  assert.ok([301, 302, 303, 307, 308, 401, 403].includes(anonymous.status), `Anonymous preview status ${anonymous.status}`); await anonymous.body.cancel();
  console.log("PASS: hosted WebSocket expiry and private preview");
} catch (error) {
  process.exitCode = 1;
  await writeFile(join(temp, "tunnel.log"), tunnelLog, { mode: 0o600 });
  if (resourceID) {
    const machine = await store.getResource(resourceID);
    if (/^boxhaven-[a-z0-9-]+$/.test(machine?.provider_id || "")) {
      const command = "sudo journalctl -u boxhaven-ssh-bridge -u boxhaven-sshd --no-pager -n 40; sudo ss -ltnp";
      try {
        const diagnostic = await exeDevSSHCommand(signingKey, `ssh ${machine.provider_id} ${JSON.stringify(command)}`, "");
        await writeFile(join(temp, "guest-private.log"), diagnostic, { mode: 0o600 });
      } catch { console.error("Guest service diagnostics were unavailable"); }
    }
  }
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
  if (registryStarted) await exec("docker", ["rm", "-f", registryName]).catch(() => { console.error(`Remove test registry ${registryName}`); process.exitCode = 1; });
  if (!process.exitCode) await rm(temp, { recursive: true, force: true });
}
