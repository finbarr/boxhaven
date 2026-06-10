import assert from "node:assert/strict";
import { test } from "node:test";
import { hetznerImageForCreate, hetznerProviderFromEnv, hetznerServerTypeForTier } from "./hetzner.js";

test("Hetzner provider prefers the BoxHaven snapshot override", () => {
  const provider = hetznerProviderFromEnv({
    HCLOUD_TOKEN: "hcloud-test",
    BOXHAVEN_REMOTE_IMAGE_HETZNER: "123456",
    HETZNER_IMAGE: "ubuntu-24.04",
  });

  assert.equal((provider as unknown as { config: { image: string } }).config.image, "123456");
  assert.equal((provider as unknown as { config: { imageBootstrapped: boolean } }).config.imageBootstrapped, true);
});

test("Hetzner provider keeps the base image fallback", () => {
  const provider = hetznerProviderFromEnv({
    HCLOUD_TOKEN: "hcloud-test",
  });

  assert.equal((provider as unknown as { config: { image: string } }).config.image, "ubuntu-24.04");
  assert.equal((provider as unknown as { config: { imageBootstrapped: boolean } }).config.imageBootstrapped, false);
  assert.equal((provider as unknown as { config: { location: string } }).config.location, "nbg1");
  assert.equal((provider as unknown as { config: { serverType: string } }).config.serverType, "cpx22");
});

test("Hetzner provider sends numeric snapshot image IDs as numbers", () => {
  assert.equal(hetznerImageForCreate("123456"), 123456);
  assert.equal(hetznerImageForCreate("ubuntu-24.04"), "ubuntu-24.04");
});

test("Hetzner size tiers map to orderable CPX server types", () => {
  assert.equal(hetznerServerTypeForTier("small"), "cpx22");
  assert.equal(hetznerServerTypeForTier("medium"), "cpx32");
  assert.equal(hetznerServerTypeForTier("large"), "cpx42");
});

test("Hetzner creates servers with labels, cloud-init, and a throwaway SSH key", async () => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ url, method, body });
    if (url.includes("/servers?label_selector=")) return jsonResponse({ servers: [] });
    if (url.endsWith("/ssh_keys") && method === "POST") {
      assert.match(String(body?.name || ""), /^boxhaven-no-login-foo-[a-f0-9]{12}$/);
      assert.match(String(body?.public_key || ""), /^ssh-ed25519 /);
      return jsonResponse({ ssh_key: { id: 654 } });
    }
    if (url.endsWith("/servers") && method === "POST") {
      return jsonResponse({
        server: {
          id: 42,
          name: "boxhaven-foo",
          status: "running",
          labels: { boxhaven: "", "boxhaven-machine": "foo" },
          public_net: { ipv4: { ip: "203.0.113.77" } },
          server_type: { name: "cpx22" },
          image: { id: 99, name: null, description: "boxhaven-remote-test" },
          datacenter: { location: { name: "nbg1" } },
          created: "2026-06-01T00:00:00Z",
        },
      });
    }
    if (url.endsWith("/ssh_keys/654") && method === "DELETE") {
      return new Response("", { status: 204 });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }) as typeof fetch;

  try {
    const provider = hetznerProviderFromEnv({
      HCLOUD_TOKEN: "hcloud-test",
      BOXHAVEN_HETZNER_API_URL: "https://hetzner.example.test",
    });

    const created = await provider.createMachine({
      name: "foo",
      agent_token: "agent-token",
      agent_backend_url: "https://api.example.com",
      ssh_user_ca_public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest boxhaven-ca",
      ssh_authorized_principal: "boxhaven:foo-123",
    });

    const createRequest = requests.find((request) => request.method === "POST" && request.url.endsWith("/servers"));
    assert.ok(createRequest?.body);
    assert.equal(createRequest.body.name, "boxhaven-foo");
    assert.equal(createRequest.body.server_type, "cpx22");
    assert.equal(createRequest.body.location, "nbg1");
    assert.deepEqual(createRequest.body.ssh_keys, [654]);
    assert.deepEqual(createRequest.body.labels, { boxhaven: "", "boxhaven-machine": "foo" });
    assert.equal(typeof createRequest.body.user_data, "string");
    assert.match(String(createRequest.body.user_data), /BOXHAVEN_AGENT_TOKEN/);
    assert.equal(requests.some((request) => request.method === "DELETE" && request.url.endsWith("/ssh_keys/654")), true);

    assert.equal(created.machine.public_ipv4, "203.0.113.77");
    assert.equal(created.machine.provider, "hetzner");
    assert.equal(created.machine.region, "nbg1");
    assert.equal(created.machine.image, "boxhaven-remote-test");
    assert.equal(created.machine.bootstrap_complete, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hetzner lists only BoxHaven snapshots and reads names from descriptions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    assert.match(url, /\/images\?type=snapshot/);
    return jsonResponse({
      images: [
        { id: 1, name: null, description: "boxhaven-remote-good", status: "available", created: "2026-06-01T00:00:00Z", image_size: 12.3 },
        { id: 2, name: null, description: "unrelated-snapshot", status: "available" },
        { id: 3, name: null, description: "labeled", status: "creating", labels: { boxhaven: "" } },
      ],
      meta: { pagination: { next_page: null } },
    });
  }) as typeof fetch;

  try {
    const provider = hetznerProviderFromEnv({
      HCLOUD_TOKEN: "hcloud-test",
      BOXHAVEN_HETZNER_API_URL: "https://hetzner.example.test",
    });
    const images = await provider.listImages();
    assert.deepEqual(images.map((image) => image.id), ["1", "3"]);
    assert.equal(images[0].name, "boxhaven-remote-good");
    assert.equal(images[0].bootstrapped, true);
    assert.equal(images[1].status, "creating");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
