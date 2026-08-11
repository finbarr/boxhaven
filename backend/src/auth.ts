import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth, type Auth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import Database from "better-sqlite3";
import type { EmailSender } from "./email.js";

const sessionExpiresInSeconds = 60 * 60 * 24 * 30;
const sessionUpdateAgeSeconds = 60 * 60 * 24;
export const defaultEmailVerificationExpiresInSeconds = 60 * 60;

export type BackendAuthOptions = {
  baseURL: string;
  databasePath: string;
  secret: string;
  trustedOrigins?: string[];
  deviceVerificationURL?: string;
  appURL?: string;
  email?: EmailSender;
  emailVerificationExpiresInSeconds?: number;
  github?: { clientId: string; clientSecret: string };
};

const verificationDelivery = new AsyncLocalStorage<{ error?: InstanceType<typeof APIError> }>();

export function createBackendAuth(options: BackendAuthOptions): Auth {
  const auth = betterAuth(authConfig(options, openAuthDatabase(options.databasePath))) as Auth;
  const handler = auth.handler.bind(auth);
  Object.defineProperty(auth, "handler", {
    configurable: true,
    value: (request: Request) => {
      const delivery = {} as { error?: InstanceType<typeof APIError> };
      return verificationDelivery.run(delivery, async () => {
        const response = await handler(request);
        if (!delivery.error || !new URL(request.url).pathname.endsWith("/sign-up/email")) return response;
        return Response.json(delivery.error.body || { message: delivery.error.message }, {
          status: delivery.error.statusCode,
          headers: delivery.error.headers,
        });
      });
    },
  });
  return auth;
}

export type BackendAuth = Auth;

export async function migrateBackendAuth(options: BackendAuthOptions): Promise<void> {
  const database = openAuthDatabase(options.databasePath);
  try {
    await (await getMigrations(authConfig(options, database))).runMigrations();
  } finally {
    database.close();
  }
}

function authConfig(options: BackendAuthOptions, database: Database.Database) {
  const trustedOrigins = new Set((options.trustedOrigins || []).map((origin) => origin.trim()).filter(Boolean));
  const deviceOrigin = urlOrigin(options.deviceVerificationURL);
  if (deviceOrigin) trustedOrigins.add(deviceOrigin);
  return {
    database,
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: [...trustedOrigins],
    session: {
      expiresIn: sessionExpiresInSeconds,
      updateAge: sessionUpdateAgeSeconds,
    },
    ...(options.github ? { socialProviders: { github: options.github } } : {}),
    account: {
      accountLinking: {
        enabled: true,
        // GitHub reports verified emails, so a GitHub sign-in with the same
        // address attaches to the existing account instead of duplicating it.
        trustedProviders: ["github"],
      },
    },
    emailVerification: {
      expiresIn: options.emailVerificationExpiresInSeconds || defaultEmailVerificationExpiresInSeconds,
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      async sendVerificationEmail(data: { user: { email: string }; url: string }) {
        await sendRequiredEmail(options.email, {
          to: data.user.email,
          subject: "Verify your BoxHaven email",
          text: [
            "Verify your email address to finish creating your BoxHaven account.",
            "",
            `Verify your email: ${data.url}`,
            "",
            `This link expires in ${formatDuration(options.emailVerificationExpiresInSeconds || defaultEmailVerificationExpiresInSeconds)}.`,
            "If you did not create this account, you can ignore this email.",
          ].join("\n"),
        }, `verification email for ${data.user.email}`);
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      async sendResetPassword(data: { user: { email: string }; url: string }) {
        await sendEmailOrLog(options.email, {
          to: data.user.email,
          subject: "Reset your BoxHaven password",
          text: [
            "A password reset was requested for your BoxHaven account.",
            "",
            `Reset your password: ${data.url}`,
            "",
            "If you did not request this, you can ignore this email.",
          ].join("\n"),
        }, `password reset email for ${data.user.email}`);
      },
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        expiresIn: "15m",
        interval: "3s",
        schema: {},
        verificationUri: options.deviceVerificationURL || "/device",
        validateClient: (clientID: string) => clientID === "boxhaven-cli",
      }),
      organization({
        requireEmailVerificationOnInvitation: true,
        invitationExpiresIn: 60 * 60 * 24 * 7,
        membershipLimit: 200,
        async sendInvitationEmail(data: { id: string; email: string; organization: { name: string } }) {
          const link = `${(options.appURL || "").replace(/\/+$/, "")}/invite?id=${encodeURIComponent(data.id)}`;
          await sendEmailOrLog(options.email, {
            to: data.email,
            subject: `You're invited to ${data.organization.name} on BoxHaven`,
            text: [
              `You have been invited to join the ${data.organization.name} team on BoxHaven.`,
              "",
              `Accept the invitation: ${link}`,
              "",
              "Sign in (or sign up) with this email address to accept.",
            ].join("\n"),
          }, `invitation email for ${data.email} (share the link manually: ${link})`);
        },
      }),
    ],
  };
}

function openAuthDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  return database;
}

// Email delivery is best-effort: invitations stay shareable as copyable links
// and password reset responses are intentionally generic, so a missing
// RESEND_API_KEY or a delivery failure must never fail the auth request.
async function sendEmailOrLog(email: EmailSender | undefined, message: { to: string; subject: string; text: string }, context: string): Promise<void> {
  if (!email) {
    console.error(`email is not configured (set RESEND_API_KEY); skipped ${context}`);
    return;
  }
  try {
    await email.send(message);
  } catch (error) {
    console.error(`email delivery failed for ${context}: ${(error as Error).message}`);
  }
}

async function sendRequiredEmail(email: EmailSender | undefined, message: { to: string; subject: string; text: string }, context: string): Promise<void> {
  if (!email) {
    const deliveryError = verificationDeliveryError();
    recordVerificationDeliveryError(deliveryError);
    throw deliveryError;
  }
  try {
    await email.send(message);
  } catch (error) {
    console.error(`email delivery failed for ${context}: ${(error as Error).message}`);
    const deliveryError = verificationDeliveryError();
    recordVerificationDeliveryError(deliveryError);
    throw deliveryError;
  }
}

function verificationDeliveryError(): InstanceType<typeof APIError> {
  return new APIError("SERVICE_UNAVAILABLE", {
    code: "VERIFICATION_EMAIL_DELIVERY_FAILED",
    message: "Your account was created, but the verification email could not be delivered. Resend it to continue.",
  });
}

function recordVerificationDeliveryError(error: InstanceType<typeof APIError>): void {
  const delivery = verificationDelivery.getStore();
  if (delivery) delivery.error = error;
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
  if (seconds % 60 === 0) return `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
  return `${seconds} seconds`;
}

function urlOrigin(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}
