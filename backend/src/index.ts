import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendAuth, migrateBackendAuth } from "./auth.js";
import { billingServiceFromEnv } from "./billing.js";
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
const billing = billingServiceFromEnv(store);
const authOptions = {
  baseURL: authBaseURL,
  databasePath: process.env.BOXHAVEN_BACKEND_AUTH_DB || join(homedir(), ".local", "state", "boxhaven", "auth.sqlite"),
  secret: authSecret,
  trustedOrigins: splitList(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
  deviceVerificationURL: `${appPublicURL}/device`,
  appURL: appPublicURL,
  email,
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
  billing,
  appDir: process.env.BOXHAVEN_BACKEND_APP_DIR || defaultAppDir,
  apiPublicURL,
  appPublicURL,
  corsOrigins: splitList(process.env.BOXHAVEN_BACKEND_CORS_ORIGINS || process.env.BETTER_AUTH_TRUSTED_ORIGINS),
  previewBaseDomain: process.env.BOXHAVEN_PREVIEW_BASE_DOMAIN,
  previewTargetPort: Number(process.env.BOXHAVEN_PREVIEW_TARGET_PORT || 80),
});

await app.listen({ host, port });
console.error(`boxhaven backend listening on ${host}:${port} with providers ${providers.names().join(", ")} (default ${providers.defaultName})`);
if (billing) {
  if (usageReporterDisabled(process.env.BOXHAVEN_BILLING_USAGE_REPORTER)) {
    console.error("boxhaven billing usage reporter is disabled by BOXHAVEN_BILLING_USAGE_REPORTER");
  } else {
    billing.startUsageReporter();
    console.error("boxhaven billing usage reporter started (one report per started box-hour)");
  }
}

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

function usageReporterDisabled(value: string | undefined): boolean {
  return ["off", "0", "false", "no"].includes((value || "").trim().toLowerCase());
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
