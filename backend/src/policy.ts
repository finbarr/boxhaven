import { randomUUID } from "node:crypto";

export type PolicyTier = "small" | "medium" | "large";

export type PolicyTeam = { id: string; name: string; slug?: string };
export type PolicyActor = { id: string; email: string; can_manage: boolean };
export type PolicyMachine = { id: string; name: string; tier: PolicyTier };

export type CreatePolicyInput = {
  team: PolicyTeam;
  actor: PolicyActor;
  machine: PolicyMachine;
};

export type CreatePolicyDecision = { allowed: boolean; message?: string };

export type MachineLifecycleFact = {
  id?: string;
  occurred_at?: string;
  type: "machine.created" | "machine.destroyed" | "machine.moved";
  team: PolicyTeam;
  actor: { id: string; email: string };
  machine: PolicyMachine;
  previous_team_id?: string;
};

export interface CommercialPolicy {
  readonly accountCapability?: { label: string };
  checkCreate(input: CreatePolicyInput): Promise<CreatePolicyDecision>;
  emitMachineFact(fact: MachineLifecycleFact): Promise<void>;
  createAccountLink?(input: { team: PolicyTeam; actor: PolicyActor }): Promise<string>;
}

export class AllowAllCommercialPolicy implements CommercialPolicy {
  async checkCreate(): Promise<CreatePolicyDecision> {
    return { allowed: true };
  }

  async emitMachineFact(): Promise<void> {}
}

export class HTTPCommercialPolicy implements CommercialPolicy {
  readonly accountCapability?: { label: string };
  private readonly baseURL: string;

  constructor(private readonly options: { url: string; token: string; timeoutMs?: number; accountLabel?: string }) {
    this.baseURL = options.url.replace(/\/+$/, "");
    if (options.accountLabel?.trim()) this.accountCapability = { label: options.accountLabel.trim() };
  }

  async checkCreate(input: CreatePolicyInput): Promise<CreatePolicyDecision> {
    const response = await this.request<{ version?: number; allowed?: boolean; message?: string }>(
      "/contract/v1/entitlements/create",
      { version: 1, ...input },
    );
    if (response.version !== 1 || typeof response.allowed !== "boolean") {
      throw new Error("commercial policy returned an invalid create decision");
    }
    return { allowed: response.allowed, ...(response.message ? { message: response.message } : {}) };
  }

  async emitMachineFact(fact: MachineLifecycleFact): Promise<void> {
    await this.request("/contract/v1/events", {
      version: 1,
      ...fact,
      id: fact.id || randomUUID(),
      occurred_at: fact.occurred_at || new Date().toISOString(),
    });
  }

  async createAccountLink(input: { team: PolicyTeam; actor: PolicyActor }): Promise<string> {
    if (!this.accountCapability) throw new Error("account capability is not configured");
    const response = await this.request<{ version?: number; url?: string }>("/contract/v1/account-link", { version: 1, ...input });
    if (response.version !== 1 || !response.url) throw new Error("commercial policy returned an invalid account link");
    return response.url;
  }

  private async request<T = unknown>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await fetch(`${this.baseURL}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`commercial policy ${path} failed with HTTP ${response.status}: ${await response.text()}`);
      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function commercialPolicyFromEnv(env = process.env): CommercialPolicy {
  const url = env.BOXHAVEN_COMMERCIAL_POLICY_URL?.trim() || "";
  const token = env.BOXHAVEN_COMMERCIAL_POLICY_TOKEN?.trim() || "";
  if (!url && !token) return new AllowAllCommercialPolicy();
  if (!url || !token) throw new Error("BOXHAVEN_COMMERCIAL_POLICY_URL and BOXHAVEN_COMMERCIAL_POLICY_TOKEN must be set together");
  return new HTTPCommercialPolicy({
    url,
    token,
    timeoutMs: Number(env.BOXHAVEN_COMMERCIAL_POLICY_TIMEOUT_MS || 5000),
    accountLabel: env.BOXHAVEN_ACCOUNT_LABEL,
  });
}
