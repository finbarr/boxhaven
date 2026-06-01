import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendAuth, migrateBackendAuth } from "./auth.js";
import { StateStore } from "./state.js";
import { createBackend } from "./server.js";
import { digitalOceanProviderFromEnv } from "./digitalocean.js";
import { SSHCertificateAuthority } from "./ssh_ca.js";

const listen = process.env.BOXHAVEN_BACKEND_LISTEN || "127.0.0.1:8787";
const authSecret = process.env.BETTER_AUTH_SECRET;
if (!authSecret) {
  throw new Error("BETTER_AUTH_SECRET is required");
}

const providerName = (process.env.BOXHAVEN_BACKEND_PROVIDER || "digitalocean").toLowerCase();
const provider = providerName === "digitalocean"
  ? digitalOceanProviderFromEnv()
  : (() => { throw new Error(`unknown backend provider ${providerName}`); })();

const statePath = process.env.BOXHAVEN_BACKEND_STATE || join(homedir(), ".local", "state", "boxhaven", "backend.json");
const store = new StateStore(statePath, provider.name);
const sshCA = new SSHCertificateAuthority(process.env.BOXHAVEN_SSH_CA_KEY || join(dirname(statePath), "ssh_ca_ed25519"));
const { host, port } = parseListen(listen);
const defaultAppDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist-app");
const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
const authBaseURL = process.env.BETTER_AUTH_URL || `http://${publicHost}:${port}/v1/auth`;
const defaultPublicURL = publicOrigin(authBaseURL) || `http://${host}:${port}`;
const apiPublicURL = trimURL(process.env.BOXHAVEN_API_URL) || defaultPublicURL;
const appPublicURL = trimURL(process.env.BOXHAVEN_APP_URL) || defaultPublicURL;
const authOptions = {
  baseURL: authBaseURL,
  databasePath: process.env.BOXHAVEN_BACKEND_AUTH_DB || join(homedir(), ".local", "state", "boxhaven", "auth.sqlite"),
  secret: authSecret,
  trustedOrigins: splitList(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
  deviceVerificationURL: `${appPublicURL}/device`,
};
await migrateBackendAuth(authOptions);
const auth = createBackendAuth(authOptions);
const app = createBackend({
  auth,
  provider,
  store,
  sshCA,
  logger: boolEnv(process.env.BOXHAVEN_BACKEND_LOG_REQUESTS),
  trustProxy: boolEnv(process.env.BOXHAVEN_BACKEND_TRUST_PROXY),
  appDir: process.env.BOXHAVEN_BACKEND_APP_DIR || defaultAppDir,
  apiPublicURL,
  appPublicURL,
  corsOrigins: splitList(process.env.BOXHAVEN_BACKEND_CORS_ORIGINS || process.env.BETTER_AUTH_TRUSTED_ORIGINS),
  previewBaseDomain: process.env.BOXHAVEN_PREVIEW_BASE_DOMAIN,
  previewTargetPort: Number(process.env.BOXHAVEN_PREVIEW_TARGET_PORT || 80),
  previewProxyTimeoutMs: positiveIntEnv(process.env.BOXHAVEN_PREVIEW_PROXY_TIMEOUT_SECONDS, 30) * 1000,
  signupPolicy: {
    mode: signupMode(process.env.BOXHAVEN_SIGNUP_MODE),
    allowedEmailDomains: splitList(process.env.BOXHAVEN_SIGNUP_ALLOWED_DOMAINS),
    inviteCodes: splitList(process.env.BOXHAVEN_SIGNUP_INVITE_CODES),
  },
  limits: {
    maxMachinesPerUser: positiveIntEnv(process.env.BOXHAVEN_MAX_MACHINES_PER_USER),
    maxMachinesTotal: positiveIntEnv(process.env.BOXHAVEN_MAX_MACHINES_TOTAL),
  },
  rateLimits: {
    authWindowMs: positiveIntEnv(process.env.BOXHAVEN_AUTH_RATE_LIMIT_WINDOW_SECONDS, 60) * 1000,
    authMaxRequests: positiveIntEnv(process.env.BOXHAVEN_AUTH_RATE_LIMIT_MAX, 30),
    machineCreateWindowMs: positiveIntEnv(process.env.BOXHAVEN_CREATE_RATE_LIMIT_WINDOW_SECONDS, 10 * 60) * 1000,
    machineCreateMaxRequests: positiveIntEnv(process.env.BOXHAVEN_CREATE_RATE_LIMIT_MAX, 10),
  },
  maintenance: {
    intervalMs: positiveIntEnv(process.env.BOXHAVEN_MAINTENANCE_INTERVAL_SECONDS, 60) * 1000,
    idleMachineTTLSeconds: positiveIntEnv(process.env.BOXHAVEN_IDLE_MACHINE_TTL_SECONDS) || positiveIntEnv(process.env.BOXHAVEN_IDLE_MACHINE_TTL_HOURS) * 60 * 60,
    staleCreateTTLSeconds: positiveIntEnv(process.env.BOXHAVEN_STALE_CREATE_TTL_SECONDS, 30 * 60),
  },
});

await app.listen({ host, port });
console.error(`boxhaven backend listening on ${host}:${port} with ${provider.name}`);

function parseListen(value: string): { host: string; port: number } {
  const lastColon = value.lastIndexOf(":");
  if (lastColon === -1) return { host: "127.0.0.1", port: Number(value) };
  return {
    host: value.slice(0, lastColon) || "127.0.0.1",
    port: Number(value.slice(lastColon + 1)),
  };
}

function splitList(value: string | undefined): string[] {
  return (value || "").split(",").map((part) => part.trim()).filter(Boolean);
}

function publicOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return "";
  }
}

function trimURL(value: string | undefined): string {
  return (value || "").trim().replace(/\/+$/, "");
}

function positiveIntEnv(value: string | undefined, fallback = 0): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function signupMode(value: string | undefined): "open" | "invite" | "disabled" {
  const normalized = String(value || "open").trim().toLowerCase();
  if (normalized === "invite" || normalized === "disabled") return normalized;
  return "open";
}
