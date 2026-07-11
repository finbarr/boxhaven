import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendAuth, migrateBackendAuth } from "./auth.js";
import { commercialPolicyFromEnv } from "./policy.js";
import { emailServiceFromEnv } from "./email.js";
import { StateStore } from "./state.js";
import { createBackend } from "./server.js";
import { providerRegistryFromEnv } from "./providers.js";
import { SSHCertificateAuthority } from "./ssh_ca.js";

const listen = process.env.BOXHAVEN_BACKEND_LISTEN || "127.0.0.1:8787";
const authSecret = process.env.BETTER_AUTH_SECRET;
if (!authSecret) {
  throw new Error("BETTER_AUTH_SECRET is required");
}

const providers = providerRegistryFromEnv();

const statePath = process.env.BOXHAVEN_BACKEND_STATE || join(homedir(), ".local", "state", "boxhaven", "backend.json");
const store = new StateStore(statePath, providers.defaultName);
const sshCA = new SSHCertificateAuthority(process.env.BOXHAVEN_SSH_CA_KEY || join(dirname(statePath), "ssh_ca_ed25519"));
const { host, port } = parseListen(listen);
const defaultAppDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist-app");
const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
const authBaseURL = process.env.BETTER_AUTH_URL || `http://${publicHost}:${port}/v1/auth`;
const defaultPublicURL = publicOrigin(authBaseURL) || `http://${host}:${port}`;
const apiPublicURL = trimURL(process.env.BOXHAVEN_API_URL) || defaultPublicURL;
const appPublicURL = trimURL(process.env.BOXHAVEN_APP_URL) || defaultPublicURL;
const email = emailServiceFromEnv();
const github = process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
  ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET }
  : undefined;
const commercialPolicy = commercialPolicyFromEnv();
const authOptions = {
  baseURL: authBaseURL,
  databasePath: process.env.BOXHAVEN_BACKEND_AUTH_DB || join(homedir(), ".local", "state", "boxhaven", "auth.sqlite"),
  secret: authSecret,
  trustedOrigins: splitList(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
  deviceVerificationURL: `${appPublicURL}/device`,
  appURL: appPublicURL,
  email,
  github,
};
await migrateBackendAuth(authOptions);
const auth = createBackendAuth(authOptions);
const app = createBackend({
  auth,
  providers,
  store,
  sshCA,
  adminEmails: splitList(process.env.BOXHAVEN_ADMIN_EMAILS),
  maxMachinesPerUser: Number(process.env.BOXHAVEN_MAX_MACHINES_PER_USER || 0) || undefined,
  commercialPolicy,
  policyEventRetryMs: Number(process.env.BOXHAVEN_COMMERCIAL_POLICY_RETRY_MS || 30_000),
  policyReconcileIntervalMs: Number(process.env.BOXHAVEN_COMMERCIAL_POLICY_RECONCILE_INTERVAL_MS || 5 * 60_000),
  appDir: process.env.BOXHAVEN_BACKEND_APP_DIR || defaultAppDir,
  apiPublicURL,
  appPublicURL,
  corsOrigins: splitList(process.env.BOXHAVEN_BACKEND_CORS_ORIGINS || process.env.BETTER_AUTH_TRUSTED_ORIGINS),
  previewBaseDomain: process.env.BOXHAVEN_PREVIEW_BASE_DOMAIN,
  previewTargetPort: Number(process.env.BOXHAVEN_PREVIEW_TARGET_PORT || 80),
  previewTLSWarmup: warmPreviewTLS,
});

await app.listen({ host, port });
console.error(`boxhaven backend listening on ${host}:${port} with providers ${providers.names().join(", ")} (default ${providers.defaultName})`);

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

async function warmPreviewTLS(previewURL: string): Promise<void> {
  const warmupURL = previewTLSWarmupURL(previewURL);
  const deadline = Date.now() + 60_000;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      await fetch(warmupURL, {
        method: "HEAD",
        headers: { "user-agent": "BoxHaven preview TLS warmup" },
        signal: controller.signal,
      });
      return;
    } catch (error) {
      lastError = error as Error;
      await delay(2_000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`preview TLS warmup timed out for ${warmupURL}: ${lastError?.message || "unknown error"}`);
}

function previewTLSWarmupURL(previewURL: string): string {
  const url = new URL(previewURL);
  url.pathname = "/.well-known/boxhaven/preview-tls-warmup";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimURL(value: string | undefined): string {
  return (value || "").trim().replace(/\/+$/, "");
}
