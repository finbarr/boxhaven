// Build runtime dependencies once, from committed BoxHaven source.
// E2B_API_KEY=... BOXHAVEN_RUNTIME_REF=<commit> node scripts/build-e2b-template.mjs
import assert from "node:assert/strict";
import { Template, defaultBuildLogger } from "e2b";
const ref = process.env.BOXHAVEN_RUNTIME_REF;
assert.match(ref || "", /^[a-f0-9]{40}$/, "BOXHAVEN_RUNTIME_REF must be a full published commit SHA");
assert.ok(process.env.E2B_API_KEY, "Set E2B_API_KEY");
const cpu = Number(process.env.BOXHAVEN_E2B_TEMPLATE_CPU || 2);
const memory = Number(process.env.BOXHAVEN_E2B_TEMPLATE_MEMORY_MB || 4096);
const name = process.env.BOXHAVEN_E2B_TEMPLATE_NAME || `boxhaven-${ref.slice(0, 12)}`;
// E2B's base provisioning manages systemd/SSH itself. Start with Ubuntu rather
// than exeuntu, which masks the SSH service required by that provisioning.
const template = Template().fromImage("ubuntu:24.04").setUser("root").runCmd(
  "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libnspr4 libnss3 libxkbcommon0 libcups2t64 libpango-1.0-0 libcairo2 " +
  `&& curl -fsSL https://raw.githubusercontent.com/finbarr/boxhaven/${ref}/cmd/bh/assets/remote-vm-install.sh -o /tmp/boxhaven-install.sh ` +
  "&& bash /tmp/boxhaven-install.sh && rm /tmp/boxhaven-install.sh " +
  "&& rm -f /etc/ssh/ssh_host_* /etc/boxhaven/ssh_host_* /root/.ssh/authorized_keys /home/boxhaven/.ssh/authorized_keys " +
  "&& install -d -m 0755 /etc/boxhaven && install -m 0600 /dev/null /etc/boxhaven/agent.env"
);
const build = await Template.build(template, name, { cpuCount: cpu, memoryMB: memory, minFreeDiskMb: 4096, onBuildLogs: defaultBuildLogger({ minLevel: "info" }) });
console.log(`BOXHAVEN_REMOTE_IMAGE_E2B=${build.templateId}`);
