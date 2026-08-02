export type AuthUser = {
  id: string;
  email: string;
};

export type TeamInfo = {
  id: string;
  name: string;
  slug?: string;
};

export type WhoamiResponse = {
  authenticated: boolean;
  provider: string;
  providers?: string[];
  admin?: boolean;
  app_url?: string;
  team?: TeamInfo | null;
  teams?: TeamInfo[];
  user: AuthUser;
  account?: { label: string };
};

export type AccountSummary = {
  state: "trial" | "active" | "past_due" | "inactive";
  included_units_remaining: number;
  active_units: number;
  can_manage: boolean;
  primary_action?: "subscribe" | "manage";
};

export type ProviderInfo = {
  name: string;
  label: string;
  capabilities: string[];
  default?: boolean;
};

export type Machine = {
  name: string;
  user_id?: string;
  org_id?: string;
  team_id?: string;
  team_slug?: string;
  team_name?: string;
  provider?: string;
  provider_label?: string;
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
  last_synced_at?: string;
  bootstrap_complete?: boolean;
  created_at?: string;
  updated_at?: string;
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

export type ImagesResponse = { images: MachineImage[] };
export type LoginResponse = { token: string; user?: AuthUser };
export type MachineResponse = { machine: Machine; status?: string };
export type MachinesResponse = { machines: Machine[] };
export type ProvidersResponse = { providers: ProviderInfo[] };

export type APIRequestInit = {
  method?: string;
  body?: unknown;
  credentials?: RequestCredentials;
};

export class BoxHavenAPIError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "",
  ) {
    super(message);
    this.name = "BoxHavenAPIError";
  }
}

export async function apiRequest<T = unknown>(
  baseURL: string,
  path: string,
  token = "",
  init: APIRequestInit = {},
): Promise<T> {
  const response = await fetch(`${baseURL.replace(/\/+$/, "")}${path}`, {
    method: init.method || "GET",
    ...(init.credentials ? { credentials: init.credentials } : {}),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    const detail = await response.text();
    const parsed = readAPIError(detail);
    throw new BoxHavenAPIError(parsed.message || response.statusText, response.status, parsed.code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function readAPIError(detail: string): { message: string; code: string } {
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    return {
      message: stringValue(parsed.message) || stringValue(parsed.error_description) || stringValue(parsed.error) || detail,
      code: stringValue(parsed.id) || stringValue(parsed.code),
    };
  } catch {
    return { message: detail, code: "" };
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
