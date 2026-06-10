export type AuthUser = {
  id: string;
  email: string;
};

export type WhoamiResponse = {
  authenticated: boolean;
  provider: string;
  providers?: string[];
  admin?: boolean;
  app_url?: string;
  user: AuthUser;
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

export type LoginResponse = {
  token: string;
  user?: AuthUser;
};

export type MachineResponse = {
  machine: Machine;
  status?: string;
};

export type MachinesResponse = {
  machines: Machine[];
};

export type ProvidersResponse = {
  providers: ProviderInfo[];
};

const configuredAPIURL = (import.meta.env.VITE_BOXHAVEN_API_URL || "").replace(/\/+$/, "");
export const apiBaseURL = configuredAPIURL || (window.location.hostname === "app.boxhaven.dev" ? "https://api.boxhaven.dev" : "");
export const tokenKey = "boxhaven.backend.token";
export const sectionKey = "boxhaven.backend.section";

export async function apiFetch<T = unknown>(path: string, token = "", init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${apiBaseURL}${path}`, {
    method: init.method || "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(readError(detail) || response.statusText);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function readError(detail: string): string {
  try {
    const parsed = JSON.parse(detail);
    return parsed.message || parsed.error_description || parsed.error || detail;
  } catch {
    return detail;
  }
}

export function slugName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 63);
}

export function formatDate(value?: string): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatUserCode(code: string): string {
  const clean = code.trim().replace(/-/g, "");
  if (clean.length === 8) return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  return code.trim();
}

export function inviteLink(invitationId: string): string {
  return `${window.location.origin}/invite?id=${encodeURIComponent(invitationId)}`;
}
