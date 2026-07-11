import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BackendState, RemoteMachine, TeamImageRecord, stateVersion } from "./types.js";

export class StateStore {
  private state: BackendState | undefined;

  constructor(
    private readonly path: string,
    private readonly provider: string,
  ) {}

  async load(): Promise<BackendState> {
    if (this.state) return this.snapshot();
    this.state = {
      version: stateVersion,
      provider: this.provider,
      machines: {},
    };
    try {
      const data = await readFile(this.path, "utf8");
      if (data.trim() !== "") {
        const parsed = JSON.parse(data) as BackendState;
        this.state = {
          version: parsed.version || stateVersion,
          provider: parsed.provider || this.provider,
          machines: parsed.machines || {},
          images: parsed.images || {},
          updated_at: parsed.updated_at,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.snapshot();
  }

  async listMachines(): Promise<RemoteMachine[]> {
    const state = await this.load();
    return Object.values(state.machines);
  }

  async listMachinesForUser(userID: string): Promise<RemoteMachine[]> {
    const state = await this.load();
    return Object.values(state.machines).filter((machine) => machine.user_id === userID);
  }

  async listMachinesForOrg(orgID: string): Promise<RemoteMachine[]> {
    const state = await this.load();
    return Object.values(state.machines).filter((machine) => machine.org_id === orgID);
  }

  async getMachine(userID: string, name: string): Promise<RemoteMachine | undefined> {
    const state = await this.load();
    return state.machines[machineKey(userID, name)];
  }

  async putMachine(machine: RemoteMachine): Promise<void> {
    if (!machine.user_id) throw new Error("machine user_id is required");
    await this.update((state) => {
      state.machines[machineKey(machine.user_id as string, machine.name)] = machine;
    });
  }

  async renameMachine(userID: string, fromName: string, machine: RemoteMachine): Promise<void> {
    if (!machine.user_id) throw new Error("machine user_id is required");
    if (machine.user_id !== userID) throw new Error("machine user_id does not match rename owner");
    await this.update((state) => {
      delete state.machines[machineKey(userID, fromName)];
      state.machines[machineKey(userID, machine.name)] = machine;
    });
  }

  async deleteMachine(userID: string, name: string): Promise<void> {
    await this.update((state) => {
      delete state.machines[machineKey(userID, name)];
    });
  }

  async listImagesForOrg(orgID: string): Promise<TeamImageRecord[]> {
    const state = await this.load();
    return Object.values(state.images || {}).filter((image) => image.org_id === orgID);
  }

  async getImageForOrg(orgID: string, provider: string, idOrName: string): Promise<TeamImageRecord | undefined> {
    const want = idOrName.trim();
    if (!want) return undefined;
    const state = await this.load();
    return Object.values(state.images || {}).find((image) => (
      image.org_id === orgID
      && image.provider === provider
      && (image.id === want || image.name === want)
    ));
  }

  async putImage(image: TeamImageRecord): Promise<void> {
    if (!image.org_id) throw new Error("image org_id is required");
    if (!image.provider) throw new Error("image provider is required");
    if (!image.name) throw new Error("image name is required");
    await this.update((state) => {
      state.images = { ...(state.images || {}) };
      for (const [key, existing] of Object.entries(state.images)) {
        if (
          existing.org_id === image.org_id
          && existing.provider === image.provider
          && (existing.name === image.name || (!!image.id && existing.id === image.id))
        ) {
          delete state.images[key];
        }
      }
      state.images[imageKey(image)] = image;
    });
  }

  async deleteImageForOrg(orgID: string, provider: string, idOrName: string): Promise<void> {
    const want = idOrName.trim();
    if (!want) return;
    await this.update((state) => {
      if (!state.images) return;
      for (const [key, image] of Object.entries(state.images)) {
        if (image.org_id === orgID && image.provider === provider && (image.id === want || image.name === want)) {
          delete state.images[key];
        }
      }
    });
  }

  private async update(fn: (state: BackendState) => void): Promise<void> {
    const state = await this.load();
    fn(state);
    state.version = stateVersion;
    state.updated_at = new Date().toISOString();
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(state, null, 2)}\n`);
    this.state = state;
  }

  private snapshot(): BackendState {
    if (!this.state) {
      return { version: stateVersion, provider: this.provider, machines: {} };
    }
    return {
      ...this.state,
      machines: { ...this.state.machines },
      images: { ...(this.state.images || {}) },
    };
  }
}

function machineKey(userID: string, name: string): string {
  return `${userID}:${name}`;
}

function imageKey(image: TeamImageRecord): string {
  return `${image.org_id}:${image.provider}:${image.id || image.name}`;
}
