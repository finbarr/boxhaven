import assert from "node:assert/strict";
import { createServer, IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";
import { HTTPCommercialPolicy, commercialPolicyFromEnv } from "./policy.js";

test("HTTP commercial policy uses authenticated version 1 contract calls", async () => {
  const calls: Array<{ url: string; authorization: string; idempotencyKey: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    calls.push({
      url: request.url || "",
      authorization: request.headers.authorization || "",
      idempotencyKey: String(request.headers["idempotency-key"] || ""),
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/contract/v1/entitlements/create") return response.end(JSON.stringify({ version: 1, allowed: true }));
    if (request.url === "/contract/v1/events") return response.end(JSON.stringify({ version: 1, accepted: true }));
    if (request.url === "/contract/v1/reconcile") return response.end(JSON.stringify({ version: 1, accepted: true }));
    if (request.url === "/contract/v1/account-link") return response.end(JSON.stringify({ version: 1, url: "https://account.test/link" }));
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const policy = new HTTPCommercialPolicy({ url: `http://127.0.0.1:${address.port}`, token: "shared-test", accountLabel: "Account" });
  const input = {
    team: { id: "team-1", name: "Acme" },
    actor: { id: "user-1", email: "user@example.com", can_manage: true },
  };
  try {
    assert.deepEqual(await policy.checkCreate({ ...input, machine: { id: "user-1:box", name: "box", tier: "small" } }), { allowed: true });
    await policy.emitMachineFact({
      version: 1,
      id: "event-1",
      occurred_at: "2026-07-11T00:00:00.000Z",
      type: "machine.created",
      team: input.team,
      actor: { id: input.actor.id, email: input.actor.email },
      machine: { id: "user-1:box", name: "box", tier: "small" },
    });
    await policy.reconcile({
      version: 1,
      generated_at: "2026-07-11T00:05:00.000Z",
      machines: [{ team: input.team, machine: { id: "fake:stable-box", name: "box", tier: "small" } }],
    });
    assert.equal(await policy.createAccountLink(input), "https://account.test/link");
    assert.deepEqual(calls.map((call) => call.url), [
      "/contract/v1/entitlements/create",
      "/contract/v1/events",
      "/contract/v1/reconcile",
      "/contract/v1/account-link",
    ]);
    assert.ok(calls.every((call) => call.authorization === "Bearer shared-test"));
    assert.ok(calls.every((call) => call.body.version === 1));
    assert.equal(calls[1].body.id, "event-1");
    assert.equal(calls[1].body.occurred_at, "2026-07-11T00:00:00.000Z");
    assert.equal(calls[1].idempotencyKey, "event-1");
    assert.deepEqual(calls[2].body, {
      version: 1,
      generated_at: "2026-07-11T00:05:00.000Z",
      machines: [{ team: { id: "team-1", name: "Acme" }, machine: { id: "fake:stable-box", name: "box", tier: "small" } }],
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("self-hosted policy defaults to allow-all and rejects partial hosted configuration", async () => {
  const policy = commercialPolicyFromEnv({});
  assert.deepEqual(await policy.checkCreate({
    team: { id: "team", name: "Team" },
    actor: { id: "user", email: "user@example.com", can_manage: true },
    machine: { id: "user:box", name: "box", tier: "small" },
  }), { allowed: true });
  assert.equal(policy.accountCapability, undefined);
  assert.equal(policy.lifecycleEventsEnabled, false);
  assert.throws(() => commercialPolicyFromEnv({ BOXHAVEN_COMMERCIAL_POLICY_URL: "https://policy.test" }), /must be set together/);
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}
