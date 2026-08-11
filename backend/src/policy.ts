export type PolicyTeam = { id: string; name: string; slug?: string };
export type PolicyActor = { id: string; email: string; email_verified?: boolean; can_manage: boolean };
export type PolicyMachine = {
  id: string;
  name: string;
  size: string;
  provider: string;
  provider_plan: string;
  provider_hourly_price: number;
  hourly_price_cents?: number;
};

export type CreatePolicyInput = {
  team: PolicyTeam;
  actor: PolicyActor;
  machine: PolicyMachine;
};

export type CreatePolicyDecision = { allowed: boolean; message?: string; hourly_price_cents?: number };
export type MachinePriceQuote = { hourly_price_cents?: number };

export type AccountState = "trial" | "active" | "past_due" | "inactive";

export type AccountSummary = {
  state: AccountState;
  included_credit_cents: number;
  active_hourly_cents: number;
  can_manage: boolean;
  primary_action?: "subscribe" | "manage";
};

export type MachineLifecycleFact = {
  type: "machine.created" | "machine.destroyed" | "machine.moved";
  team: PolicyTeam;
  actor: { id: string; email: string; email_verified?: boolean };
  machine: PolicyMachine;
  previous_team_id?: string;
};

export type MachineLifecycleEvent = MachineLifecycleFact & {
  version: 1;
  id: string;
  occurred_at: string;
};

export type PolicyReconciliation = {
  version: 1;
  generated_at: string;
  machines: Array<{ team: PolicyTeam; machine: PolicyMachine }>;
};

export interface CommercialPolicy {
  readonly lifecycleEventsEnabled: boolean;
  readonly accountCapability?: { label: string };
  checkCreate(input: CreatePolicyInput): Promise<CreatePolicyDecision>;
  quoteMachine?(input: CreatePolicyInput): Promise<MachinePriceQuote>;
  emitMachineFact(event: MachineLifecycleEvent): Promise<void>;
  reconcile(input: PolicyReconciliation): Promise<void>;
  getAccountSummary?(input: { team: PolicyTeam; actor: PolicyActor }): Promise<AccountSummary>;
  createAccountAction?(input: { team: PolicyTeam; actor: PolicyActor }): Promise<string>;
}

export class AllowAllCommercialPolicy implements CommercialPolicy {
  readonly lifecycleEventsEnabled = false;

  async checkCreate(): Promise<CreatePolicyDecision> {
    return { allowed: true };
  }

  async emitMachineFact(): Promise<void> {}

  async reconcile(): Promise<void> {}
}

export function policyMachineIdentity(machine: {
  name: string;
  user_id?: string;
  provider?: string;
  provider_name?: string;
  size?: string;
  size_shortcut?: string;
  provider_hourly_price?: number;
  hourly_price_cents?: number;
}): PolicyMachine {
  return {
    id: machine.provider_name ? `${machine.provider || "provider"}:${machine.provider_name}` : `${machine.user_id || "user"}:${machine.name}`,
    name: machine.name,
    size: machine.size_shortcut || machine.size || "small",
    provider: machine.provider || "provider",
    provider_plan: machine.size || "small",
    provider_hourly_price: machine.provider_hourly_price || 0,
    ...(machine.hourly_price_cents !== undefined ? { hourly_price_cents: machine.hourly_price_cents } : {}),
  };
}
