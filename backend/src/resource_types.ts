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
  provider?: string;
  provider_id?: string;
  provider_label?: string;
  region?: string;
  size?: string;
  image?: string;
  image_name?: string;
  created_at?: string;
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
    terminal: "ssh-certificate" | "ssh-websocket-certificate" | "unavailable";
    session_prepare: boolean;
    preview: "provider-login" | "public" | "unavailable";
    /** SSH certificates expire at handshake; the WebSocket bridge also closes active leases. */
    active_access_expiry: "lease" | "not-enforced";
  };
};

export type FleetResponse = { cursor: number; resources: SharedResource[] };
