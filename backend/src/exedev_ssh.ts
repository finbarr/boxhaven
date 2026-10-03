import { readFile } from "node:fs/promises";
import { Client } from "ssh2";

// Published by https://exe.dev/docs/faq/host-key and verified against the service.
export const exeDevHostFingerprint = "JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo";
type Destination = { host: string; port: number; fingerprint: string; timeoutMs?: number; diagnostics?: (chunk: Buffer) => void };

/** Native control commands can pull cold images beyond /exec's 30 second limit.
 * The library keeps credentials out of OS process arguments. Never return raw
 * stderr or library errors: either may contain the command or setup secrets. */
export async function exeDevSSHCommand(signingKey: string, command: string, input: string,
  destination: Destination = { host: "exe.dev", port: 22, fingerprint: exeDevHostFingerprint },
): Promise<string> {
  let privateKey: Buffer;
  try { privateKey = await readFile(signingKey); }
  catch { throw new Error("Cannot read exe.dev signing key"); }
  return new Promise((resolve, reject) => {
    const connection = new Client();
    let settled = false;
    const finish = (error?: string, result?: string) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); connection.destroy();
      if (error) reject(new Error(error)); else resolve(result!);
    };
    const deadline = setTimeout(() => finish("exe.dev SSH control command timed out; outcome is unknown"), destination.timeoutMs ?? 15 * 60 * 1000);
    connection.on("error", () => finish("exe.dev SSH control connection failed; check its signing key and pinned host identity"));
    connection.on("close", () => finish("exe.dev SSH control disconnected before confirming the result"));
    connection.on("ready", () => {
      connection.exec(command, (error, stream) => {
        if (error) { finish("exe.dev rejected the SSH control request"); return; }
        const chunks: Buffer[] = []; let size = 0;
        stream.on("data", (data: Buffer) => {
          size += data.length;
          if (size > 1024 * 1024) { finish("exe.dev SSH response exceeds 1 MiB"); return; }
          chunks.push(data);
        });
        // Only the isolated smoke supplies this sink, writing to a mode-0600
        // diagnostic file. Provider stderr may contain setup/registry secrets.
        if (destination.diagnostics) stream.stderr.on("data", destination.diagnostics);
        else stream.stderr.resume();
        stream.on("error", () => finish("exe.dev SSH control stream failed"));
        stream.on("close", (code: number) => {
          if (code !== 0) {
            destination.diagnostics?.(Buffer.concat(chunks));
            finish("exe.dev SSH control command failed; outcome is unknown");
          }
          else finish(undefined, Buffer.concat(chunks).toString("utf8"));
        });
        stream.end(input);
      });
    });
    try {
      connection.connect({ host: destination.host, port: destination.port, username: "exedev", privateKey,
        hostHash: "sha256", hostVerifier: (hash: string) => Buffer.from(hash, "hex").toString("base64").replace(/=+$/, "") === destination.fingerprint,
        readyTimeout: 15000, keepaliveInterval: 15000, keepaliveCountMax: 3,
      });
    } catch { finish("Cannot initialize exe.dev SSH control connection"); }
  });
}
