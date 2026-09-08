// Real DigitalOcean snapshot -> clone smoke with an isolated control plane.
// See deploy/digitalocean/README.md for callback routing and credentials.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createBackendAuth, migrateBackendAuth } from "../dist/auth.js";
import { digitalOceanProviderFromEnv } from "../dist/digitalocean.js";
import { ProviderRegistry } from "../dist/providers.js";
import { createBackend } from "../dist/server.js";
import { SSHCertificateAuthority } from "../dist/ssh_ca.js";
import { StateStore } from "../dist/state.js";

const exec = promisify(execFile);
const publicURL = process.env.BOXHAVEN_IMAGE_SMOKE_PUBLIC_URL;
assert.ok(publicURL?.startsWith("https://"), "set BOXHAVEN_IMAGE_SMOKE_PUBLIC_URL to this test backend's reachable HTTPS callback URL");
assert.ok(process.env.BOXHAVEN_REMOTE_IMAGE_DIGITALOCEAN || process.env.BOXHAVEN_REMOTE_IMAGE, "configure a committed, prebuilt BoxHaven runtime snapshot");
const port = Number(process.env.BOXHAVEN_IMAGE_SMOKE_PORT || 18789);
const apiURL = `http://127.0.0.1:${port}`;
const runID = `image-smoke-${Date.now()}-${randomBytes(3).toString("hex")}`;
const outDir = resolve(process.env.BOXHAVEN_IMAGE_SMOKE_OUT || `.artifacts/${runID}`);
// Never open an existing database or reuse another run's SSH credentials.
await mkdir(outDir, { recursive: true, mode: 0o700 });
const runDir = join(outDir, runID);
await mkdir(runDir, { mode: 0o700 });
const databasePath = join(runDir, "boxhaven.sqlite");
const provider = digitalOceanProviderFromEnv();
const providers = new ProviderRegistry([provider], provider.name);
const store = new StateStore(databasePath, provider.name);
const messages = [];
const authOptions = {
  baseURL: `${apiURL}/v1/auth`, databasePath, secret: randomBytes(48).toString("hex"),
  email: { async send(message) { messages.push(message); } },
};
await migrateBackendAuth(authOptions);
const app = createBackend({
  auth: createBackendAuth(authOptions), providers, store,
  sshCA: new SSHCertificateAuthority(join(runDir, "ssh_ca")),
  apiPublicURL: publicURL, machineReadyTimeoutMs: 5 * 60_000,
});
const facts = { runID, machines: [], image: null, checks: [], cleanup: false };
let token;
let unrelatedToken;
let imageRequested = false;
let interrupted = false;
let failure;
process.on("SIGINT", () => { interrupted = true; });
process.on("SIGTERM", () => { interrupted = true; });

try {
  await app.listen({ host: "127.0.0.1", port });
  // Check TLS and callback routing before spending money on a VM.
  const callback = await fetch(`${publicURL}/v1/agent/smoke-${runID}`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(callback.status, 404, `callback proxy returned ${callback.status}`);
  assert.match(callback.headers.get("content-type") || "", /json/, "callback must reach this backend");
  assert.ok((await callback.json()).message.includes(runID));
  token = await signUp("owner");
  unrelatedToken = await signUp("unrelated");
  assert.deepEqual((await api("GET", "/v1/images")).images, []);
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(runDir, "id")]);

  const source = await createMachine(`${runID}-source`);
  const sourceIdentity = await ssh(source, [
    "set -eu",
    `printf '%s\\n' '${runID}' > /opt/boxhaven/project/image-smoke-marker.txt`,
    "command -v codex >/dev/null", "command -v claude >/dev/null",
    "test -f /opt/boxhaven/remote/ready",
    // Provider snapshots capture disk blocks, not the guest's dirty page cache.
    "sync",
    "cat /etc/machine-id", "cat /etc/ssh/ssh_host_ed25519_key.pub",
  ].join("\n"));
  await api("POST", "/v1/images", { machine: source.name, name: ".dev" }, 400);
  assert.deepEqual((await api("GET", "/v1/images")).images, []);
  record("invalid name rejected without reserving an image");

  // This disposable VM becomes a reusable golden image. Apply the same
  // identity cleanup as build-remote-image.sh; snapshot APIs copy disk bytes
  // and do not sanitize a user's source VM. Capture identity before cleaning.
  const cleanScript = await readFile(new URL("../../deploy/digitalocean/clean-remote-image.sh", import.meta.url), "utf8");
  await ssh(source, `sudo bash -c '${cleanScript.replaceAll("'", "'\"'\"'")}'`);
  record("disposable golden-image source flushed and cleaned of instance identity and SSH keys");

  imageRequested = true;
  await journal();
  const pending = (await api("POST", "/v1/images", { machine: source.name, name: runID }, 202)).image;
  assert.equal(pending.name, runID);
  log("waiting for real provider snapshot");
  facts.image = await waitForImage();
  await journal();
  await api("POST", "/v1/images", { machine: source.name, name: runID }, 409);
  assert.deepEqual((await api("GET", "/v1/images", undefined, 200, unrelatedToken)).images, []);
  for (const reference of [runID, facts.image.id]) {
    const intent = { name: `${runID}-forbidden`, owner: "unrelated" };
    facts.machines.push(intent);
    await journal();
    await api("POST", "/v1/machines", { name: `${runID}-forbidden`, image: reference }, 400, unrelatedToken);
    facts.machines.splice(facts.machines.indexOf(intent), 1);
    await api("DELETE", `/v1/images/${reference}`, undefined, 404, unrelatedToken);
  }
  record("unrelated user cannot list, clone, or delete this image by name or ID");

  const clone = await createMachine(`${runID}-clone`, runID);
  const providerClone = await provider.getMachine(clone);
  const imageRecord = await store.getImageForOrg(facts.image.org_id, provider.name, facts.image.id);
  assert.equal(providerClone.machine.image, imageRecord.provider_name, "provider must boot the selected snapshot");
  const cloneIdentity = await ssh(clone, [
    "set -eu",
    `test "$(cat /opt/boxhaven/project/image-smoke-marker.txt)" = '${runID}'`,
    "command -v codex >/dev/null", "command -v claude >/dev/null",
    "test -f /opt/boxhaven/remote/ready",
    "cat /etc/machine-id", "cat /etc/ssh/ssh_host_ed25519_key.pub",
  ].join("\n"));
  const [sourceMachineID, sourceHostKey] = sourceIdentity.trim().split("\n");
  const [cloneMachineID, cloneHostKey] = cloneIdentity.trim().split("\n");
  assert.ok(sourceMachineID && cloneMachineID && sourceHostKey && cloneHostKey);
  assert.notEqual(cloneMachineID, sourceMachineID, "clones must have distinct machine identity");
  assert.notEqual(cloneHostKey.split(" ")[1], sourceHostKey.split(" ")[1], "clones must have distinct SSH host keys");
  record("clone boots, connects its agent, accepts a signed SSH certificate, and retains project files with fresh host identity");
  const refreshed = (await api("GET", `/v1/machines/${clone.name}`)).machine;
  assert.equal(refreshed.image, runID);
  assert.equal((await api("GET", "/v1/images")).images[0].name, runID);
  record("unprefixed image name survives provider refresh");
} catch (error) {
  failure = error;
  facts.error = error.message;
} finally {
  // Use this run's authenticated registry only; never sweep account-wide VMs.
  // The database and resource journal remain available if the process is killed.
  const cleanupErrors = [];
  if (token) {
    if (imageRequested && !facts.image) {
      try { facts.image = await waitForImage(false); } catch (error) { cleanupErrors.push(error.message); }
    }
    for (const machine of [...facts.machines].reverse()) {
      try {
        log(`destroying ${machine.name}`);
        await api("DELETE", `/v1/machines/${machine.name}`, undefined, 204, machine.owner === "unrelated" ? unrelatedToken : token);
        machine.deleted = true;
        await journal();
      } catch (error) { cleanupErrors.push(`${machine.name}: ${error.message}`); }
    }
    if (facts.image) {
      try {
        await api("DELETE", `/v1/images/${facts.image.id}`, undefined, 204);
        assert.ok(!(await provider.listImages()).some((image) => image.id === facts.image.id));
        facts.image.deleted = true;
      } catch (error) { cleanupErrors.push(`snapshot: ${error.message}`); }
    }
    try {
      assert.deepEqual((await api("GET", "/v1/images")).images, []);
      assert.deepEqual((await api("GET", "/v1/machines")).machines, []);
      if (unrelatedToken) assert.deepEqual((await api("GET", "/v1/machines", undefined, 200, unrelatedToken)).machines, []);
    } catch (error) { cleanupErrors.push(error.message); }
  }
  facts.cleanup = cleanupErrors.length === 0;
  facts.cleanupErrors = cleanupErrors;
  await journal();
  await app.close();
  store.db.close();
  console.log(JSON.stringify(facts, null, 2));
  if (cleanupErrors.length) failure ||= new Error(`cleanup incomplete; inspect ${runDir}/result.json`);
}
if (failure) throw failure;

async function api(method, path, body, expected = 200, bearer = token) {
  const response = await fetch(`${apiURL}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), origin: apiURL, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(7 * 60_000),
  });
  const value = await response.text();
  if (response.status !== expected) {
    let message = "unexpected response";
    try { message = JSON.parse(value).message || message; } catch { /* Do not log credentials or HTML. */ }
    assert.equal(response.status, expected, `${method} ${path.split("?")[0]}: ${message}`);
  }
  return value ? JSON.parse(value) : undefined;
}

async function signUp(label) {
  const email = `${label}-${runID}@example.invalid`;
  const password = randomBytes(24).toString("hex");
  await api("POST", "/v1/auth/sign-up/email", { name: label, email, password });
  const message = messages.findLast((candidate) => candidate.to === email);
  const match = message?.text.match(/https?:\/\/\S+\/verify-email\?\S+/);
  assert.ok(match, "verification email captured locally");
  const url = new URL(match[0]);
  await api("GET", `${url.pathname}?token=${encodeURIComponent(url.searchParams.get("token"))}`);
  return (await api("POST", "/v1/auth/sign-in/email", { email, password })).token;
}

async function createMachine(name, image) {
  assert.ok(!interrupted, "smoke interrupted");
  facts.machines.push({ name }); // Persist intent even if provisioning times out.
  await journal();
  log(`creating ${name}`);
  const { machine } = await api("POST", "/v1/machines", { name, size: "small", ...(image ? { image } : {}) }, 201);
  assert.equal(machine.bootstrap_complete, true);
  Object.assign(facts.machines.find((entry) => entry.name === name), { provider_id: machine.provider_id, public_ipv4: machine.public_ipv4 });
  await journal();
  return machine;
}

async function ssh(machine, script) {
  const signed = await api("POST", `/v1/machines/${machine.name}/ssh-cert`, { public_key: await readFile(join(runDir, "id.pub"), "utf8") });
  await writeFile(join(runDir, "id-cert.pub"), signed.certificate, { mode: 0o600 });
  // Same first-use pinning policy as bh. Subsequent connections reject changes.
  const { stdout } = await exec("ssh", [
    "-i", join(runDir, "id"), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${join(runDir, "known_hosts")}`,
    "-o", "ConnectTimeout=15", "-p", String(signed.port), `${signed.ssh_user}@${signed.host}`,
    `bash -lc '${script.replaceAll("'", "'\"'\"'")}'`,
  ], { timeout: 60_000 });
  return stdout;
}

async function waitForImage(checkInterrupted = true) {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    if (checkInterrupted) assert.ok(!interrupted, "smoke interrupted");
    const images = (await api("GET", "/v1/images")).images;
    const image = images.find((candidate) => candidate.name === runID);
    if (!image && !checkInterrupted) return undefined;
    if (image?.id && image.status === "available") return image;
    await delay(10_000);
  }
  throw new Error("snapshot did not become available within 20 minutes");
}

function log(message) { console.log(`[${new Date().toISOString()}] ${message}`); }
function record(message) { facts.checks.push(message); log(message); }
async function journal() { await writeFile(join(runDir, "result.json"), JSON.stringify(facts, null, 2), { mode: 0o600 }); }
