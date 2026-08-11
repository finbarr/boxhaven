import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentCloudInitUserData, imageNameIsBoxHavenRemote, machineResourceName, sanitizeResourceName } from "./cloudinit.js";
import {
  CreateMachineRequest,
  ListProviderMachinesRequest,
  MachineImage,
  MachinePlan,
  MachineProvider,
  MachineProviderInfo,
  RemoteMachine,
  defaultSSHUser,
} from "./types.js";

const execFileAsync = promisify(execFile);
const apiBaseURL = "https://api.hetzner.cloud/v1";
const hetznerDefaultServerType = "cpx22";
// CPX Gen2 shared plans are orderable in fsn1/nbg1/hel1/sin; the US locations
// (ash/hil) only offer legacy plans, so they need HETZNER_SERVER_TYPE instead.
const hetznerDefaultServerTypes: Record<string, string> = {
  small: "cpx22",
  medium: "cpx32",
  large: "cpx42",
};
const machineLabelKey = "boxhaven-machine";
// Hetzner server names must be valid RFC 1123 hostnames; a dot-free name is a
// single DNS label capped at 63 characters.
const hetznerServerNameMaxLength = 63;

type HetznerConfig = {
  token: string;
  location: string;
  serverType: string;
  image: string;
  imageBootstrapped: boolean;
  apiURL?: string;
};

type HetznerServer = {
  id: number;
  name: string;
  status?: string;
  labels?: Record<string, string>;
  public_net?: { ipv4?: { ip?: string } | null };
  server_type?: { name?: string };
  image?: { id?: number; name?: string | null; description?: string } | null;
  datacenter?: { location?: { name?: string } };
  created?: string;
};

type HetznerServerList = {
  servers: HetznerServer[];
  meta?: { pagination?: { next_page?: number | null } };
};

type HetznerImage = {
  id: number;
  name?: string | null;
  description?: string;
  type?: string;
  status?: string;
  created?: string;
  image_size?: number | null;
  labels?: Record<string, string>;
};

type HetznerImageList = {
  images: HetznerImage[];
  meta?: { pagination?: { next_page?: number | null } };
};

export class HetznerProvider implements MachineProvider {
  readonly name = "hetzner";
  readonly label = "Hetzner Cloud";
  readonly info: MachineProviderInfo;
  private readonly apiURL: string;

  constructor(private readonly config: HetznerConfig) {
    this.apiURL = (config.apiURL || apiBaseURL).replace(/\/+$/, "");
    this.info = {
      name: this.name,
      label: this.label,
      capabilities: ["create", "destroy", "list", "connect", "images", "snapshot"],
      default_sizes: { ...hetznerDefaultServerTypes, small: config.serverType } as MachineProviderInfo["default_sizes"],
      default_region: config.location,
    };
  }

  async createMachine(request: CreateMachineRequest): Promise<{ machine: RemoteMachine; status?: string }> {
    const providerName = request.provider_name || request.name;
    const existing = await this.findServer(providerName);
    if (existing) {
      throw new Error(`Hetzner server for ${request.name} already exists`);
    }

    const userData = agentCloudInitUserData(request);
    const image = (request.image?.trim() || this.config.image).trim();
    let throwawaySSHKeyID = 0;
    try {
      throwawaySSHKeyID = await this.createThrowawaySSHKey(providerName);
      const created = await this.request<{ server: HetznerServer }>("/servers", {
        method: "POST",
        body: {
          name: hetznerResourceName(providerName),
          server_type: request.provider_size || this.config.serverType || hetznerDefaultServerType,
          image: hetznerImageForCreate(image),
          location: request.region?.trim() || this.config.location,
          ssh_keys: [throwawaySSHKeyID],
          labels: this.machineLabels(providerName),
          public_net: { enable_ipv4: true, enable_ipv6: true },
          ...(userData ? { user_data: userData } : {}),
        },
      });
      const ready = serverIsReady(created.server) ? created.server : await this.waitForRunning(created.server.id);
      const machine = this.machineFromServer(request.name, providerName, request.ssh_user, ready);
      if (request.image_bootstrapped) machine.bootstrap_complete = true;
      return { machine, status: ready.status };
    } finally {
      if (throwawaySSHKeyID) await this.deleteSSHKey(throwawaySSHKeyID);
    }
  }

  async getMachine(machine: RemoteMachine): Promise<{ machine: RemoteMachine; status?: string }> {
    const providerName = machine.provider_name || machine.name;
    const server = machine.provider_id
      ? (await this.request<{ server: HetznerServer }>(`/servers/${encodeURIComponent(machine.provider_id)}`)).server
      : await this.findServer(providerName);
    if (!server) throw new Error(`Hetzner server for ${machine.name} was not found`);
    return { machine: this.machineFromServer(machine.name, providerName, machine.ssh_user, server), status: server.status };
  }

  async listMachines(request: ListProviderMachinesRequest): Promise<Array<{ machine: RemoteMachine; status?: string }>> {
    const suffix = request.provider_name_suffix ? `-${request.provider_name_suffix}` : "";
    const servers = await this.listServers();
    return servers.flatMap((server) => {
      const providerName = providerNameFromServer(server);
      if (!providerName) return [];
      if (suffix && !providerName.endsWith(suffix)) return [];
      const logicalName = suffix ? providerName.slice(0, -suffix.length) : providerName;
      if (!logicalName) return [];
      return [{
        machine: this.machineFromServer(logicalName, providerName, request.ssh_user, server),
        status: server.status,
      }];
    });
  }

  async releaseMachine(machine: RemoteMachine): Promise<void> {
    const id = machine.provider_id || (await this.findServer(machine.provider_name || machine.name))?.id;
    if (!id) return;
    const path = `/servers/${encodeURIComponent(String(id))}`;
    await this.request(path, { method: "DELETE", notFoundOK: true });
    await this.waitForDeletion(path, id);
  }

  async listImages(): Promise<MachineImage[]> {
    const images: MachineImage[] = [];
    let page: number | null = 1;
    while (page) {
      const response: HetznerImageList = await this.request<HetznerImageList>(`/images?type=snapshot&per_page=50&page=${page}`);
      for (const image of response.images) {
        const name = hetznerImageName(image);
        if (!imageNameIsBoxHavenRemote(name) && !(image.labels && "boxhaven" in image.labels)) continue;
        images.push(machineImageFromHetzner(this.name, image));
      }
      page = response.meta?.pagination?.next_page ?? null;
    }
    return images;
  }

  async createImage(machine: RemoteMachine, name: string): Promise<MachineImage> {
    const id = machine.provider_id || (await this.findServer(machine.provider_name || machine.name))?.id;
    if (!id) throw new Error(`Hetzner server for ${machine.name} was not found`);
    const response = await this.request<{ image: HetznerImage }>(`/servers/${encodeURIComponent(String(id))}/actions/create_image`, {
      method: "POST",
      body: {
        description: name,
        type: "snapshot",
        labels: { boxhaven: "" },
      },
    });
    return machineImageFromHetzner(this.name, { ...response.image, description: response.image.description || name });
  }

  async deleteImage(imageID: string): Promise<void> {
    await this.request(`/images/${encodeURIComponent(imageID)}`, { method: "DELETE" });
  }

  async listPlans(): Promise<MachinePlan[]> {
    const plans: MachinePlan[] = [];
    let page: number | null = 1;
    while (page) {
      const response: HetznerServerTypeList = await this.request<HetznerServerTypeList>(`/server_types?per_page=50&page=${page}`);
      plans.push(...response.server_types.map((serverType) => machinePlanFromHetzner(this.name, serverType)));
      page = response.meta?.pagination?.next_page ?? null;
    }
    return plans;
  }

  private async findServer(machineName: string): Promise<HetznerServer | undefined> {
    const selector = `${machineLabelKey}==${sanitizeResourceName(machineName)}`;
    const response = await this.request<HetznerServerList>(`/servers?label_selector=${encodeURIComponent(selector)}&per_page=50`);
    const want = hetznerResourceName(machineName);
    return response.servers.find((server) => server.name === want);
  }

  private async listServers(): Promise<HetznerServer[]> {
    const seen = new Map<number, HetznerServer>();
    let page: number | null = 1;
    while (page) {
      const response: HetznerServerList = await this.request<HetznerServerList>(`/servers?label_selector=boxhaven&per_page=50&page=${page}`);
      for (const server of response.servers) {
        seen.set(server.id, server);
      }
      page = response.meta?.pagination?.next_page ?? null;
    }
    return [...seen.values()];
  }

  private async waitForRunning(id: number): Promise<HetznerServer> {
    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      const response = await this.request<{ server: HetznerServer }>(`/servers/${id}`);
      if (serverIsReady(response.server)) return response.server;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(`timed out waiting for Hetzner server ${id} to start running with a public IPv4`);
  }

  private async createThrowawaySSHKey(providerName: string): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), "boxhaven-hetzner-no-login-key-"));
    try {
      const keyPath = join(dir, "id_ed25519");
      await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "boxhaven-no-login", "-f", keyPath]);
      const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
      const hash = createHash("sha256").update(publicKey).digest("hex").slice(0, 12);
      const created = await this.request<{ ssh_key: { id: number } }>("/ssh_keys", {
        method: "POST",
        body: {
          name: `boxhaven-no-login-${sanitizeResourceName(providerName)}-${hash}`,
          public_key: publicKey,
          labels: { boxhaven: "" },
        },
      });
      return created.ssh_key.id;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async deleteSSHKey(id: number): Promise<void> {
    try {
      await this.request(`/ssh_keys/${encodeURIComponent(String(id))}`, { method: "DELETE" });
    } catch {
      // Do not fail machine creation after the throwaway key has served its purpose.
    }
  }

  private machineFromServer(machineName: string, providerName: string, sshUser: string | undefined, server: HetznerServer): RemoteMachine {
    const now = new Date().toISOString();
    return {
      name: machineName,
      provider_name: providerName,
      provider: this.name,
      provider_id: String(server.id),
      public_ipv4: serverPublicIPv4(server),
      region: server.datacenter?.location?.name || this.config.location,
      size: server.server_type?.name || this.config.serverType,
      image: hetznerImageName(server.image || undefined) || (server.image?.id ? String(server.image.id) : this.config.image),
      ssh_user: sshUser || defaultSSHUser,
      created_at: server.created || now,
      updated_at: now,
      bootstrap_complete: this.serverBootstrapComplete(server),
    };
  }

  private serverBootstrapComplete(server: HetznerServer): boolean {
    if (imageNameIsBoxHavenRemote(hetznerImageName(server.image || undefined))) {
      return true;
    }
    if (imageNameIsBoxHavenRemote(this.config.image)) {
      return true;
    }
    if (this.config.imageBootstrapped && server.image?.id && String(server.image.id) === this.config.image) {
      return true;
    }
    return false;
  }

  private machineLabels(name: string): Record<string, string> {
    return { boxhaven: "", [machineLabelKey]: sanitizeResourceName(name) };
  }

  private async waitForDeletion(path: string, id: string | number): Promise<void> {
    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      const response = await this.request<{ server: HetznerServer } | undefined>(path, { notFoundOK: true });
      if (!response) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`timed out waiting for Hetzner server ${id} to be deleted`);
  }

  private async request<T = unknown>(path: string, init: { method?: string; body?: unknown; notFoundOK?: boolean } = {}): Promise<T> {
    const response = await fetch(`${this.apiURL}${path}`, {
      method: init.method || "GET",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (response.status === 404 && init.notFoundOK) return undefined as T;
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Hetzner ${init.method || "GET"} ${path} failed: ${detail || response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}

export function hetznerProviderFromEnv(env = process.env): HetznerProvider {
  const token = env.HCLOUD_TOKEN || env.HETZNER_API_TOKEN;
  if (!token) throw new Error("Hetzner provider requires HCLOUD_TOKEN");
  return new HetznerProvider({
    token,
    location: env.HETZNER_LOCATION || "nbg1",
    serverType: env.HETZNER_SERVER_TYPE || hetznerDefaultServerType,
    image: env.BOXHAVEN_REMOTE_IMAGE_HETZNER || env.HETZNER_IMAGE || "ubuntu-24.04",
    imageBootstrapped: Boolean(env.BOXHAVEN_REMOTE_IMAGE_HETZNER),
    apiURL: env.BOXHAVEN_HETZNER_API_URL,
  });
}

export function hetznerPlanForDefaultSize(size: string): string | undefined {
  return hetznerDefaultServerTypes[size];
}

type HetznerServerType = {
  name: string;
  description?: string;
  cores?: number;
  memory?: number;
  disk?: number;
  deprecated?: boolean;
  prices?: Array<{
    location?: string;
    price_hourly?: { net?: string };
    price_monthly?: { net?: string };
  }>;
};

type HetznerServerTypeList = {
  server_types: HetznerServerType[];
  meta?: { pagination?: { next_page?: number | null } };
};

function machinePlanFromHetzner(provider: string, serverType: HetznerServerType): MachinePlan {
  const prices = (serverType.prices || []).map((price) => ({
    ...(price.location ? { region: price.location } : {}),
    hourly: Number(price.price_hourly?.net || 0),
    monthly: Number(price.price_monthly?.net || 0),
    currency: "EUR",
  }));
  return {
    provider,
    slug: serverType.name,
    label: serverType.description?.trim() || serverType.name,
    ...(serverType.description ? { description: serverType.description } : {}),
    vcpus: serverType.cores || 0,
    memory_mb: Math.round((serverType.memory || 0) * 1024),
    disk_gb: serverType.disk || 0,
    available: !serverType.deprecated,
    regions: prices.flatMap((price) => price.region ? [price.region] : []),
    prices,
  };
}

export function hetznerImageForCreate(image: string): string | number {
  const value = image.trim();
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function hetznerResourceName(name: string): string {
  const full = machineResourceName(name);
  if (full.length <= hetznerServerNameMaxLength) return full;
  // Keep the trailing user-hash suffix so truncated names stay unique.
  const tail = full.slice(-11);
  return `${full.slice(0, hetznerServerNameMaxLength - tail.length)}${tail}`.replace(/--+/g, "-");
}

function hetznerImageName(image: HetznerImage | NonNullable<HetznerServer["image"]> | undefined): string {
  if (!image) return "";
  // Hetzner snapshots have a null name; the human-readable identity is the description.
  return (image.name || image.description || "").trim();
}

function machineImageFromHetzner(provider: string, image: HetznerImage): MachineImage {
  return {
    id: String(image.id),
    name: hetznerImageName(image) || String(image.id),
    provider,
    status: image.status || "available",
    created_at: image.created,
    size_gb: image.image_size ?? undefined,
    bootstrapped: imageNameIsBoxHavenRemote(hetznerImageName(image)),
  };
}

function serverPublicIPv4(server: HetznerServer): string {
  return server.public_net?.ipv4?.ip || "";
}

function serverIsReady(server: HetznerServer): boolean {
  return server.status === "running" && Boolean(serverPublicIPv4(server));
}

function providerNameFromServer(server: HetznerServer): string {
  if (server.name.startsWith("boxhaven-")) return server.name.slice("boxhaven-".length);
  const label = server.labels?.[machineLabelKey];
  return label || "";
}
