/** Public control-plane metadata. Provider credentials and terminal bytes never belong here. */
export type ResourceRole = "viewer" | "operator" | "manager";
export type ResourceSharing = {
  team_id: string;
  revision: number;
  team_role: "viewer" | "operator";
  /** Membership IDs prevent a removed/re-added user from inheriting an old grant. */
  members: Array<{ member_id: string; role: "viewer" | "operator" }>;
};

export type ResourceOperation = {
  id: string;
  resource_id: string;
  actor_id: string;
  kind: "session.prepare";
  state: "pending" | "completed" | "unknown" | "failed";
  created_at: string;
  updated_at: string;
  /** An observation at updated_at, not a claim that the process is still running. */
  result?: { status: string; attach_command: string; record_command: boolean };
  error_code?: string;
};

export type SharedResource = {
  resource_id: string;
  name: string;
  team_id?: string;
  owner_id?: string;
  owner_name?: string;
  owner_email?: string;
  provider?: string;
  provider_id?: string;
  provider_label?: string;
  region?: string;
  size?: string;
  size_shortcut?: string;
  image?: string;
  image_name?: string;
  created_at?: string;
  updated_at?: string;
  status?: string;
  agent_last_seen_at?: string;
  last_synced_at?: string;
  preview: "team" | "public" | "unavailable";
  /** Only public preview URLs are shared in metadata. */
  preview_url?: string;
  bootstrap_complete: boolean;
  create_state?: "provisioning" | "recovery_required";
  project_path?: string;
  runtime_protocol?: number;
  runtime_version?: string;
};

export type ResourceResponse = {
  resource: SharedResource;
  role: ResourceRole;
  url: string;
  capabilities: {
    terminal: "backend-ssh-relay" | "unavailable";
    session_prepare: boolean;
    preview: "team" | "public" | "unavailable";
    /** The backend closes active relays when access expires or is revoked. */
    active_access_expiry: "lease" | "not-enforced";
  };
};

export type FleetResponse = { cursor: number; resources: SharedResource[] };
