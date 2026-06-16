export type RemoteMachine = {
  name: string;
  user_id?: string;
  org_id?: string;
  provider_label?: string;
  provider_name?: string;
  provider?: string;
  provider_id?: string;
  public_ipv4?: string;
  region?: string;
  size?: string;
  image?: string;
  ssh_user?: string;
  preview_hostname?: string;
  preview_url?: string;
  source_path?: string;
  project_path?: string;
  repo_url?: string;
  branch?: string;
  last_command?: string[];
  created_at?: string;
  updated_at?: string;
  last_synced_at?: string;
  bootstrap_complete?: boolean;
  agent_token_hash?: string;
  agent_last_seen_at?: string;
  ssh_principal?: string;
};

export type CreateMachineRequest = {
  name: string;
  provider?: string;
  provider_name?: string;
  team?: string;
  tier?: string;
  region?: string;
  image?: string;
  image_bootstrapped?: boolean;
  ssh_user?: string;
  source_path?: string;
  repo_url?: string;
  branch?: string;
  agent_token?: string;
  agent_backend_url?: string;
  ssh_user_ca_public_key?: string;
  ssh_authorized_principal?: string;
};

export type ListProviderMachinesRequest = {
  provider_name_suffix?: string;
  ssh_user?: string;
};

export type MachineImage = {
  id: string;
  name: string;
  provider?: string;
  org_id?: string;
  org_slug?: string;
  org_name?: string;
  status?: string;
  created_at?: string;
  size_gb?: number;
  bootstrapped?: boolean;
};

export type MachineProviderCapability = "create" | "destroy" | "list" | "connect" | "images" | "snapshot";

export type MachineProviderInfo = {
  name: string;
  label: string;
  capabilities: MachineProviderCapability[];
  default?: boolean;
};

export type MachineProvider = {
  name: string;
  label?: string;
  info?: MachineProviderInfo;
  createMachine(request: CreateMachineRequest): Promise<{ machine: RemoteMachine; status?: string }>;
  getMachine(machine: RemoteMachine): Promise<{ machine: RemoteMachine; status?: string }>;
  listMachines(request: ListProviderMachinesRequest): Promise<Array<{ machine: RemoteMachine; status?: string }>>;
  releaseMachine(machine: RemoteMachine): Promise<void>;
  listImages?(): Promise<MachineImage[]>;
  createImage?(machine: RemoteMachine, name: string): Promise<MachineImage>;
  deleteImage?(imageID: string): Promise<void>;
};

export type TeamImageRecord = {
  id?: string;
  name: string;
  provider: string;
  org_id: string;
  org_slug?: string;
  org_name?: string;
  created_at?: string;
  bootstrapped?: boolean;
};

// Billing records are keyed by organization (team) id. `personal` snapshots
// whether the team is a personal team so the usage reporter can compute the
// free allowance without a session.
export type BillingRecord = {
  customer_id: string;
  subscription_id?: string;
  status?: string;
  personal?: boolean;
  last_reported_hour?: string;
  updated_at?: string;
};

export type BackendState = {
  version: number;
  provider: string;
  machines: Record<string, RemoteMachine>;
  images?: Record<string, TeamImageRecord>;
  billing?: Record<string, BillingRecord>;
  updated_at?: string;
};

export const stateVersion = 5;
export const defaultProjectPath = "/opt/boxhaven/project";
export const defaultSSHUser = "boxhaven";
