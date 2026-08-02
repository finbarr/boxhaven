import { apiRequest, type APIRequestInit } from "../../src/client";

export type {
  AccountSummary,
  AuthUser,
  ImagesResponse,
  LoginResponse,
  Machine,
  MachineImage,
  MachineResponse,
  MachinesResponse,
  ProviderInfo,
  ProvidersResponse,
  TeamInfo,
  WhoamiResponse,
} from "../../src/client";

const configuredAPIURL = (import.meta.env.VITE_BOXHAVEN_API_URL || "").replace(/\/+$/, "");
export const apiBaseURL = configuredAPIURL || (window.location.hostname === "app.boxhaven.dev" ? "https://api.boxhaven.dev" : "");
export const tokenKey = "boxhaven.backend.token";

export function apiFetch<T = unknown>(path: string, token = "", init: APIRequestInit = {}): Promise<T> {
  return apiRequest<T>(apiBaseURL, path, token, init);
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
