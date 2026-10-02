import { SignJWT } from "jose";
import type { MachineProvider, RemoteMachine, SSHAccess } from "./types.js";

/** The runtime has the original agent token; the backend retains only its hash. */
export async function bridgeAccessToken(agentTokenHash: string, userID: string, expiresAt: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(agentTokenHash)) throw new Error("Machine has no runtime access key");
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setAudience("boxhaven-ssh-bridge")
    .setSubject(userID)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.parse(expiresAt) / 1000))
    .sign(Buffer.from(agentTokenHash, "hex"));
}

export async function machineSSHAccess(provider: MachineProvider, machine: RemoteMachine, userID: string, expiresAt: string): Promise<SSHAccess> {
  if (!machine.ssh_transport) {
    if (!machine.public_ipv4) throw new Error("Remote machine does not have a public SSH address yet");
    return { kind: "tcp", host: machine.public_ipv4, port: 22 };
  }
  if (!provider.issueSSHAccess) throw new Error("Provider does not support this machine's SSH transport");
  const access = await provider.issueSSHAccess(machine, expiresAt);
  if (access.kind !== "websocket") throw new Error("Provider returned the wrong SSH transport");
  const url = new URL(access.url);
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Provider returned an unsafe SSH WebSocket URL");
  }
  return { ...access, expires_at: expiresAt, headers: {
    ...access.headers,
    "X-BoxHaven-Access": await bridgeAccessToken(machine.agent_token_hash || "", userID, expiresAt),
  } };
}
