import assert from "node:assert/strict";
import test from "node:test";
import { BlaxelProvider } from "./blaxel.js";
import { providerRegistryFromEnv } from "./providers.js";

test("all sandbox providers require prepared images and register together", () => {
  for (const env of [{ E2B_API_KEY: "key" }, { DAYTONA_API_KEY: "key" }, { BL_API_KEY: "key", BL_WORKSPACE: "team" }]) assert.throws(() => providerRegistryFromEnv(env), /BOXHAVEN_REMOTE_IMAGE_/);
  const registry = providerRegistryFromEnv({ E2B_API_KEY: "key", BOXHAVEN_REMOTE_IMAGE_E2B: "template", DAYTONA_API_KEY: "key", BOXHAVEN_REMOTE_IMAGE_DAYTONA: "image", BL_API_KEY: "key", BL_WORKSPACE: "team", BOXHAVEN_REMOTE_IMAGE_BLAXEL: "image" });
  assert.deepEqual(registry.names(), ["e2b", "daytona", "blaxel"]);
});

test("Blaxel paginates team inventory and keeps private preview tokens on the adapter", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const labels = { boxhaven: "true", boxhaven_team: "0123456789", boxhaven_name: "work", boxhaven_provider_name: "work-0123456789" };
  const sandbox = { metadata: { name: "boxhaven-work-0123456789", labels, createdAt: "2026-10-03T00:00:00Z" }, status: "DEPLOYED", spec: { runtime: { image: "image", ttl: "7d" } } };
  const provider = new BlaxelProvider({ apiKey: "account-secret", workspace: "workspace", image: "image", fetch: async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal((init?.headers as Record<string, string>)["X-Blaxel-Authorization"], "Bearer account-secret");
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/tokens")) return Response.json({ spec: { token: "resource-secret" } });
    if (path.includes("/previews/")) return Response.json({ spec: { url: "https://private.preview.bl.run", port: 9898, public: false } });
    if (String(url).includes("cursor=")) return Response.json({ data: [sandbox], meta: { hasMore: false } });
    return Response.json({ data: [{ ...sandbox, metadata: { ...sandbox.metadata, labels: { ...labels, boxhaven_team: "9876543210" } } }], meta: { hasMore: true, nextCursor: "page2" } });
  } });
  const machines = await provider.listMachines({ provider_name_suffix: "0123456789" });
  assert.equal(machines.length, 1);
  assert.equal(machines[0].machine.provider_expires_at, "2026-10-10T00:00:00.000Z");
  assert.equal(JSON.stringify(machines).includes("secret"), false);
  const access = await provider.issueSSHAccess(machines[0].machine, new Date(Date.now()+900_000).toISOString());
  assert.equal(access.kind, "websocket");
  if (access.kind !== "websocket") throw new Error("wrong transport");
  assert.equal(access.url, "wss://private.preview.bl.run/ssh");
  assert.deepEqual(access.headers, { "X-Blaxel-Preview-Token": "resource-secret" });
  await provider.issueSSHAccess(machines[0].machine, new Date(Date.now()+900_000).toISOString());
  assert.equal(calls.filter(c => c.url.endsWith("/tokens")).length, 1);
});

test("Blaxel refuses public previews and sanitizes upstream errors", async () => {
  let fail = false;
  const provider = new BlaxelProvider({ apiKey: "account-secret", workspace: "workspace", image: "image", fetch: async () => fail
    ? new Response("account-secret", { status: 403 }) : Response.json({ spec: { port: 9898, url: "https://public.preview.bl.run", public: true } }) });
  const machine = { name: "box", provider: "blaxel", provider_id: "boxhaven-box-0123456789" };
  await assert.rejects(provider.issueSSHAccess(machine, new Date().toISOString()), /must remain private/);
  fail = true;
  await assert.rejects(provider.listMachines({ provider_name_suffix: "0123456789" }), e => e instanceof Error && e.message === "Blaxel API returned HTTP 403");
});
