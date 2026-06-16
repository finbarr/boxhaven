import { createHmac, timingSafeEqual } from "node:crypto";
import { StateStore } from "./state.js";
import { BillingRecord } from "./types.js";

const stripeAPIBaseURL = "https://api.stripe.com";
const webhookToleranceSeconds = 300;
export const defaultFreeMachines = 1;
export const defaultMeterEventName = "boxhaven_box_hours";

export type BillingServiceOptions = {
  secretKey: string;
  priceID: string;
  webhookSecret: string;
  meterEventName?: string;
  freeMachines?: number;
  apiURL?: string;
};

export type BillingStatus = "free" | "active" | "past_due" | "canceled";

export type StripeEvent = {
  type?: string;
  data?: { object?: Record<string, unknown> };
};

type StripeSubscription = {
  id: string;
  customer?: string;
  status?: string;
};

// Pricing model: billing attaches to teams, never users. Every team gets the
// same free allowance, and an active subscription unlocks additional boxes,
// which are usage-billed per box-hour through Stripe Billing Meters.
export class BillingService {
  readonly freeMachines: number;
  private readonly apiURL: string;
  private readonly meterEventName: string;

  constructor(
    private readonly options: BillingServiceOptions,
    private readonly store: StateStore,
  ) {
    this.apiURL = (options.apiURL || stripeAPIBaseURL).replace(/\/+$/, "");
    this.meterEventName = options.meterEventName || defaultMeterEventName;
    this.freeMachines = options.freeMachines ?? defaultFreeMachines;
  }

  freeAllowance(): number {
    return this.freeMachines;
  }

  async ensureCustomer(orgID: string, email: string, teamName: string): Promise<BillingRecord> {
    const existing = await this.store.getBillingRecord(orgID);
    if (existing?.customer_id) {
      return existing;
    }
    const customer = await this.request<{ id: string }>("POST", "/v1/customers", {
      email,
      name: teamName,
      "metadata[boxhaven_org_id]": orgID,
    });
    const record: BillingRecord = { ...existing, customer_id: customer.id, updated_at: new Date().toISOString() };
    await this.store.putBillingRecord(orgID, record);
    return record;
  }

  async createCheckoutSession(orgID: string, customerID: string, successURL: string, cancelURL: string): Promise<string> {
    const session = await this.request<{ url?: string }>("POST", "/v1/checkout/sessions", {
      mode: "subscription",
      customer: customerID,
      client_reference_id: orgID,
      // Metered prices must not carry a quantity in Checkout line items.
      "line_items[0][price]": this.options.priceID,
      success_url: successURL,
      cancel_url: cancelURL,
      "subscription_data[metadata][boxhaven_org_id]": orgID,
    });
    if (!session.url) throw new Error("Stripe checkout session response did not include a url");
    return session.url;
  }

  async createPortalSession(customerID: string, returnURL: string): Promise<string> {
    const session = await this.request<{ url?: string }>("POST", "/v1/billing_portal/sessions", {
      customer: customerID,
      return_url: returnURL,
    });
    if (!session.url) throw new Error("Stripe billing portal session response did not include a url");
    return session.url;
  }

  // Manual verification of the Stripe-Signature header: HMAC-SHA256 of
  // "{t}.{raw_body}" with the webhook secret, constant-time comparison
  // against every v1 candidate, and a staleness window on t.
  verifyWebhookSignature(rawBody: Buffer | string, header: string | undefined, now = Date.now()): boolean {
    if (!header || !this.options.webhookSecret) return false;
    let timestamp = "";
    const signatures: string[] = [];
    for (const part of header.split(",")) {
      const separator = part.indexOf("=");
      if (separator === -1) continue;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key === "t") timestamp = value;
      if (key === "v1") signatures.push(value);
    }
    if (!/^\d+$/.test(timestamp) || signatures.length === 0) return false;
    if (Math.abs(now / 1000 - Number(timestamp)) > webhookToleranceSeconds) return false;
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    const expected = createHmac("sha256", this.options.webhookSecret)
      .update(`${timestamp}.`)
      .update(body)
      .digest("hex");
    return signatures.some((signature) => constantTimeHexEqual(expected, signature));
  }

  async handleEvent(event: StripeEvent): Promise<void> {
    const object = event.data?.object || {};
    switch (event.type) {
      case "checkout.session.completed": {
        const customerID = recordString(object.customer);
        const subscriptionID = recordString(object.subscription);
        const orgID = recordString(object.client_reference_id) || (await this.findOrgByCustomer(customerID));
        if (!orgID || !subscriptionID) return;
        const status = await this.subscriptionStatus(subscriptionID);
        await this.mergeBillingRecord(orgID, {
          customer_id: customerID,
          subscription_id: subscriptionID,
          status,
        });
        return;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscriptionID = recordString(object.id);
        const customerID = recordString(object.customer);
        const metadata = (object.metadata || {}) as Record<string, unknown>;
        const orgID = recordString(metadata.boxhaven_org_id) || (await this.findOrgByCustomer(customerID));
        if (!orgID || !subscriptionID) return;
        const status = event.type === "customer.subscription.deleted" ? "canceled" : recordString(object.status) || "canceled";
        await this.mergeBillingRecord(orgID, {
          customer_id: customerID,
          subscription_id: subscriptionID,
          status,
        });
        return;
      }
      default:
        return;
    }
  }

  async reportBoxHours(customerID: string, hours: number, at = new Date(), identifier?: string): Promise<void> {
    await this.request("POST", "/v1/billing/meter_events", {
      event_name: this.meterEventName,
      timestamp: String(Math.floor(at.getTime() / 1000)),
      "payload[stripe_customer_id]": customerID,
      "payload[value]": String(hours),
      ...(identifier ? { identifier } : {}),
    });
  }

  // Reports (team boxes - free allowance) meter units for every subscribed
  // team, at most once per started hour. The hour key is persisted per team
  // so a backend restart inside the same hour does not double-bill, and the
  // Stripe meter event identifier deduplicates retries on the Stripe side too.
  async reportUsage(now = new Date()): Promise<void> {
    const hour = usageHourKey(now);
    const records = await this.store.listBillingRecords();
    for (const [orgID, record] of Object.entries(records)) {
      if (!record.customer_id || !billingRecordAllowsPaidBoxes(record)) continue;
      if (record.last_reported_hour === hour) continue;
      const extra = (await this.store.listMachinesForOrg(orgID)).length - this.freeAllowance();
      if (extra <= 0) continue;
      try {
        await this.reportBoxHours(record.customer_id, extra, now, `boxhaven-${record.customer_id}-${hour}`);
      } catch (error) {
        console.error(`billing: usage report for customer ${record.customer_id} failed: ${(error as Error).message}`);
        continue;
      }
      const current = (await this.store.getBillingRecord(orgID)) || record;
      await this.store.putBillingRecord(orgID, { ...current, last_reported_hour: hour });
      console.error(`billing: reported ${extra} box-hour(s) for customer ${record.customer_id} (hour ${hour})`);
    }
  }

  startUsageReporter(intervalMs = 5 * 60_000): NodeJS.Timeout {
    const run = () => {
      void this.reportUsage().catch((error) => {
        console.error(`billing: usage reporting failed: ${(error as Error).message}`);
      });
    };
    run();
    const timer = setInterval(run, intervalMs);
    timer.unref();
    return timer;
  }

  private async subscriptionStatus(subscriptionID: string): Promise<string> {
    try {
      const subscription = await this.request<StripeSubscription>("GET", `/v1/subscriptions/${encodeURIComponent(subscriptionID)}`);
      return subscription.status || "active";
    } catch (error) {
      // Checkout completion must still activate the account even when the
      // follow-up subscription lookup fails; subscription.updated events
      // correct the status later.
      console.error(`billing: subscription ${subscriptionID} lookup failed: ${(error as Error).message}`);
      return "active";
    }
  }

  private async findOrgByCustomer(customerID: string): Promise<string> {
    if (!customerID) return "";
    const records = await this.store.listBillingRecords();
    return Object.keys(records).find((orgID) => records[orgID].customer_id === customerID) || "";
  }

  private async mergeBillingRecord(orgID: string, update: Partial<BillingRecord> & { customer_id: string }): Promise<void> {
    const existing = await this.store.getBillingRecord(orgID);
    await this.store.putBillingRecord(orgID, {
      ...existing,
      ...update,
      customer_id: update.customer_id || existing?.customer_id || "",
      updated_at: new Date().toISOString(),
    });
  }

  private async request<T = unknown>(method: string, path: string, params?: Record<string, string>): Promise<T> {
    const response = await fetch(`${this.apiURL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.secretKey}`,
        ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: params ? new URLSearchParams(params).toString() : undefined,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Stripe ${method} ${path} failed: ${detail || response.statusText}`);
    }
    return response.json() as Promise<T>;
  }
}

export function billingStatusForRecord(record: BillingRecord | undefined): BillingStatus {
  if (!record?.subscription_id) return "free";
  switch (record.status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    default:
      return "canceled";
  }
}

// A past-due subscription keeps paid boxes running while Stripe retries the
// payment; Stripe cancels it when the retries are exhausted.
export function billingRecordAllowsPaidBoxes(record: BillingRecord | undefined): boolean {
  const status = billingStatusForRecord(record);
  return status === "active" || status === "past_due";
}

export function billingServiceFromEnv(store: StateStore, env = process.env): BillingService | undefined {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return undefined;
  if (!env.STRIPE_PRICE_ID) console.error("billing: STRIPE_PRICE_ID is not set; checkout sessions will fail until it is configured");
  if (!env.STRIPE_WEBHOOK_SECRET) console.error("billing: STRIPE_WEBHOOK_SECRET is not set; webhook deliveries will be rejected");
  return new BillingService({
    secretKey,
    priceID: env.STRIPE_PRICE_ID || "",
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
    meterEventName: env.STRIPE_METER_EVENT_NAME || defaultMeterEventName,
    freeMachines: parseMachineCount(env.BOXHAVEN_FREE_MACHINES, defaultFreeMachines),
    apiURL: env.BOXHAVEN_STRIPE_API_URL,
  }, store);
}

function parseMachineCount(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function usageHourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

function recordString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function constantTimeHexEqual(expected: string, candidate: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const candidateBuffer = Buffer.from(candidate, "utf8");
  return expectedBuffer.length === candidateBuffer.length && timingSafeEqual(expectedBuffer, candidateBuffer);
}
