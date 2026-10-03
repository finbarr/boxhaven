// Executes the guest bridge extracted from the image installer, a real OpenSSH
// server, and the compiled bh ProxyCommand. No cloud account or backend relay.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { createServer as netServer, connect } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createServer as tlsServer } from "node:tls";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { WebSocket } from "ws";

// Use the real backend derivation and issuer so this test catches drift between
// the deployed guest and the control plane, rather than copying either formula.
const { hashAgentToken } = await tsImport("../src/server.ts", import.meta.url);
const { bridgeAccessToken } = await tsImport("../src/ssh_access.ts", import.meta.url);

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const temp = await mkdtemp(join(tmpdir(), "bh-transport-smoke-"));
const processes = [];
let tls;
async function port() { const s = netServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p=s.address().port; await new Promise(r => s.close(r)); return p; }
function start(command, args, env = {}) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  processes.push(child); let stderr=""; child.stderr.on("data",d=>{ stderr+=d; });
  child.on("error", error=>{ stderr+=error.message; });
  child.diagnostics=()=>stderr;
  return child;
}
async function ready(p, child) {
  for(let i=0;i<100;i++) {
    if(child.exitCode!==null) throw new Error(child.diagnostics());
    if(await new Promise(r=>{ const s=connect(p,"127.0.0.1");s.on("connect",()=>{s.destroy();r(true);});s.on("error",()=>r(false)); })) return;
    await new Promise(r=>setTimeout(r,50));
  }
  throw new Error("Transport did not start: "+child.diagnostics());
}
try {
  const install = await readFile(join(root,"cmd/bh/assets/remote-vm-install.sh"),"utf8");
  const source = install.match(/cat > \/usr\/local\/lib\/boxhaven\/ssh-bridge.mjs <<'EOF'\n([\s\S]*?)\nEOF/)[1];
  await writeFile(join(temp,"bridge.mjs"),source);
  await symlink(join(root,"backend/node_modules"),join(temp,"node_modules"));
  for(const name of ["host","ca","device","wrong"]) await exec("ssh-keygen",["-q","-t","ed25519","-N","","-f",join(temp,name)]);
  await exec("ssh-keygen",["-q","-s",join(temp,"ca"),"-I","transport-smoke","-n","smoke-user","-V","+5m",join(temp,"device.pub")]);
  await writeFile(join(temp,"principals"),"smoke-user\n");
  const sshPort=await port(); const bridgePort=await port();
  await writeFile(join(temp,"sshd_config"),[
    `Port ${sshPort}`, "ListenAddress 127.0.0.1", `HostKey ${temp}/host`, `PidFile ${temp}/sshd.pid`,
    `TrustedUserCAKeys ${temp}/ca.pub`, `AuthorizedPrincipalsFile ${temp}/principals`,
    "AuthorizedKeysFile none", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no", "StrictModes no",
    `AllowUsers ${userInfo().username}`, "LogLevel VERBOSE",
  ].join("\n")+"\n");
  const sshd=start("/usr/sbin/sshd",["-D","-e","-f",join(temp,"sshd_config")]);
  await ready(sshPort,sshd);
  const agentToken="smoke-runtime-token";
  const bridge=start(process.execPath,[join(temp,"bridge.mjs")],{BOXHAVEN_AGENT_TOKEN:agentToken,BOXHAVEN_SSH_PORT:String(sshPort),BOXHAVEN_SSH_BRIDGE_PORT:String(bridgePort),BOXHAVEN_SSH_BRIDGE_HOST:"127.0.0.1"});
  await ready(bridgePort,bridge);
  await exec("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",join(temp,"tls.key"),"-out",join(temp,"tls.crt"),"-days","1","-subj","/CN=localhost","-addext","subjectAltName=IP:127.0.0.1"]);
  tls=tlsServer({key:await readFile(join(temp,"tls.key")),cert:await readFile(join(temp,"tls.crt"))},socket=>{
    const upstream=connect(bridgePort,"127.0.0.1");
    socket.on("error",()=>upstream.destroy());upstream.on("error",()=>socket.destroy());
    socket.on("close",()=>upstream.destroy());upstream.on("close",()=>socket.destroy());socket.pipe(upstream).pipe(socket);
  });
  await new Promise(r=>tls.listen(0,"127.0.0.1",r));
  const expires=Math.floor(Date.now()/1000)+60;
  const token=await bridgeAccessToken(hashAgentToken(agentToken), "smoke-user", new Date(expires*1000).toISOString());
  const grant={kind:"websocket",url:`wss://127.0.0.1:${tls.address().port}/ssh`,headers:{"X-BoxHaven-Access":token},expires_at:new Date(expires*1000).toISOString()};
  await writeFile(join(temp,"access.json"),JSON.stringify(grant),{mode:0o600});
  const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
  const args=["-F","/dev/null","-i",join(temp,"device"),"-o",`CertificateFile=${temp}/device-cert.pub`,"-o","IdentitiesOnly=yes","-o","BatchMode=yes","-o","StrictHostKeyChecking=accept-new","-o",`UserKnownHostsFile=${temp}/known_hosts`,"-o",`ProxyCommand=${quote(join(root,"bh"))} ssh-proxy ${quote(join(temp,"access.json"))}`,`${userInfo().username}@transport-smoke.invalid`];
  const env={...process.env,SSL_CERT_FILE:join(temp,"tls.crt")};
  const result=await exec("ssh",[...args,"printf 'certificate-over-websocket-ok'"],{env,timeout:15000});
  assert.equal(result.stdout,"certificate-over-websocket-ok");
  assert.match(await readFile(join(temp,"known_hosts"),"utf8"),/transport-smoke/);
  // A valid transport grant does not bypass SSH certificate authentication.
  const wrongArgs=args.map(v=>v===join(temp,"device")?join(temp,"wrong"):v).filter(v=>!v.startsWith("CertificateFile="));
  const certOption=wrongArgs.indexOf("-o",wrongArgs.indexOf(join(temp,"wrong"))+1);wrongArgs.splice(certOption,1);
  await assert.rejects(exec("ssh",[...wrongArgs,"true"],{env,timeout:15000}),/Permission denied/);
  // A grant for another VM never gets as far as SSH.
  await new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${bridgePort}/ssh`,{headers:{"X-BoxHaven-Access":"invalid"}});ws.on("open",()=>{ws.terminate();reject(new Error("invalid grant accepted"));});ws.on("error",()=>resolve());});
  // Expiry closes an already established stream, not just future handshakes.
  const short=await bridgeAccessToken(hashAgentToken(agentToken), "smoke-user", new Date(Date.now()+2000).toISOString());
  await new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${bridgePort}/ssh`,{headers:{"X-BoxHaven-Access":short}});const timeout=setTimeout(()=>{ws.terminate();reject(new Error("expired stream remained open"));},4000);ws.on("error",reject);ws.on("close",()=>{clearTimeout(timeout);resolve();});});
  console.log("PASS: real SSH certificate authentication, pinned host key, direct TLS WebSocket transport, invalid-key/grant rejection, established-stream expiry");
} finally {
  for(const child of processes) child.kill("SIGTERM");
  await Promise.all(processes.map(child=>child.exitCode===null?new Promise(r=>child.once("exit",r)):Promise.resolve()));
  if(tls) await new Promise(r=>tls.close(r));
  await rm(temp,{recursive:true,force:true});
}
