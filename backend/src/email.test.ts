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
    const ownerToken = await signUp(app, "owner@example.com");
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

    assert.equal(resend.sent.length, 1);
    const email = resend.sent[0];
    assert.equal(email.authorization, "Bearer re_test_key");
    assert.equal(email.body.from, "BoxHaven <noreply@hosted.test>");
    assert.deepEqual(email.body.to, ["member@example.com"]);
    assert.match(email.body.subject || "", /Acme/);
    assert.match(email.body.text || "", new RegExp(`https://app\\.hosted\\.test/invite\\?id=${invitationID}`));
  } finally {
    await resend.stop();
  }
});

test("backend invitation flow keeps working without email configuration", async () => {
  const app = await createEmailTestBackend(undefined);
  const ownerToken = await signUp(app, "owner@example.com");
  const headers = { authorization: `Bearer ${ownerToken}` };

  const orgCreated = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/create",
    headers,
    payload: { name: "Acme", slug: "acme" },
  });
  assert.equal(orgCreated.statusCode, 200, orgCreated.body);
  const orgID = orgCreated.json().id || orgCreated.json().organization?.id;

  // The copyable-link flow: the invitation is still created and accepted by
  // the invited account even though no email was sent.
  const invited = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/invite-member",
    headers,
    payload: { email: "member@example.com", role: "member", organizationId: orgID },
  });
  assert.equal(invited.statusCode, 200, invited.body);

  const memberToken = await signUp(app, "member@example.com");
  const accepted = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/accept-invitation",
    headers: { authorization: `Bearer ${memberToken}` },
    payload: { invitationId: invited.json().id },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
});

async function createEmailTestBackend(email: EmailService | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "boxhaven-email-"));
  const provider = new IdleProvider();
  const providers = new ProviderRegistry([provider], provider.name);
  const store = new StateStore(join(dir, "state.json"), provider.name);
  const sshCA = new SSHCertificateAuthority(join(dir, "ssh_ca_ed25519"));
  const authOptions = {
    baseURL: "http://127.0.0.1/v1/auth",
    databasePath: join(dir, "auth.sqlite"),
    secret: "test-secret-with-at-least-thirty-two-bytes",
    deviceVerificationURL: "http://127.0.0.1/device",
    appURL: "https://app.hosted.test",
    email,
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

async function signUp(app: ReturnType<typeof createBackend>, email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: { email, password: "password123", name: email.split("@")[0] },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().token as string;
}
