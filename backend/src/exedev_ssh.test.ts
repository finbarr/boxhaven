import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import ssh2 from "ssh2";
import { exeDevSSHCommand } from "./exedev_ssh.js";

test("exe.dev SSH control verifies host identity and sends setup over stdin", async t => {
  const dir = await mkdtemp(join(tmpdir(), "exe-ssh-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = join(dir, "key");
  await promisify(execFile)("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const publicKey = (await readFile(key + ".pub", "utf8")).split(" ")[1];
  const fingerprint = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("base64").replace(/=+$/, "");
  const clients = new Set<import("ssh2").Connection>();
  const server = new ssh2.Server({ hostKeys: [await readFile(key)] }, client => {
    clients.add(client); client.on("error", () => {}); client.on("close", () => clients.delete(client));
    client.on("authentication", context => context.accept());
    client.on("ready", () => client.on("session", accept => {
      const session = accept();
      session.on("exec", (accept, _reject, info) => {
        const stream = accept(); let input = "";
        stream.on("data", data => { input += data; });
        stream.on("end", () => {
          assert.equal(input, "secret setup body");
          if (info.command === "hang") return;
          if (info.command === "fail") { stream.stderr.write("secret provider error"); stream.exit(1); stream.end(); return; }
          assert.equal(info.command, "new --json --setup-script=/dev/stdin");
          stream.write('{"vm_name":"boxhaven-test"}'); stream.exit(0); stream.end();
        });
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const destination = { host: "127.0.0.1", port: (server.address() as { port: number }).port, fingerprint, timeoutMs: 2000 };
  assert.equal(await exeDevSSHCommand(key, "new --json --setup-script=/dev/stdin", "secret setup body", destination), '{"vm_name":"boxhaven-test"}');
  await assert.rejects(exeDevSSHCommand(key, "new", "secret setup body", { ...destination, fingerprint: "wrong" }), /pinned host identity/);
  await assert.rejects(exeDevSSHCommand(key, "fail", "secret setup body", destination), error => error instanceof Error && /outcome is unknown/.test(error.message) && !/secret/.test(error.message));
  await assert.rejects(exeDevSSHCommand(key, "hang", "secret setup body", { ...destination, timeoutMs: 500 }), /timed out; outcome is unknown/);
});
