import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightLeft, ChevronRight, MonitorDot, Plus, Settings2, Server, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { CommandBlock, installCommand } from "./access";
import {
  apiFetch,
  formatDate,
  ImagesResponse,
  Machine,
  MachineImage,
  MachinePlan,
  MachinePlanPrice,
  MachineResponse,
  MachinesResponse,
  ProvidersResponse,
  SizesResponse,
  slugName,
  TeamInfo,
} from "./api";
import { useConsole } from "./console-context";
import { CostEstimate } from "./cost-estimate";
import { Drawer } from "./drawer";
import { WorkspaceHead } from "./shell";

type ConnectResponse = MachineResponse & {
  connect: {
    transport?: string;
    cli: string;
    cli_run: string;
  };
};

function imageValue(image: MachineImage): string {
  return image.id || image.name;
}

// Boxes section. The selected box lives in the URL (/boxes/$name) and drives
// the detail drawer; "/" renders the table with no drawer open. The "New box"
// button opens a create drawer.
export function Dashboard({ selectedName }: { selectedName?: string }) {
  const { token, teams, activeTeam } = useConsole();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [size, setSize] = useState("small");
  const [provider, setProvider] = useState("");
  const [image, setImage] = useState("");
  const [manageSizes, setManageSizes] = useState(false);
  const [shortcutName, setShortcutName] = useState("");
  const [shortcutPlan, setShortcutPlan] = useState("");
  const queryClient = useQueryClient();
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: () => apiFetch<ProvidersResponse>("/v1/providers", token),
  });
  const machines = useQuery({
    queryKey: ["machines", token],
    queryFn: () => apiFetch<MachinesResponse>("/v1/machines", token),
    refetchInterval: 15000,
  });
  const providerList = providers.data?.providers || [];
  const defaultProvider = providerList.find((option) => option.default)?.name || providerList[0]?.name || "";
  const selectedProvider = provider || defaultProvider;
  const defaultTeam = activeTeam ? activeTeam.slug || activeTeam.id : teams[0]?.slug || teams[0]?.id || "";
  const activeTeamID = activeTeam?.id || "";
  const sizes = useQuery({
    queryKey: ["sizes", token, activeTeamID, selectedProvider],
    enabled: Boolean(activeTeamID && selectedProvider),
    queryFn: () => apiFetch<SizesResponse>(`/v1/sizes?team=${encodeURIComponent(defaultTeam)}&provider=${encodeURIComponent(selectedProvider)}`, token),
  });
  const images = useQuery({
    queryKey: ["images", token, activeTeamID],
    queryFn: () => apiFetch<ImagesResponse>("/v1/images", token),
    refetchInterval: 30000,
  });
  const imageOptions = useMemo(() => (
    (images.data?.images || []).filter((candidate) => (
      candidate.id
      && (!selectedProvider || candidate.provider === selectedProvider)
      && (!candidate.status || candidate.status === "available")
    ))
  ), [images.data, selectedProvider]);
  const createMachine = useMutation({
    mutationFn: () => apiFetch<MachineResponse>("/v1/machines", token, {
      method: "POST",
      body: { name, size, provider: selectedProvider, ...(image ? { image } : {}), ...(defaultTeam ? { team: defaultTeam } : {}) },
    }),
    onSuccess: (data) => {
      setName("");
      setImage("");
      setAddOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["machines", token] });
      void navigate({ to: "/boxes/$name", params: { name: data.machine.name } });
    },
  });
  const saveShortcut = useMutation({
    mutationFn: () => apiFetch("/v1/sizes/shortcuts", token, {
      method: "POST",
      body: { name: shortcutName, provider: selectedProvider, plan: shortcutPlan, team: defaultTeam },
    }),
    onSuccess: () => {
      const next = shortcutName;
      setShortcutName("");
      setShortcutPlan("");
      setSize(next);
      void queryClient.invalidateQueries({ queryKey: ["sizes", token, activeTeamID] });
    },
  });
  const deleteShortcut = useMutation({
    mutationFn: (shortcut: string) => apiFetch(`/v1/sizes/shortcuts/${encodeURIComponent(shortcut)}?team=${encodeURIComponent(defaultTeam)}`, token, { method: "DELETE" }),
    onSuccess: (_, shortcut) => {
      if (size === shortcut) setSize("small");
      void queryClient.invalidateQueries({ queryKey: ["sizes", token, activeTeamID] });
    },
  });
  const destroyMachine = useMutation({
    mutationFn: (machineName: string) => apiFetch(`/v1/machines/${encodeURIComponent(machineName)}`, token, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["machines", token] });
      void navigate({ to: "/" });
    },
  });
  const moveMachine = useMutation({
    mutationFn: (input: { machineName: string; team: string }) => apiFetch<MachineResponse>(`/v1/machines/${encodeURIComponent(input.machineName)}/move`, token, {
      method: "POST",
      body: { team: input.team },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["machines", token] });
      void navigate({ to: "/" });
    },
  });
  const allMachines = useMemo(() => [...(machines.data?.machines || [])].sort((a, b) => a.name.localeCompare(b.name)), [machines.data]);
  const machineList = useMemo(() => {
    if (!activeTeamID) return allMachines;
    return allMachines.filter((machine) => (machine.team_id || machine.org_id) === activeTeamID);
  }, [activeTeamID, allMachines]);
  const selectedMachine = selectedName ? machineList.find((machine) => machine.name === selectedName) : undefined;
  const missingName = selectedName && machines.data && !selectedMachine ? selectedName : undefined;
  const connect = useQuery({
    queryKey: ["connect", selectedMachine?.name, token],
    enabled: Boolean(selectedMachine),
    queryFn: () => apiFetch<ConnectResponse>(`/v1/machines/${encodeURIComponent(selectedMachine?.name || "")}/connect`, token),
  });

  const createError = createMachine.error ? (createMachine.error as Error).message : "";
  useEffect(() => {
    if (image && !imageOptions.some((option) => imageValue(option) === image)) setImage("");
  }, [image, imageOptions]);
  useEffect(() => {
    if (sizes.data && !sizes.data.sizes.some((option) => option.name === size)) setSize("small");
  }, [size, sizes.data]);

  const selectedSize = sizes.data?.sizes.find((option) => option.name === size);
  const availablePlans = useMemo(() => (
    [...(sizes.data?.plans || [])]
      .filter((plan) => plan.available)
      .sort((left, right) => left.vcpus - right.vcpus || left.memory_mb - right.memory_mb || left.slug.localeCompare(right.slug))
  ), [sizes.data?.plans]);
  const selectedShortcutPlan = availablePlans.find((plan) => plan.slug === shortcutPlan);

  function submit(event: FormEvent) {
    event.preventDefault();
    createMachine.mutate();
  }

  return (
    <>
      <WorkspaceHead
        eyebrow="console"
        title="Boxes"
        actions={(
          <button className="primary-button" type="button" onClick={() => setAddOpen(true)}>
            <Plus size={16} />
            New box
          </button>
        )}
      />

      <div className="workspace-body">
        {machineList.length ? (
          <div className="panel table-panel">
            <table className="data-table rows-clickable">
              <thead>
                <tr>
                  <th aria-label="Status" />
                  <th>Name</th>
                  <th>Location</th>
                  <th>Endpoint</th>
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {machineList.map((machine) => (
                  <tr
                    key={machine.name}
                    className={machine.name === selectedName ? "selected" : undefined}
                    onClick={() => void navigate({ to: "/boxes/$name", params: { name: machine.name } })}
                  >
                    <td className="cell-status"><MonitorDot size={16} /></td>
                    <td><strong>{machine.name}</strong></td>
                    <td>{machine.provider_label || machine.provider || "-"} / {machine.region || "-"}</td>
                    <td><code title={machine.preview_hostname || machine.public_ipv4 || ""}>{machine.preview_hostname || machine.public_ipv4 || "pending"}</code></td>
                    <td className="cell-chevron"><ChevronRight size={16} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : machines.isLoading ? (
          <div className="panel">
            <div className="empty"><Server size={22} /><span>Loading boxes</span></div>
          </div>
        ) : allMachines.length ? (
          <div className="panel">
            <NoTeamBoxes teamName={activeTeam?.name || "this team"} onCreate={() => setAddOpen(true)} />
          </div>
        ) : (
          <div className="panel"><GettingStarted onCreate={() => setAddOpen(true)} /></div>
        )}
      </div>

      <Drawer open={addOpen} onClose={() => setAddOpen(false)} eyebrow="new box" title="Create a box">
        <form className="create-form" onSubmit={submit}>
          <label>
            Machine name
            <input value={name} onChange={(event) => setName(slugName(event.target.value))} placeholder="porch" required />
          </label>
          {providerList.length > 1 ? (
            <label>
              Provider
              <select value={selectedProvider} onChange={(event) => { setProvider(event.target.value); setSize("small"); setShortcutPlan(""); }}>
                {providerList.map((option) => (
                  <option value={option.name} key={option.name}>{option.label}{option.default ? " (default)" : ""}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Size
            <select value={size} onChange={(event) => setSize(event.target.value)} disabled={sizes.isLoading}>
              {(sizes.data?.sizes || []).map((option) => (
                <option value={option.name} key={option.name}>{option.name} - {planHardware(option.plan)}</option>
              ))}
            </select>
          </label>
          {selectedSize ? <PlanSummary plan={selectedSize.plan} hourlyPriceCents={selectedSize.hourly_price_cents} /> : null}
          {sizes.data?.can_manage ? (
            <div className="size-manager">
              <button className="secondary-button size-manager-toggle" type="button" onClick={() => setManageSizes((open) => !open)}>
                <Settings2 size={16} />
                Size shortcuts
              </button>
              {manageSizes ? (
                <div className="size-manager-body">
                  <div className="shortcut-list">
                    {(sizes.data.shortcuts || []).filter((shortcut) => shortcut.provider === selectedProvider).map((shortcut) => (
                      <div key={shortcut.name}>
                        <span><strong>{shortcut.name}</strong><small>{shortcut.plan}</small></span>
                        <button className="icon-button" type="button" title={`Delete ${shortcut.name}`} aria-label={`Delete ${shortcut.name}`} onClick={() => deleteShortcut.mutate(shortcut.name)} disabled={deleteShortcut.isPending}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <label>
                    Shortcut name
                    <input value={shortcutName} onChange={(event) => setShortcutName(slugName(event.target.value))} placeholder="gpu" />
                  </label>
                  <label>
                    Provider plan
                    <select value={shortcutPlan} onChange={(event) => setShortcutPlan(event.target.value)}>
                      <option value="">Choose a plan</option>
                      {availablePlans.map((plan) => <option value={plan.slug} key={plan.slug}>{plan.slug} - {planHardware(plan)} - {planPriceLabel(plan)}</option>)}
                    </select>
                  </label>
                  {selectedShortcutPlan ? <PlanSummary plan={selectedShortcutPlan} hourlyPriceCents={selectedShortcutPlan.hourly_price_cents} /> : null}
                  <button className="secondary-button" type="button" disabled={!shortcutName || !shortcutPlan || saveShortcut.isPending} onClick={() => saveShortcut.mutate()}>
                    <Plus size={16} />
                    {saveShortcut.isPending ? "Saving" : "Save shortcut"}
                  </button>
                  {saveShortcut.error ? <p className="error">{(saveShortcut.error as Error).message}</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {imageOptions.length ? (
            <label>
              Image
              <select value={image} onChange={(event) => setImage(event.target.value)}>
                <option value="">BoxHaven default</option>
                {imageOptions.map((option) => (
                  <option value={imageValue(option)} key={`${option.provider || "provider"}/${imageValue(option)}`}>
                    {option.name} ({option.provider || "provider"})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {teams.length ? (
            <div className="active-team-note">
              <span>Active team</span>
              <strong>{activeTeam?.name || teams[0]?.name || "Team"}</strong>
            </div>
          ) : null}
          <button className="primary-button" type="submit" disabled={createMachine.isPending}>
            <Plus size={16} />
            {createMachine.isPending ? "Creating" : "Create box"}
          </button>
          {createError ? <p className="error">{createError}</p> : null}
        </form>
      </Drawer>

      <BoxDrawer
        open={Boolean(selectedName)}
        machine={selectedMachine}
        missingName={missingName}
        teams={teams}
        connect={connect.data}
        loading={machines.isLoading || (Boolean(selectedMachine) && connect.isLoading)}
        onClose={() => void navigate({ to: "/" })}
        onDestroy={(machineName) => destroyMachine.mutate(machineName)}
        destroying={destroyMachine.isPending}
        onMove={(machineName, targetTeam) => moveMachine.mutate({ machineName, team: targetTeam })}
        moving={moveMachine.isPending}
        moveError={moveMachine.error ? (moveMachine.error as Error).message : ""}
      />
    </>
  );
}

function GettingStarted({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="getting-started">
      <div className="panel-heading small">
        <span>getting started</span>
        <h2>Your first box</h2>
      </div>
      <ol className="steps">
        <li>
          <span className="step-num">1</span>
          <div>
            <strong>Install the CLI</strong>
            <CommandBlock label="Install" value={installCommand} />
          </div>
        </li>
        <li>
          <span className="step-num">2</span>
          <div>
            <strong>Sign in and enable direct SSH</strong>
            <CommandBlock label="Login" value="bh login" />
            <CommandBlock label="SSH setup" value="bh ssh-config install" />
          </div>
        </li>
        <li>
          <span className="step-num">3</span>
          <div>
            <strong>Create a box and hand it to your agent</strong>
            <CommandBlock label="Create" value="bh create work" />
            <CommandBlock label="Run" value="bh run work claude" />
            <CommandBlock label="Reattach" value="bh connect work" />
          </div>
        </li>
      </ol>
      <p className="hint">Disconnect whenever you like. <code>bh connect work</code> reattaches to the running session.</p>
      <p className="hint">
        Prefer clicking?{" "}
        <button className="link-button" type="button" onClick={onCreate}>Create a box from the console</button>.
      </p>
    </div>
  );
}

function NoTeamBoxes({ teamName, onCreate }: { teamName: string; onCreate: () => void }) {
  return (
    <div className="empty empty-action">
      <Server size={22} />
      <span>No boxes in {teamName}.</span>
      <button className="link-button" type="button" onClick={onCreate}>Create one</button>
    </div>
  );
}

function BoxDrawer({ open, machine, missingName, teams, connect, loading, onClose, onDestroy, destroying, onMove, moving, moveError }: {
  open: boolean;
  machine?: Machine;
  missingName?: string;
  teams: TeamInfo[];
  connect?: ConnectResponse;
  loading: boolean;
  onClose: () => void;
  onDestroy: (name: string) => void;
  destroying: boolean;
  onMove: (name: string, team: string) => void;
  moving: boolean;
  moveError: string;
}) {
  if (machine) {
    return (
      <Drawer
        wide
        open={open}
        onClose={onClose}
        eyebrow={connect?.status || "box"}
        title={machine.name}
        footer={(
          <button
            className="danger-button"
            type="button"
            onClick={() => {
              if (window.confirm(`Destroy ${machine.name}?`)) onDestroy(machine.name);
            }}
            disabled={destroying}
            title="Destroy box"
          >
            <Trash2 size={16} />
            {destroying ? "Destroying" : "Destroy box"}
          </button>
        )}
      >
        <div className="metrics">
          <Metric label="Provider" value={machine.provider_label || machine.provider || "-"} />
          <Metric label="Region" value={machine.region || "-"} />
          <Metric label="Size" value={machine.size_shortcut ? `${machine.size_shortcut} (${machine.size || "-"})` : machine.size || "-"} />
          <Metric label="Image" value={machine.image || "-"} />
        </div>
        <CommandBlock label="Preview" value={machine.preview_url || ""} />
        <CommandBlock label="Connect" value={connect?.connect.cli || `bh connect ${machine.name}`} />
        <CommandBlock label="Run" value={connect?.connect.cli_run || `bh run ${machine.name}`} />
        <dl className="meta">
          <div><dt>Team</dt><dd>{machine.team_name || machine.team_slug || "-"}</dd></div>
          <div><dt>Provider ID</dt><dd>{machine.provider_id || "-"}</dd></div>
          <div><dt>Project path</dt><dd>{machine.project_path || "/opt/boxhaven/project"}</dd></div>
          <div><dt>Repo</dt><dd>{machine.repo_url || "-"}</dd></div>
          <div><dt>Branch</dt><dd>{machine.branch || "-"}</dd></div>
          <div><dt>Last sync</dt><dd>{formatDate(machine.last_synced_at)}</dd></div>
          <div><dt>Updated</dt><dd>{formatDate(machine.updated_at)}</dd></div>
        </dl>
        <MoveTeamControl key={`${machine.name}:${machine.team_id || ""}`} machine={machine} teams={teams} onMove={onMove} moving={moving} moveError={moveError} />
      </Drawer>
    );
  }

  return (
    <Drawer wide open={open} onClose={onClose} eyebrow="box" title={missingName || "Box"}>
      {missingName ? (
        <div className="detail-notfound">
          <Server size={32} />
          <strong>No box named "{missingName}"</strong>
          <span>It may have been destroyed, renamed, or never existed.</span>
          <button className="link-button" type="button" onClick={onClose}>Back to all boxes</button>
        </div>
      ) : (
        <div className="empty"><Server size={22} /><span>{loading ? "Loading box" : "Select a box"}</span></div>
      )}
    </Drawer>
  );
}

function MoveTeamControl({ machine, teams, onMove, moving, moveError }: {
  machine: Machine;
  teams: TeamInfo[];
  onMove: (name: string, team: string) => void;
  moving: boolean;
  moveError: string;
}) {
  const [target, setTarget] = useState("");
  const otherTeams = teams.filter((team) => team.id !== (machine.team_id || machine.org_id));
  if (!otherTeams.length) return null;
  return (
    <div className="move-team">
      <label>
        Move to team
        <select value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="">Choose a team</option>
          {otherTeams.map((team) => (
            <option value={team.slug || team.id} key={team.id}>{team.name}</option>
          ))}
        </select>
      </label>
      <button className="primary-button" type="button" disabled={!target || moving} onClick={() => onMove(machine.name, target)}>
        <ArrowRightLeft size={16} />
        {moving ? "Moving" : "Move"}
      </button>
      {moveError ? <p className="error">{moveError}</p> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric" title={value}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PlanSummary({ plan, hourlyPriceCents }: { plan: MachinePlan; hourlyPriceCents?: number }) {
  const providerPrice = planPrice(plan);
  const hourly = hourlyPriceCents !== undefined ? hourlyPriceCents / 100 : providerPrice?.hourly;
  const currency = hourlyPriceCents !== undefined ? "USD" : providerPrice?.currency || "USD";
  return (
    <div className="plan-summary">
      <span>{planHardware(plan)}</span>
      {hourly !== undefined ? <PriceEstimate hourly={hourly} currency={currency} /> : null}
    </div>
  );
}

function PriceEstimate({ hourly, currency }: { hourly: number; currency: string }) {
  return <CostEstimate hourly={hourly} currency={currency} />;
}

function planPriceLabel(plan: MachinePlan): string {
  if (plan.hourly_price_cents !== undefined) return `${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(plan.hourly_price_cents / 100)}/hr`;
  const price = planPrice(plan);
  if (!price) return "price unavailable";
  return `${new Intl.NumberFormat(undefined, { style: "currency", currency: price.currency, maximumFractionDigits: 4 }).format(price.hourly)}/hr`;
}

function planPrice(plan: MachinePlan): MachinePlanPrice | undefined {
  return plan.prices[0];
}

function planHardware(plan: MachinePlan): string {
  const memory = plan.memory_mb >= 1024 ? `${plan.memory_mb / 1024} GB` : `${plan.memory_mb} MB`;
  const gpu = plan.gpu ? ` / ${plan.gpu.count}x ${plan.gpu.model}` : "";
  return `${plan.vcpus} vCPU / ${memory} / ${plan.disk_gb} GB${gpu}`;
}
