import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { bearer, deviceAuthorization, organization } from "better-auth/plugins";
import Database from "better-sqlite3";
import { EmailService } from "./email.js";

export type BackendAuthOptions = {
  baseURL: string;
  databasePath: string;
  secret: string;
  trustedOrigins?: string[];
  deviceVerificationURL?: string;
  appURL?: string;
  email?: EmailService;
  github?: { clientId: string; clientSecret: string };
};

export function createBackendAuth(options: BackendAuthOptions) {
  return betterAuth(authConfig(options));
}

export type BackendAuth = ReturnType<typeof createBackendAuth>;

export async function migrateBackendAuth(options: BackendAuthOptions): Promise<void> {
  await (await getMigrations(authConfig(options))).runMigrations();
}

function authConfig(options: BackendAuthOptions) {
  mkdirSync(dirname(options.databasePath), { recursive: true });
  const trustedOrigins = new Set((options.trustedOrigins || []).map((origin) => origin.trim()).filter(Boolean));
  const deviceOrigin = urlOrigin(options.deviceVerificationURL);
  if (deviceOrigin) trustedOrigins.add(deviceOrigin);
  return {
    database: new Database(options.databasePath),
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: [...trustedOrigins],
    ...(options.github ? { socialProviders: { github: options.github } } : {}),
    account: {
      accountLinking: {
        enabled: true,
        // GitHub reports verified emails, so a GitHub sign-in with the same
        // address attaches to the existing account instead of duplicating it.
        trustedProviders: ["github"],
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
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
        // BoxHaven accounts are usable without email verification, so the
        // invitation flow must not require verified addresses. Invites are
        // shared as links and are only redeemable by the invited email.
        requireEmailVerificationOnInvitation: false,
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

// Email delivery is best-effort: invitations stay shareable as copyable links
// and password reset responses are intentionally generic, so a missing
// RESEND_API_KEY or a delivery failure must never fail the auth request.
async function sendEmailOrLog(email: EmailService | undefined, message: { to: string; subject: string; text: string }, context: string): Promise<void> {
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

function urlOrigin(value: string | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}
