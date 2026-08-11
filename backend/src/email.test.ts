import assert from "node:assert/strict";
import { IncomingMessage, Server, ServerResponse, createServer } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBackendAuth, migrateBackendAuth } from "./auth.js";
import { EmailService } from "./email.js";
import { ProviderRegistry } from "./providers.js";
import { createBackend } from "./server.js";
import { SSHCertificateAuthority } from "./ssh_ca.js";
import { StateStore } from "./state.js";
import { ListProviderMachinesRequest, MachineProvider, RemoteMachine } from "./types.js";

type SentEmail = {
  authorization: string;
  body: { from?: string; to?: string[]; subject?: string; text?: string };
};

// A minimal Resend stand-in that records every POST /emails request.
class FakeResend {
  sent: SentEmail[] = [];
  failNext = false;
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => (this.server as Server).listen(0, "127.0.0.1", resolve));
    const address = (this.server as Server).address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => (this.server as Server).close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (request.method !== "POST" || request.url !== "/emails") {
      response.statusCode = 404;
      response.end("{}");
      return;
    }
    this.sent.push({
      authorization: request.headers.authorization || "",
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.setHeader("content-type", "application/json");
    if (this.failNext) {
      this.failNext = false;
      response.statusCode = 503;
      response.end(JSON.stringify({ message: "temporary delivery failure" }));
      return;
    }
    response.end(JSON.stringify({ id: `email_${this.sent.length}` }));
  }
}

class IdleProvider implements MachineProvider {
  readonly name = "fake";
  readonly label = "Fake Cloud";

  async createMachine(): Promise<{ machine: RemoteMachine; status?: string }> {
    throw new Error("not used in email tests");
  }

  async getMachine(machine: RemoteMachine) {
    return { machine };
  }

  async listMachines(_request: ListProviderMachinesRequest) {
    return [] as Array<{ machine: RemoteMachine; status?: string }>;
  }

  async releaseMachine(_machine: RemoteMachine) {}
}

test("backend sends team invitation emails through Resend", async () => {
  const resend = new FakeResend();
  const resendURL = await resend.start();
  try {
    const app = await createEmailTestBackend(new EmailService({
      apiKey: "re_test_key",
      from: "BoxHaven <noreply@hosted.test>",
      apiURL: resendURL,
    }));
    const ownerToken = await signUp(app, "owner@example.com", resend);
    const headers = { authorization: `Bearer ${ownerToken}` };

    const orgCreated = await app.inject({
      method: "POST",
      url: "/v1/auth/organization/create",
      headers,
      payload: { name: "Acme", slug: "acme" },
    });
    assert.equal(orgCreated.statusCode, 200, orgCreated.body);
    const orgID = orgCreated.json().id || orgCreated.json().organization?.id;

    const invited = await app.inject({
      method: "POST",
      url: "/v1/auth/organization/invite-member",
      headers,
      payload: { email: "member@example.com", role: "member", organizationId: orgID },
    });
    assert.equal(invited.statusCode, 200, invited.body);
    const invitationID = invited.json().id as string;

    assert.equal(resend.sent.length, 2);
    const email = resend.sent[1];
    assert.equal(email.authorization, "Bearer re_test_key");
    assert.equal(email.body.from, "BoxHaven <noreply@hosted.test>");
    assert.deepEqual(email.body.to, ["member@example.com"]);
    assert.match(email.body.subject || "", /Acme/);
    assert.match(email.body.text || "", new RegExp(`https://app\\.hosted\\.test/invite\\?id=${invitationID}`));
  } finally {
    await resend.stop();
  }
});

test("backend invitation flow keeps a copyable link when invitation delivery fails", async () => {
  const resend = new FakeResend();
  const resendURL = await resend.start();
  try {
    const app = await createEmailTestBackend(new EmailService({
      apiKey: "re_test_key",
      from: "BoxHaven <noreply@hosted.test>",
      apiURL: resendURL,
    }));
    const ownerToken = await signUp(app, "owner@example.com", resend);
    const headers = { authorization: `Bearer ${ownerToken}` };

    const orgCreated = await app.inject({
      method: "POST",
      url: "/v1/auth/organization/create",
      headers,
      payload: { name: "Acme", slug: "acme" },
    });
    assert.equal(orgCreated.statusCode, 200, orgCreated.body);
    const orgID = orgCreated.json().id || orgCreated.json().organization?.id;

    // Invitation delivery stays best-effort because the console exposes the
    // link for manual sharing. Verification delivery remains mandatory.
    resend.failNext = true;
    const invited = await app.inject({
      method: "POST",
      url: "/v1/auth/organization/invite-member",
      headers,
      payload: { email: "member@example.com", role: "member", organizationId: orgID },
    });
    assert.equal(invited.statusCode, 200, invited.body);

    const memberToken = await signUp(app, "member@example.com", resend);
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/auth/organization/accept-invitation",
      headers: { authorization: `Bearer ${memberToken}` },
      payload: { invitationId: invited.json().id },
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
  } finally {
    await resend.stop();
  }
});

test("password signup requires verification, supports resend, and rejects expired links", async () => {
  const resend = new FakeResend();
  const resendURL = await resend.start();
  try {
    const app = await createEmailTestBackend(new EmailService({
      apiKey: "re_test_key",
      from: "BoxHaven <noreply@hosted.test>",
      apiURL: resendURL,
    }), 2);
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { email: "verify@example.com", password: "password123", name: "Verify" },
    });
    assert.equal(signup.statusCode, 200, signup.body);
    assert.equal(signup.json().token, null);
    assert.equal(resend.sent.length, 1);
    assert.match(resend.sent[0].body.subject || "", /Verify/);
    assert.match(resend.sent[0].body.text || "", /expires in 2 seconds/);

    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email: "verify@example.com", password: "password123" },
    });
    assert.equal(blocked.statusCode, 403, blocked.body);
    assert.equal(blocked.json().code, "EMAIL_NOT_VERIFIED");

    const expiredURL = verificationURL(resend.sent[0]);
    await delay(2_100);
    const expired = await app.inject({
      method: "GET",
      url: `${expiredURL.pathname}?token=${encodeURIComponent(expiredURL.searchParams.get("token") || "")}`,
    });
    assert.equal(expired.statusCode, 401, expired.body);
    assert.equal(expired.json().code, "TOKEN_EXPIRED");

    const resent = await app.inject({
      method: "POST",
      url: "/v1/auth/send-verification-email",
      payload: { email: "verify@example.com", callbackURL: "https://app.hosted.test/signup?verified=true" },
    });
    assert.equal(resent.statusCode, 200, resent.body);
    assert.deepEqual(resent.json(), { status: true });
    assert.equal(resend.sent.length, 2);
    const freshURL = verificationURL(resend.sent[1]);
    const verified = await app.inject({
      method: "GET",
      url: `${freshURL.pathname}?token=${encodeURIComponent(freshURL.searchParams.get("token") || "")}`,
    });
    assert.equal(verified.statusCode, 200, verified.body);

    const signedIn = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email: "verify@example.com", password: "password123" },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    assert.equal(typeof signedIn.json().token, "string");
    await app.close();
  } finally {
    await resend.stop();
  }
});

test("failed signup verification delivery leaves the created account recoverable by resend", async () => {
  const resend = new FakeResend();
  const resendURL = await resend.start();
  let app: Awaited<ReturnType<typeof createEmailTestBackend>> | undefined;
  try {
    app = await createEmailTestBackend(new EmailService({
      apiKey: "re_test_key",
      from: "BoxHaven <noreply@hosted.test>",
      apiURL: resendURL,
    }));
    resend.failNext = true;
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-up/email",
      payload: { email: "recoverable@example.com", password: "password123", name: "Recoverable" },
    });
    assert.equal(signup.statusCode, 503, signup.body);
    assert.equal(signup.json().code, "VERIFICATION_EMAIL_DELIVERY_FAILED");

    const existingButUnverified = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email: "recoverable@example.com", password: "password123" },
    });
    assert.equal(existingButUnverified.statusCode, 403, existingButUnverified.body);
    assert.equal(existingButUnverified.json().code, "EMAIL_NOT_VERIFIED");

    const resent = await app.inject({
      method: "POST",
      url: "/v1/auth/send-verification-email",
      payload: { email: "recoverable@example.com", callbackURL: "https://app.hosted.test/signup?verified=true" },
    });
    assert.equal(resent.statusCode, 200, resent.body);
    assert.equal(resend.sent.length, 2, "the failed initial attempt is followed by a successful resend");
    const freshURL = verificationURL(resend.sent[1]);
    const verified = await app.inject({
      method: "GET",
      url: `${freshURL.pathname}?token=${encodeURIComponent(freshURL.searchParams.get("token") || "")}`,
    });
    assert.equal(verified.statusCode, 200, verified.body);
    const signedIn = await app.inject({
      method: "POST",
      url: "/v1/auth/sign-in/email",
      payload: { email: "recoverable@example.com", password: "password123" },
    });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    assert.equal(typeof signedIn.json().token, "string");
  } finally {
    if (app) await app.close();
    await resend.stop();
  }
});

async function createEmailTestBackend(email: EmailService | undefined, verificationExpiresInSeconds?: number) {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-email-"));
  const provider = new IdleProvider();
  const providers = new ProviderRegistry([provider], provider.name);
  const databasePath = join(dir, "boxhaven.sqlite");
  const store = new StateStore(databasePath, provider.name);
  const sshCA = new SSHCertificateAuthority(join(dir, "ssh_ca_ed25519"));
  const authOptions = {
    baseURL: "http://127.0.0.1/v1/auth",
    databasePath,
    secret: "test-secret-with-at-least-thirty-two-bytes",
    deviceVerificationURL: "http://127.0.0.1/device",
    appURL: "https://app.hosted.test",
    trustedOrigins: ["https://app.hosted.test"],
    email,
    emailVerificationExpiresInSeconds: verificationExpiresInSeconds,
  };
  await migrateBackendAuth(authOptions);
  const auth = createBackendAuth(authOptions);
  return createBackend({
    auth,
    providers,
    store,
    sshCA,
    apiPublicURL: "https://api.hosted.test",
    appPublicURL: "https://app.hosted.test",
    machineReadyTimeoutMs: 0,
  });
}

async function signUp(app: ReturnType<typeof createBackend>, email: string, resend: FakeResend): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: { email, password: "password123", name: email.split("@")[0] },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().token, null);
  const url = verificationURL(resend.sent.at(-1) as SentEmail);
  const verified = await app.inject({
    method: "GET",
    url: `${url.pathname}?token=${encodeURIComponent(url.searchParams.get("token") || "")}`,
  });
  assert.equal(verified.statusCode, 200, verified.body);
  const signedIn = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-in/email",
    payload: { email, password: "password123" },
  });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  return signedIn.json().token as string;
}

function verificationURL(email: SentEmail): URL {
  const match = email.body.text?.match(/https?:\/\/\S+\/verify-email\?\S+/);
  if (!match) throw new Error("verification email does not contain a URL");
  return new URL(match[0]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
