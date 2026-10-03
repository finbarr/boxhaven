import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { agentSetupScript } from "./cloudinit.js";
import { ExeDevProvider, exeDevResourceName, exeDevToken } from "./exedev.js";
import { MachineCreateError } from "./types.js";
import { providerRegistryFromEnv } from "./providers.js";

const exec = promisify(execFile);
const request = { name: "work", provider_name: "work-0123456789", agent_token: "private-agent-token", agent_backend_url: "https://api.example.test", ssh_user_ca_public_key: "ssh-ed25519 AAAAC3NzATest", ssh_authorized_principal: "boxhaven:work" };
async function fixture(t: { after(fn: () => unknown): void }) {
  const directory = await mkdtemp(join(tmpdir(), "bh-exedev-test-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const key=join(directory,"key");
  await exec("ssh-keygen",["-q","-t","ed25519","-N","","-f",key]);
  return { directory, key };
}

test("exe.dev tokens use verified SSHSIG namespaces and exact expiry", async t => {
  const { directory,key }=await fixture(t);
  const permissions={exp:Math.floor(Date.now()/1000)+60};
  const token=await exeDevToken(key,"v0@boxhaven-work.exe.xyz",permissions);
  const [prefix,payload,signature]=token.split(".");
  assert.equal(prefix,"exe0");assert.deepEqual(JSON.parse(Buffer.from(payload,"base64url").toString()),permissions);
  await writeFile(join(directory,"payload"),Buffer.from(payload,"base64url"));
  const b64=Buffer.from(signature,"base64url").toString("base64").match(/.{1,70}/g)!.join("\n");
  await writeFile(join(directory,"payload.sig"),`-----BEGIN SSH SIGNATURE-----\n${b64}\n-----END SSH SIGNATURE-----\n`);
  await writeFile(join(directory,"allowed"),`test ${await readFile(key+".pub","utf8")}`);
  const verify = (namespace:string) => new Promise<number|null>((resolve,reject)=>{
    import("node:child_process").then(({spawn})=>{
      const child=spawn("ssh-keygen",["-Y","verify","-f",join(directory,"allowed"),"-I","test","-n",namespace,"-s",join(directory,"payload.sig")],{stdio:["pipe","ignore","ignore"]});
      child.on("error",reject);child.on("exit",resolve);child.stdin.end(Buffer.from(payload,"base64url"));
    },reject);
  });
  assert.equal(await verify("v0@boxhaven-work.exe.xyz"),0);
  assert.notEqual(await verify("v0@other-vm.exe.xyz"),0);
});

test("exe.dev lifecycle uses prepared images, private ports, safe discovery, and confirmed deletion", async t => {
  const {key}=await fixture(t); const commands:string[]=[]; let created=false;
  const provider=new ExeDevProvider({signingKey:key,image:"registry.test/boxhaven@sha256:123",fetch:async (url,init)=>{
    assert.equal(url,"https://exe.dev/exec");assert.equal(init?.redirect,"error");
    const authorization=(init?.headers as Record<string,string>).Authorization;
    assert.match(authorization,/^Bearer exe0\./);
    const command=String(init?.body);commands.push(command);
    const vm={vm_name:"boxhaven-work-0123456789",status:"running",region:"lax",tags:["boxhaven"],https_url:"https://untrusted.example"};
    if(command==="ls -l") return Response.json({vms:created?[vm,{vm_name:"personal",tags:["boxhaven"]},{vm_name:"boxhaven-private-9876543210",tags:["boxhaven"]}]:[]});
    if(command.startsWith("new ")) {created=true;return Response.json(vm);}
    if(command.startsWith("rm ")) created=false;
    return Response.json({});
  }});
  const createdVM=await provider.createMachine(request);
  assert.equal(createdVM.machine.ssh_transport,"websocket");assert.equal(createdVM.machine.public_ipv4,undefined);
  assert.equal(createdVM.machine.preview_url,"https://boxhaven-work-0123456789.exe.xyz");
  assert.equal(createdVM.machine.preview_transport,"provider");
  assert.match(commands.find(c=>c.startsWith("new "))!,/--setup-script=/);
  assert.ok(commands.includes("share port boxhaven-work-0123456789 80"));
  assert.ok(commands.every(c=>!c.includes("set-public")&&!c.includes("set-region")));
  const list=await provider.listMachines({provider_name_suffix:"0123456789"});
  assert.equal(list.length,1);assert.equal(list[0].machine.name,"work");
  const access=await provider.issueSSHAccess(createdVM.machine,new Date(Date.now()+60000).toISOString());
  assert.equal(access.kind,"websocket");
  if (access.kind === "websocket") assert.equal(access.url, "wss://boxhaven-work-0123456789.exe.xyz:9898/ssh");
  assert.equal((await provider.listPlans())[0].prices.length,0);
  await provider.releaseMachine(createdVM.machine);
  await provider.releaseMachine(createdVM.machine);
  assert.equal(commands.filter(c=>c.startsWith("rm ")).length,1);
});

test("exe.dev failures preserve unknown create outcomes without retrying or exposing credentials", async t => {
  const {key}=await fixture(t);let creates=0;
  const provider=new ExeDevProvider({signingKey:key,image:"prepared",fetch:async (_url,init)=>{
    if(init?.body==="ls -l") return Response.json({vms:[]});
    creates++;return new Response("echoed private-agent-token",{status:504});
  }});
  await assert.rejects(provider.createMachine({...request,region:"lax"}), e=>e instanceof MachineCreateError&&e.outcome==="not_created");
  assert.equal(creates,0);
  await assert.rejects(provider.createMachine(request),e=>e instanceof MachineCreateError&&e.outcome==="unknown"&&!e.message.includes("private-agent-token"));
  assert.equal(creates,1);
});

test("exe.dev setup is bounded, requires image dependencies, and installs certificate trust", async t => {
  const {directory}=await fixture(t);
  const setup=agentSetupScript(request);
  assert.ok(Buffer.byteLength(setup)<=10240);assert.match(setup,/test -f \/opt\/boxhaven\/remote\/ready/);
  assert.match(setup,/BOXHAVEN_SSH_PORT=2222/);assert.match(setup,/boxhaven-sshd/);
  assert.match(setup,/BOXHAVEN_SSH_BRIDGE_PORT=9898/);
  assert.doesNotMatch(setup,/apt-get|npm install/);
  const file=join(directory,"setup.sh");await writeFile(file,setup);await exec("sh",["-n",file]);
  assert.throws(()=>agentSetupScript({...request,agent_token:"x".repeat(11000)}),/10 KiB/);
  assert.throws(()=>providerRegistryFromEnv({EXE_DEV_SIGNING_KEY:"key"}),/BOXHAVEN_REMOTE_IMAGE_EXEDEV/);
  const providers=providerRegistryFromEnv({EXE_DEV_SIGNING_KEY:"key",BOXHAVEN_REMOTE_IMAGE_EXEDEV:"prepared"});
  assert.deepEqual(providers.names(),["exedev"]);
  assert.equal(exeDevResourceName("a".repeat(63)+"-0123456789").length,63);
  assert.match(exeDevResourceName("a".repeat(63)+"-0123456789"),/-0123456789$/);
});
