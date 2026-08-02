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

export type AccountState = "trial" | "active" | "past_due" | "inactive";

export type AccountSummary = {
  state: AccountState;
  included_units_remaining: number;
  active_units: number;
  can_manage: boolean;
  primary_action?: "subscribe" | "manage";
};

export type MachineLifecycleFact = {
  type: "machine.created" | "machine.destroyed" | "machine.moved";
  team: PolicyTeam;
  actor: { id: string; email: string };
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
  tier?: string;
}): PolicyMachine {
  return {
    id: machine.provider_name ? `${machine.provider || "provider"}:${machine.provider_name}` : `${machine.user_id || "user"}:${machine.name}`,
    name: machine.name,
    tier: machine.tier === "medium" || machine.tier === "large" ? machine.tier : "small",
  };
}
