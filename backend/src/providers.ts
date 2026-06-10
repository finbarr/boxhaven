import { digitalOceanProviderFromEnv } from "./digitalocean.js";
import { hetznerProviderFromEnv } from "./hetzner.js";
import { MachineProvider, MachineProviderInfo, RemoteMachine } from "./types.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, MachineProvider>();

  constructor(providers: MachineProvider[], readonly defaultName: string) {
    for (const provider of providers) {
      this.providers.set(provider.name, provider);
    }
    if (!this.providers.has(defaultName)) {
      throw new Error(`default provider ${defaultName} is not configured`);
    }
  }

  get default(): MachineProvider {
    return this.providers.get(this.defaultName) as MachineProvider;
  }

  get(name: string | undefined): MachineProvider | undefined {
    if (!name) return this.default;
    return this.providers.get(name.trim().toLowerCase());
  }

  forMachine(machine: Pick<RemoteMachine, "provider" | "name">): MachineProvider {
    const provider = this.get(machine.provider);
    if (!provider) {
      throw new Error(`machine ${machine.name} uses provider ${machine.provider}, which is not configured on this backend`);
    }
    return provider;
  }

  list(): MachineProvider[] {
    return [...this.providers.values()];
  }

  names(): string[] {
    return [...this.providers.keys()];
  }
}

export function providerInfo(provider: MachineProvider, defaultName?: string): MachineProviderInfo {
  const base = provider.info || {
    name: provider.name,
    label: provider.label || provider.name,
    capabilities: ["create", "destroy", "list", "connect"] as MachineProviderInfo["capabilities"],
  };
  const capabilities = new Set(base.capabilities);
  if (typeof provider.listImages === "function") capabilities.add("images");
  if (typeof provider.createImage === "function") capabilities.add("snapshot");
  return {
    ...base,
    capabilities: [...capabilities],
    default: provider.name === defaultName,
  };
}

export function providerRegistryFromEnv(env = process.env): ProviderRegistry {
  const providers: MachineProvider[] = [];
  if (env.DIGITALOCEAN_ACCESS_TOKEN || env.DIGITALOCEAN_TOKEN || env.DO_API_TOKEN) {
    providers.push(digitalOceanProviderFromEnv(env));
  }
  if (env.HCLOUD_TOKEN || env.HETZNER_API_TOKEN) {
    providers.push(hetznerProviderFromEnv(env));
  }
  if (providers.length === 0) {
    throw new Error(
      "no machine provider is configured; set DIGITALOCEAN_ACCESS_TOKEN for DigitalOcean or HCLOUD_TOKEN for Hetzner Cloud",
    );
  }
  const requested = env.BOXHAVEN_BACKEND_PROVIDER?.trim().toLowerCase();
  if (requested) {
    if (!providers.some((provider) => provider.name === requested)) {
      throw new Error(`BOXHAVEN_BACKEND_PROVIDER is ${requested}, but that provider has no credentials configured`);
    }
    return new ProviderRegistry(providers, requested);
  }
  return new ProviderRegistry(providers, providers[0].name);
}
