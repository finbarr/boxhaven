import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBackendAuth, migrateBackendAuth } from "./auth.js";
import { BillingService } from "./billing.js";
import { ProviderRegistry } from "./providers.js";
import { createBackend } from "./server.js";
import { SSHCertificateAuthority } from "./ssh_ca.js";
import { StateStore } from "./state.js";
import { CreateMachineRequest, ListProviderMachinesRequest, MachineProvider, RemoteMachine, defaultSSHUser } from "./types.js";

const testWebhookSecret = "whsec_test_secret";
const testPriceID = "price_test_metered";

class BillingFakeProvider implements MachineProvider {
  readonly name = "fake";
  readonly label = "Fake Cloud";
  created: CreateMachineRequest[] = [];

  async createMachine(request: CreateMachineRequest) {
    this.created.push(request);
    return {
      status: "created",
      machine: {
        name: request.name,
        provider_name: request.provider_name,
        provider: this.name,
        provider_id: `fake-${request.provider_name || request.name}`,
        public_ipv4: "203.0.113.10",
        ssh_user: request.ssh_user || defaultSSHUser,
        bootstrap_complete: true,
      },
    };
  }

  async getMachine(machine: RemoteMachine) {
    return { status: "active", machine };
  }

  async listMachines(_request: ListProviderMachinesRequest) {
    return [] as Array<{ machine: RemoteMachine; status?: string }>;
  }

  async releaseMachine(_machine: RemoteMachine) {}
}

// A minimal Stripe stand-in: records every form-encoded request and answers
// with the canned objects the billing service reads back.
class FakeStripe {
  customers: URLSearchParams[] = [];
  checkoutSessions: URLSearchParams[] = [];
  portalSessions: URLSearchParams[] = [];
  meterEvents: URLSearchParams[] = [];
  subscriptionStatus = "active";
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => (this.server as Server).listen(0, "127.0.0.1", resolve));
    const address = (this.server as Server).address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => (this.server as Server).close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const path = request.url || "";
    const send = (body: unknown) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    };
    if (!(request.headers.authorization || "").startsWith("Bearer ")) {
      response.statusCode = 401;
      return send({ error: { message: "missing api key" } });
    }
    if (request.method === "POST" && path === "/v1/customers") {
      this.customers.push(params);
      return send({ id: `cus_test${this.customers.length}`, object: "customer" });
    }
    if (request.method === "POST" && path === "/v1/checkout/sessions") {
      this.checkoutSessions.push(params);
      return send({ id: `cs_test${this.checkoutSessions.length}`, object: "checkout.session", url: "https://checkout.stripe.test/session" });
    }
    if (request.method === "POST" && path === "/v1/billing_portal/sessions") {
      this.portalSessions.push(params);
      return send({ id: "bps_test1", object: "billing_portal.session", url: "https://portal.stripe.test/session" });
    }
    if (request.method === "GET" && path.startsWith("/v1/subscriptions/")) {
      const id = decodeURIComponent(path.slice("/v1/subscriptions/".length));
      return send({ id, object: "subscription", status: this.subscriptionStatus, customer: "cus_test1" });
    }
    if (request.method === "POST" && path === "/v1/billing/meter_events") {
      this.meterEvents.push(params);
      return send({ object: "billing.meter_event", event_name: params.get("event_name") });
    }
    response.statusCode = 404;
    send({ error: { message: `no fake route for ${request.method} ${path}` } });
  }
}

test("backend billing reports status, sells checkout, and gates the free tier", async () => {
  const stripe = new FakeStripe();
  const stripeURL = await stripe.start();
  try {
    const { app, store, token } = await createBillingTestBackend(stripeURL);
    const headers = { authorization: `Bearer ${token}` };
    const whoami = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers });
    const userID = whoami.json().user.id as string;

    const before = await app.inject({ method: "GET", url: "/v1/billing", headers });
    assert.equal(before.statusCode, 200, before.body);
    assert.deepEqual(before.json(), {
      enabled: true,
      status: "free",
      free_machines: 1,
      machines_used: 0,
      portal_available: false,
    });

    assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "one" } })).statusCode, 201);

    const gated = await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "two" } });
    assert.equal(gated.statusCode, 403, gated.body);
    assert.equal(gated.json().id, "payment_required");
    assert.equal(gated.json().message, "You are on the free tier (1 box). Subscribe at https://app.hosted.test/?section=billing to run more boxes.");

    const checkout = await app.inject({ method: "POST", url: "/v1/billing/checkout", headers, payload: {} });
    assert.equal(checkout.statusCode, 200, checkout.body);
    assert.equal(checkout.json().url, "https://checkout.stripe.test/session");
    assert.equal(stripe.customers.length, 1);
    assert.equal(stripe.customers[0].get("metadata[boxhaven_user_id]"), userID);
    const session = stripe.checkoutSessions[0];
    assert.equal(session.get("mode"), "subscription");
    assert.equal(session.get("customer"), "cus_test1");
    assert.equal(session.get("client_reference_id"), userID);
    assert.equal(session.get("line_items[0][price]"), testPriceID);
    // Metered prices must not carry a quantity.
    assert.equal(session.get("line_items[0][quantity]"), null);
    assert.equal(session.get("success_url"), "https://app.hosted.test/?section=billing&checkout=success");
    assert.equal(session.get("cancel_url"), "https://app.hosted.test/?section=billing&checkout=canceled");

    const completed = await injectWebhook(app, testWebhookSecret, {
      type: "checkout.session.completed",
      data: { object: { id: "cs_test1", mode: "subscription", customer: "cus_test1", subscription: "sub_test1", client_reference_id: userID } },
    });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.deepEqual(completed.json(), { received: true });

    const after = await app.inject({ method: "GET", url: "/v1/billing", headers });
    assert.equal(after.json().status, "active");
    assert.equal(after.json().portal_available, true);
    assert.equal(after.json().machines_used, 1);
    assert.equal((await store.getBillingRecord(userID))?.subscription_id, "sub_test1");

    const repeatCheckout = await app.inject({ method: "POST", url: "/v1/billing/checkout", headers, payload: {} });
    assert.equal(repeatCheckout.statusCode, 400, repeatCheckout.body);

    assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "two" } })).statusCode, 201);

    const deleted = await injectWebhook(app, testWebhookSecret, {
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_test1", customer: "cus_test1", status: "canceled", metadata: { boxhaven_user_id: userID } } },
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal((await app.inject({ method: "GET", url: "/v1/billing", headers })).json().status, "canceled");

    const regated = await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "three" } });
    assert.equal(regated.statusCode, 403, regated.body);
    assert.equal(regated.json().id, "payment_required");
  } finally {
    await stripe.stop();
  }
});

test("backend billing portal requires an existing Stripe customer", async () => {
  const stripe = new FakeStripe();
  const stripeURL = await stripe.start();
  try {
    const { app, token } = await createBillingTestBackend(stripeURL);
    const headers = { authorization: `Bearer ${token}` };

    const denied = await app.inject({ method: "POST", url: "/v1/billing/portal", headers, payload: {} });
    assert.equal(denied.statusCode, 400, denied.body);
    assert.match(denied.body, /no billing customer/);

    assert.equal((await app.inject({ method: "POST", url: "/v1/billing/checkout", headers, payload: {} })).statusCode, 200);

    const portal = await app.inject({ method: "POST", url: "/v1/billing/portal", headers, payload: {} });
    assert.equal(portal.statusCode, 200, portal.body);
    assert.equal(portal.json().url, "https://portal.stripe.test/session");
    assert.equal(stripe.portalSessions[0].get("customer"), "cus_test1");
    assert.equal(stripe.portalSessions[0].get("return_url"), "https://app.hosted.test/?section=billing");
  } finally {
    await stripe.stop();
  }
});

test("backend billing webhook rejects bad signatures", async () => {
  const stripe = new FakeStripe();
  const stripeURL = await stripe.start();
  try {
    const { app } = await createBillingTestBackend(stripeURL);
    const body = JSON.stringify({ type: "customer.subscription.updated", data: { object: {} } });

    const unsigned = await app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    assert.equal(unsigned.statusCode, 400, unsigned.body);

    const wrongSecret = await app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignature("whsec_wrong", body) },
      payload: body,
    });
    assert.equal(wrongSecret.statusCode, 400, wrongSecret.body);

    const stale = await app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignature(testWebhookSecret, body, Date.now() - 10 * 60_000) },
      payload: body,
    });
    assert.equal(stale.statusCode, 400, stale.body);

    const tampered = await app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignature(testWebhookSecret, body) },
      payload: `${body} `,
    });
    assert.equal(tampered.statusCode, 400, tampered.body);

    const valid = await app.inject({
      method: "POST",
      url: "/v1/billing/webhook",
      headers: { "content-type": "application/json", "stripe-signature": stripeSignature(testWebhookSecret, body) },
      payload: body,
    });
    assert.equal(valid.statusCode, 200, valid.body);
  } finally {
    await stripe.stop();
  }
});

test("backend without Stripe configuration keeps billing disabled and creates ungated", async () => {
  const { app, token } = await createBillingTestBackend(undefined);
  const headers = { authorization: `Bearer ${token}` };

  const status = await app.inject({ method: "GET", url: "/v1/billing", headers });
  assert.equal(status.statusCode, 200, status.body);
  assert.deepEqual(status.json(), {
    enabled: false,
    status: "free",
    free_machines: 1,
    machines_used: 0,
    portal_available: false,
  });

  assert.equal((await app.inject({ method: "POST", url: "/v1/billing/checkout", headers, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/billing/portal", headers, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/v1/billing/webhook", headers: { "content-type": "application/json" }, payload: "{}" })).statusCode, 400);

  assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "one" } })).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "two" } })).statusCode, 201);
});

test("billing usage reporter bills extra boxes at most once per started hour", async () => {
  const stripe = new FakeStripe();
  const stripeURL = await stripe.start();
  try {
    const { app, billing, store, token } = await createBillingTestBackend(stripeURL);
    const headers = { authorization: `Bearer ${token}` };
    const whoami = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers });
    const userID = whoami.json().user.id as string;

    await store.putBillingRecord(userID, { customer_id: "cus_test1", subscription_id: "sub_test1", status: "active" });
    assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "one" } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "two" } })).statusCode, 201);
    assert.equal((await app.inject({ method: "POST", url: "/v1/machines", headers, payload: { name: "three" } })).statusCode, 201);

    const firstHour = new Date("2026-06-09T10:15:00.000Z");
    await (billing as BillingService).reportUsage(firstHour);
    assert.equal(stripe.meterEvents.length, 1);
    const event = stripe.meterEvents[0];
    assert.equal(event.get("event_name"), "boxhaven_box_hours");
    assert.equal(event.get("payload[stripe_customer_id]"), "cus_test1");
    assert.equal(event.get("payload[value]"), "2");
    assert.equal(event.get("identifier"), "boxhaven-cus_test1-2026-06-09T10");
    assert.equal(event.get("timestamp"), String(Math.floor(firstHour.getTime() / 1000)));

    // The same started hour is never billed twice, even across a restart,
    // because the hour key is persisted in the state store.
    await (billing as BillingService).reportUsage(new Date("2026-06-09T10:55:00.000Z"));
    assert.equal(stripe.meterEvents.length, 1);
    assert.equal((await store.getBillingRecord(userID))?.last_reported_hour, "2026-06-09T10");

    await (billing as BillingService).reportUsage(new Date("2026-06-09T11:01:00.000Z"));
    assert.equal(stripe.meterEvents.length, 2);

    // Canceled subscriptions and free-tier usage report nothing.
    await store.putBillingRecord(userID, { customer_id: "cus_test1", subscription_id: "sub_test1", status: "canceled" });
    await (billing as BillingService).reportUsage(new Date("2026-06-09T12:01:00.000Z"));
    assert.equal(stripe.meterEvents.length, 2);
  } finally {
    await stripe.stop();
  }
});

async function createBillingTestBackend(stripeURL: string | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-billing-"));
  const provider = new BillingFakeProvider();
  const providers = new ProviderRegistry([provider], provider.name);
  const store = new StateStore(join(dir, "state.json"), provider.name);
  const sshCA = new SSHCertificateAuthority(join(dir, "ssh_ca_ed25519"));
  const billing = stripeURL
    ? new BillingService({
      secretKey: "sk_test_key",
      priceID: testPriceID,
      webhookSecret: testWebhookSecret,
      apiURL: stripeURL,
    }, store)
    : undefined;
  const authOptions = {
    baseURL: "http://127.0.0.1/v1/auth",
    databasePath: join(dir, "auth.sqlite"),
    secret: "test-secret-with-at-least-thirty-two-bytes",
    deviceVerificationURL: "http://127.0.0.1/device",
  };
  await migrateBackendAuth(authOptions);
  const auth = createBackendAuth(authOptions);
  const app = createBackend({
    auth,
    providers,
    store,
    sshCA,
    billing,
    apiPublicURL: "https://api.hosted.test",
    appPublicURL: "https://app.hosted.test",
    machineReadyTimeoutMs: 0,
  });
  const signUp = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: { email: "billing@example.com", password: "password123", name: "billing" },
  });
  assert.equal(signUp.statusCode, 200, signUp.body);
  return { app, billing, provider, store, token: signUp.json().token as string };
}

function stripeSignature(secret: string, body: string, at = Date.now()): string {
  const timestamp = Math.floor(at / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function injectWebhook(app: ReturnType<typeof createBackend>, secret: string, event: unknown) {
  const body = JSON.stringify(event);
  return app.inject({
    method: "POST",
    url: "/v1/billing/webhook",
    headers: { "content-type": "application/json", "stripe-signature": stripeSignature(secret, body) },
    payload: body,
  });
}
