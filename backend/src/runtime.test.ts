import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { startBackendFromEnv } from "./runtime.js";

const exec = promisify(execFile);

test("a fresh backend can be backed up before creating a box and keeps its SSH CA across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-first-start-"));
  const data = join(dir, "data");
  const key = join(data, "backend", "ssh_ca_ed25519");
  const env = {
    BOXHAVEN_BACKEND_LISTEN: "127.0.0.1:0",
    BOXHAVEN_DATABASE_PATH: join(data, "backend", "boxhaven.sqlite"),
    BOXHAVEN_SSH_CA_KEY: key,
    BOXHAVEN_BACKEND_PROVIDER: "digitalocean",
    DIGITALOCEAN_ACCESS_TOKEN: "unused-provider-token",
    RESEND_API_KEY: "unused-email-key",
    BOXHAVEN_EMAIL_FROM: "BoxHaven <noreply@example.com>",
    BETTER_AUTH_SECRET: "first-start-test-secret-with-at-least-32-bytes",
    BETTER_AUTH_URL: "http://127.0.0.1:8787/v1/auth",
  };
  const original = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  let app: Awaited<ReturnType<typeof startBackendFromEnv>> | undefined;
  try {
    app = await startBackendFromEnv();
    assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
    const { stdout } = await exec("bash", [new URL("../../deploy/digitalocean/backup-backend.sh", import.meta.url).pathname], {
      env: { ...process.env, BOXHAVEN_DATA_ROOT: data, BOXHAVEN_BACKUP_ROOT: join(dir, "backups") },
    });
    assert.ok((await stat(stdout.trim())).size > 0, "first-start backup must contain an archive");
    assert.equal((await stat(key)).mode & 0o777, 0o600);
    const publicKey = await readFile(`${key}.pub`, "utf8");
    await app.close();
    app = await startBackendFromEnv();
    assert.equal(await readFile(`${key}.pub`, "utf8"), publicKey, "restarts must preserve the signing identity");
  } finally {
    await app?.close();
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
