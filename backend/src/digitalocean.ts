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
  MachineProvider,
  MachineProviderInfo,
  RemoteMachine,
  defaultSSHUser,
} from "./types.js";

const execFileAsync = promisify(execFile);
const apiBaseURL = "https://api.digitalocean.com";
const digitalOceanDefaultSize = "s-2vcpu-4gb-amd";
const digitalOceanTierSizes: Record<string, string> = {
  small: "s-2vcpu-4gb-amd",
  medium: "s-4vcpu-8gb-amd",
  large: "s-8vcpu-16gb-amd",
};

type DigitalOceanConfig = {
  token: string;
  region: string;
  size: string;
  image: string;
  imageBootstrapped: boolean;
  tags: string[];
  vpcUUID?: string;
  apiURL?: string;
};

type Droplet = {
  id: number;
  name: string;
  status?: string;
  tags?: string[];
  size_slug?: string;
  region?: { slug?: string };
  image?: { id?: number; slug?: string; name?: string };
  networks?: { v4?: Array<{ ip_address?: string; type?: string }> };
  created_at?: string;
};

type DropletList = {
  droplets: Droplet[];
  links?: {
    pages?: {
      next?: string;
    };
  };
};

type Snapshot = {
  id: string | number;
  name?: string;
  created_at?: string;
  size_gigabytes?: number;
};

type SnapshotList = {
  snapshots: Snapshot[];
  links?: {
    pages?: {
      next?: string;
    };
  };
};

type SSHKey = {
  id: number;
};

export class DigitalOceanProvider implements MachineProvider {
  readonly name = "digitalocean";
  readonly label = "DigitalOcean";
  readonly info: MachineProviderInfo = {
    name: this.name,
    label: this.label,
    capabilities: ["create", "destroy", "list", "connect", "images", "snapshot"],
  };
  private readonly apiURL: string;

  constructor(private readonly config: DigitalOceanConfig) {
    this.apiURL = (config.apiURL || apiBaseURL).replace(/\/+$/, "");
  }

  async createMachine(request: CreateMachineRequest): Promise<{ machine: RemoteMachine; status?: string }> {
    const providerName = request.provider_name || request.name;
    const existing = await this.findDroplet(providerName);
    if (existing) {
      throw new Error(`DigitalOcean droplet for ${request.name} already exists`);
    }

    const agentUserData = agentCloudInitUserData(request);
    const image = (request.image?.trim() || this.config.image).trim();
    let throwawaySSHKeyID = 0;
    try {
      throwawaySSHKeyID = await this.createThrowawaySSHKey(providerName);
      const droplet = await this.request<{ droplet: Droplet }>("/v2/droplets", {
        method: "POST",
        body: {
          name: machineResourceName(providerName),
          region: request.region?.trim() || this.config.region,
          size: digitalOceanSizeForRequest(request, this.config),
          image: digitalOceanImageForCreate(image),
          ssh_keys: [throwawaySSHKeyID],
          tags: this.machineTags(providerName),
          monitoring: true,
          ...(agentUserData ? { user_data: agentUserData } : {}),
          ...(this.config.vpcUUID ? { vpc_uuid: this.config.vpcUUID } : {}),
        },
      });
      const ready = publicIPv4(droplet.droplet) ? droplet.droplet : await this.waitForAddress(droplet.droplet.id);
      const machine = this.machineFromDroplet(request.name, providerName, request.ssh_user, ready);
      if (request.image_bootstrapped) machine.bootstrap_complete = true;
      return { machine, status: ready.status };
    } finally {
      if (throwawaySSHKeyID) await this.deleteSSHKey(throwawaySSHKeyID);
    }
  }

  async getMachine(machine: RemoteMachine): Promise<{ machine: RemoteMachine; status?: string }> {
    const providerName = machine.provider_name || machine.name;
    const droplet = machine.provider_id
      ? (await this.request<{ droplet: Droplet }>(`/v2/droplets/${encodeURIComponent(machine.provider_id)}`)).droplet
      : await this.findDroplet(providerName);
    if (!droplet) throw new Error(`DigitalOcean droplet for ${machine.name} was not found`);
    return { machine: this.machineFromDroplet(machine.name, providerName, machine.ssh_user, droplet), status: droplet.status };
  }

  async listMachines(request: ListProviderMachinesRequest): Promise<Array<{ machine: RemoteMachine; status?: string }>> {
    const suffix = request.provider_name_suffix ? `-${request.provider_name_suffix}` : "";
    const droplets = await this.listDroplets();
    return droplets.flatMap((droplet) => {
      const providerName = providerNameFromDroplet(droplet);
      if (!providerName) return [];
      if (suffix && !providerName.endsWith(suffix)) return [];
      const logicalName = suffix ? providerName.slice(0, -suffix.length) : providerName;
      if (!logicalName) return [];
      return [{
        machine: this.machineFromDroplet(logicalName, providerName, request.ssh_user, droplet),
        status: droplet.status,
      }];
    });
  }

  async releaseMachine(machine: RemoteMachine): Promise<void> {
    const id = machine.provider_id || (await this.findDroplet(machine.provider_name || machine.name))?.id;
    if (!id) return;
    await this.request(`/v2/droplets/${encodeURIComponent(String(id))}`, { method: "DELETE" });
  }

  async listImages(): Promise<MachineImage[]> {
    const images: MachineImage[] = [];
    let path = "/v2/snapshots?resource_type=droplet&per_page=200";
    while (path) {
      const response = await this.request<SnapshotList>(path);
      for (const snapshot of response.snapshots) {
        if (!imageNameIsBoxHavenRemote(snapshot.name)) continue;
        images.push({
          id: String(snapshot.id),
          name: snapshot.name || String(snapshot.id),
          provider: this.name,
          status: "available",
          created_at: snapshot.created_at,
          size_gb: snapshot.size_gigabytes,
          bootstrapped: true,
        });
      }
      path = nextPath(response.links?.pages?.next);
    }
    return images;
  }

  async createImage(machine: RemoteMachine, name: string): Promise<MachineImage> {
    const id = machine.provider_id || (await this.findDroplet(machine.provider_name || machine.name))?.id;
    if (!id) throw new Error(`DigitalOcean droplet for ${machine.name} was not found`);
    await this.request(`/v2/droplets/${encodeURIComponent(String(id))}/actions`, {
      method: "POST",
      body: { type: "snapshot", name },
    });
    // DigitalOcean snapshot creation is asynchronous and the image ID is not
    // known until the action completes; the image appears in listImages later.
    return {
      id: "",
      name,
      provider: this.name,
      status: "creating",
      bootstrapped: imageNameIsBoxHavenRemote(name),
    };
  }

  async deleteImage(imageID: string): Promise<void> {
    await this.request(`/v2/images/${encodeURIComponent(imageID)}`, { method: "DELETE" });
  }

  private async findDroplet(machineName: string): Promise<Droplet | undefined> {
    const tag = machineTag(machineName);
    const response = await this.request<{ droplets: Droplet[] }>(`/v2/droplets?tag_name=${encodeURIComponent(tag)}&per_page=200`);
    const want = machineResourceName(machineName);
    return response.droplets.find((droplet) => droplet.name === want && (droplet.tags || []).includes(tag));
  }

  private async listDroplets(): Promise<Droplet[]> {
    const baseTags = this.config.tags.length > 0 ? this.config.tags : ["boxhaven"];
    const seen = new Map<number, Droplet>();
    for (const tag of baseTags) {
      let path = `/v2/droplets?tag_name=${encodeURIComponent(tag)}&per_page=200`;
      while (path) {
        const response = await this.request<DropletList>(path);
        for (const droplet of response.droplets) {
          seen.set(droplet.id, droplet);
        }
        path = nextPath(response.links?.pages?.next);
      }
    }
    return [...seen.values()];
  }

  private async waitForAddress(id: number): Promise<Droplet> {
    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      const response = await this.request<{ droplet: Droplet }>(`/v2/droplets/${id}`);
      if (publicIPv4(response.droplet)) return response.droplet;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error(`timed out waiting for DigitalOcean droplet ${id} to receive a public IPv4`);
  }

  private async createThrowawaySSHKey(providerName: string): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), "boxhaven-do-no-login-key-"));
    try {
      const keyPath = join(dir, "id_ed25519");
      await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "boxhaven-no-login", "-f", keyPath]);
      const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
      const hash = createHash("sha256").update(publicKey).digest("hex").slice(0, 12);
      const created = await this.request<{ ssh_key: SSHKey }>("/v2/account/keys", {
        method: "POST",
        body: {
          name: `boxhaven-no-login-${sanitizeResourceName(providerName)}-${hash}`,
          public_key: publicKey,
        },
      });
      return created.ssh_key.id;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async deleteSSHKey(id: number): Promise<void> {
    try {
      await this.request(`/v2/account/keys/${encodeURIComponent(String(id))}`, { method: "DELETE" });
    } catch {
      // Do not fail machine creation after the throwaway key has served its purpose.
    }
  }

  private machineFromDroplet(machineName: string, providerName: string, sshUser: string | undefined, droplet: Droplet): RemoteMachine {
    const now = new Date().toISOString();
    return {
      name: machineName,
      provider_name: providerName,
      provider: this.name,
      provider_id: String(droplet.id),
      public_ipv4: publicIPv4(droplet),
      region: droplet.region?.slug || this.config.region,
      size: droplet.size_slug || this.config.size,
      image: droplet.image?.slug || droplet.image?.name || this.config.image,
      ssh_user: sshUser || defaultSSHUser,
      created_at: droplet.created_at || now,
      updated_at: now,
      bootstrap_complete: this.dropletBootstrapComplete(droplet),
    };
  }

  private dropletBootstrapComplete(droplet: Droplet): boolean {
    if (digitalOceanImageIsBoxHavenRemote(droplet.image?.slug) || digitalOceanImageIsBoxHavenRemote(droplet.image?.name)) {
      return true;
    }
    if (digitalOceanImageIsBoxHavenRemote(this.config.image)) {
      return true;
    }
    if (this.config.imageBootstrapped && droplet.image?.id && String(droplet.image.id) === this.config.image) {
      return true;
    }
    return false;
  }

  private machineTags(name: string): string[] {
    return [...new Set([...this.config.tags, machineTag(name)])];
  }

  private async request<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.apiURL}${path}`, {
      method: init.method || "GET",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`DigitalOcean ${init.method || "GET"} ${path} failed: ${detail || response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}

export function digitalOceanProviderFromEnv(env = process.env): DigitalOceanProvider {
  const token = env.DIGITALOCEAN_ACCESS_TOKEN || env.DIGITALOCEAN_TOKEN || env.DO_API_TOKEN;
  if (!token) throw new Error("DigitalOcean provider requires DIGITALOCEAN_ACCESS_TOKEN");
  return new DigitalOceanProvider({
    token,
    region: env.DIGITALOCEAN_REGION || "nyc3",
    size: env.DIGITALOCEAN_SIZE || digitalOceanDefaultSize,
    image: env.BOXHAVEN_REMOTE_IMAGE_DIGITALOCEAN || env.BOXHAVEN_REMOTE_IMAGE || env.DIGITALOCEAN_IMAGE || "ubuntu-24-04-x64",
    imageBootstrapped: Boolean(env.BOXHAVEN_REMOTE_IMAGE_DIGITALOCEAN || env.BOXHAVEN_REMOTE_IMAGE),
    tags: splitList(env.DIGITALOCEAN_TAGS, ["boxhaven"]),
    vpcUUID: env.DIGITALOCEAN_VPC_UUID,
    apiURL: env.BOXHAVEN_DIGITALOCEAN_API_URL,
  });
}

function digitalOceanSizeForRequest(request: CreateMachineRequest, config: DigitalOceanConfig): string {
  const tierSize = request.tier ? digitalOceanSizeForTier(request.tier) : "";
  return tierSize || config.size || digitalOceanDefaultSize;
}

export function digitalOceanSizeForTier(tier: string): string | undefined {
  return digitalOceanTierSizes[tier];
}

export function digitalOceanImageForCreate(image: string): string | number {
  const value = image.trim();
  return /^\d+$/.test(value) ? Number(value) : value;
}

export function digitalOceanImageIsBoxHavenRemote(image: string | undefined): boolean {
  return imageNameIsBoxHavenRemote(image);
}

function publicIPv4(droplet: Droplet): string {
  return droplet.networks?.v4?.find((network) => network.type === "public")?.ip_address || "";
}

function machineTag(name: string): string {
  return `boxhaven-${sanitizeResourceName(name)}`;
}

function providerNameFromDroplet(droplet: Droplet): string {
  if (droplet.name.startsWith("boxhaven-")) return droplet.name.slice("boxhaven-".length);
  const tag = (droplet.tags || []).find((value) => value.startsWith("boxhaven-") && value !== "boxhaven");
  return tag ? tag.slice("boxhaven-".length) : "";
}

function nextPath(next: string | undefined): string {
  if (!next) return "";
  try {
    const parsed = new URL(next);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return next.startsWith("/") ? next : "";
  }
}

function splitList(value: string | undefined, fallback: string[] = []): string[] {
  const parts = (value || "").split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}
