import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRightLeft, Cloud, MonitorDot, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { CommandBlock, installCommand } from "./access";
import {
  apiFetch,
  formatDate,
  Machine,
  MachineResponse,
  MachinesResponse,
  ProvidersResponse,
  slugName,
  TeamInfo,
} from "./api";
import logoURL from "./assets/boxhaven-logo.png";
import { useConsole } from "./console-context";

type ConnectResponse = MachineResponse & {
  connect: {
    transport?: string;
    cli: string;
    cli_run: string;
  };
};

type MachineTier = "small" | "medium" | "large";

const machineTiers: Array<{ value: MachineTier; label: string; detail: string }> = [
  { value: "small", label: "Small", detail: "2 vCPU / 4 GB" },
  { value: "medium", label: "Medium", detail: "4 vCPU / 8 GB" },
  { value: "large", label: "Large", detail: "8 vCPU / 16 GB" },
];

// Boxes dashboard. The selected box lives in the URL (/boxes/$name); "/"
// renders the dashboard with nothing selected.
export function Dashboard({ selectedName }: { selectedName?: string }) {
  const { token, user, teams, activeTeam } = useConsole();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [tier, setTier] = useState<MachineTier>("small");
  const [provider, setProvider] = useState("");
  const [team, setTeam] = useState("");
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
  const defaultTeam = activeTeam ? activeTeam.slug || activeTeam.id : teams[0]?.slug || teams[0]?.id || "";
  const createMachine = useMutation({
    mutationFn: () => apiFetch<MachineResponse>("/v1/machines", token, {
      method: "POST",
      body: { name, tier, ...(provider ? { provider } : {}), ...((team || defaultTeam) ? { team: team || defaultTeam } : {}) },
    }),
    onSuccess: (data) => {
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["machines", token] });
      void navigate({ to: "/boxes/$name", params: { name: data.machine.name } });
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
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["machines", token] }),
  });
  const machineList = useMemo(() => [...(machines.data?.machines || [])].sort((a, b) => a.name.localeCompare(b.name)), [machines.data]);
  const selectedMachine = selectedName ? machineList.find((machine) => machine.name === selectedName) : undefined;
  const missingName = selectedName && machines.data && !selectedMachine ? selectedName : undefined;
  const connect = useQuery({
    queryKey: ["connect", selectedMachine?.name, token],
    enabled: Boolean(selectedMachine),
    queryFn: () => apiFetch<ConnectResponse>(`/v1/machines/${encodeURIComponent(selectedMachine?.name || "")}/connect`, token),
  });

  const createError = createMachine.error ? (createMachine.error as Error).message : "";
  const paymentRequired = createError.includes("/billing") || createError.toLowerCase().includes("free tier");
  const billingTeamRef = team || defaultTeam;

  function submit(event: FormEvent) {
    event.preventDefault();
    createMachine.mutate();
  }

  return (
    <section className="dashboard">
      <aside className="rail">
        <div className="account">
          <img src={logoURL} alt="" />
          <div>
            <span>signed in</span>
            <strong>{user?.email || "account"}</strong>
          </div>
        </div>
        <form className="create-form" onSubmit={submit}>
          <div className="panel-heading small">
            <span>new box</span>
            <h2>New box</h2>
          </div>
          <label>
            Machine name
            <input value={name} onChange={(event) => setName(slugName(event.target.value))} placeholder="porch" required />
          </label>
          {providerList.length > 1 ? (
            <label>
              Provider
              <select value={provider || defaultProvider} onChange={(event) => setProvider(event.target.value)}>
                {providerList.map((option) => (
                  <option value={option.name} key={option.name}>{option.label}{option.default ? " (default)" : ""}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Size
            <select value={tier} onChange={(event) => setTier(event.target.value as MachineTier)}>
              {machineTiers.map((option) => (
                <option value={option.value} key={option.value}>{option.label} - {option.detail}</option>
              ))}
            </select>
          </label>
          {teams.length ? (
            <label>
              Team
              <select value={team || defaultTeam} onChange={(event) => setTeam(event.target.value)}>
                {teams.map((option) => (
                  <option value={option.slug || option.id} key={option.id}>{option.name}{option.id === activeTeam?.id ? " (active)" : ""}</option>
                ))}
              </select>
            </label>
          ) : null}
          <button className="primary-button" type="submit" disabled={createMachine.isPending}>
            <Plus size={16} />
            {createMachine.isPending ? "Creating" : "Create"}
          </button>
          {createError ? (
            <p className="error">
              {createError}
              {paymentRequired ? (
                <>
                  {" "}
                  {billingTeamRef ? (
                    <Link className="link-button" to="/billing/$team" params={{ team: billingTeamRef }}>Upgrade</Link>
                  ) : (
                    <Link className="link-button" to="/billing">Upgrade</Link>
                  )}
                </>
              ) : null}
            </p>
          ) : null}
        </form>
        {providerList.length > 1 ? (
          <div className="provider-strip">
            {providerList.map((providerOption) => (
              <div className="provider-pill" key={providerOption.name}>
                <Cloud size={16} />
                <span>{providerOption.label}</span>
              </div>
            ))}
          </div>
        ) : null}
      </aside>

      <div className="machine-table">
        <div className="section-heading">
          <div>
            <span>boxes</span>
            <strong>{machineList.length}</strong>
          </div>
          <button className="icon-button" type="button" onClick={() => void machines.refetch()} title="Refresh" aria-label="Refresh machines">
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="rows">
          {machineList.map((machine) => (
            <Link
              className="machine-row"
              to="/boxes/$name"
              params={{ name: machine.name }}
              activeProps={{ className: "selected" }}
              key={machine.name}
            >
              <span className="machine-status"><MonitorDot size={16} /></span>
              <span className="machine-id">
                <strong>{machine.name}</strong>
                <small>{machine.provider_label || machine.provider || "provider"} / {machine.region || "region"}</small>
              </span>
              {machine.team_id && activeTeam && machine.team_id !== activeTeam.id ? <span className="badge">{machine.team_slug || machine.team_name}</span> : null}
              <code title={machine.preview_hostname || machine.public_ipv4 || ""}>{machine.preview_hostname || machine.public_ipv4 || "pending"}</code>
            </Link>
          ))}
          {!machineList.length ? (
            machines.isLoading ? (
              <div className="empty">
                <Server size={24} />
                <span>Loading boxes</span>
              </div>
            ) : (
              <GettingStarted />
            )
          ) : null}
        </div>
      </div>

      <MachineDetail
        machine={selectedMachine}
        missingName={missingName}
        teams={teams}
        connect={connect.data}
        loading={machines.isLoading || (Boolean(selectedMachine) && connect.isLoading)}
        onDestroy={(machineName) => destroyMachine.mutate(machineName)}
        destroying={destroyMachine.isPending}
        onMove={(machineName, targetTeam) => moveMachine.mutate({ machineName, team: targetTeam })}
        moving={moveMachine.isPending}
        moveError={moveMachine.error ? (moveMachine.error as Error).message : ""}
      />
    </section>
  );
}

function GettingStarted() {
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
            <strong>Sign in from your terminal</strong>
            <CommandBlock label="Login" value="bh login" />
          </div>
        </li>
        <li>
          <span className="step-num">3</span>
          <div>
            <strong>Create a box and hand it to your agent</strong>
            <CommandBlock label="Create" value="bh create work" />
            <CommandBlock label="Run" value="bh run work claude --continue" />
          </div>
        </li>
      </ol>
      <p className="hint">Prefer clicking? The form on the left creates a box right from the console.</p>
    </div>
  );
}

function MachineDetail({ machine, missingName, teams, connect, loading, onDestroy, destroying, onMove, moving, moveError }: {
  machine?: Machine;
  missingName?: string;
  teams: TeamInfo[];
  connect?: ConnectResponse;
  loading: boolean;
  onDestroy: (name: string) => void;
  destroying: boolean;
  onMove: (name: string, team: string) => void;
  moving: boolean;
  moveError: string;
}) {
  if (!machine) {
    if (missingName) {
      return (
        <div className="detail empty-detail">
          <div className="detail-notfound">
            <Server size={32} />
            <strong>No box named "{missingName}"</strong>
            <span>It may have been destroyed, renamed, or never existed.</span>
            <Link className="link-button" to="/">Back to all boxes</Link>
          </div>
        </div>
      );
    }
    return (
      <div className="detail empty-detail">
        <Server size={32} />
        <span>{loading ? "Loading boxes" : "Create or select a box"}</span>
      </div>
    );
  }
  return (
    <div className="detail">
      <div className="detail-header">
        <div>
          <span>{connect?.status || "box"}</span>
          <h1>{machine.name}</h1>
        </div>
        <button className="danger-button" type="button" onClick={() => onDestroy(machine.name)} disabled={destroying} title="Destroy machine">
          <Trash2 size={16} />
          Destroy
        </button>
      </div>
      <div className="metrics">
        <Metric label="Provider" value={machine.provider_label || machine.provider || "-"} />
        <Metric label="Region" value={machine.region || "-"} />
        <Metric label="Size" value={machine.size || "-"} />
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
    </div>
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
