import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { Activity, Check, Cloud, Home, Layers, LogOut, MonitorDot, Plus, RefreshCw, Server, ShieldCheck, Trash2, Users, XCircle } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccessPanel, CommandBlock } from "./access";
import {
  apiFetch,
  AuthUser,
  formatDate,
  formatUserCode,
  Machine,
  MachineResponse,
  MachinesResponse,
  ProvidersResponse,
  sectionKey,
  slugName,
  tokenKey,
  WhoamiResponse,
} from "./api";
import logoURL from "./assets/boxhaven-logo.png";
import { ImagesView } from "./images";
import { InvitePanel } from "./invite";
import "./styles.css";
import { TeamView } from "./team";

type DeviceStatusResponse = {
  user_code: string;
  status: "pending" | "approved" | "denied";
};

type ConnectResponse = MachineResponse & {
  connect: {
    transport?: string;
    cli: string;
    cli_run: string;
  };
};

type MachineTier = "small" | "medium" | "large";

type Section = "boxes" | "team" | "images";

const machineTiers: Array<{ value: MachineTier; label: string; detail: string }> = [
  { value: "small", label: "Small", detail: "2 vCPU / 4 GB" },
  { value: "medium", label: "Medium", detail: "4 vCPU / 8 GB" },
  { value: "large", label: "Large", detail: "8 vCPU / 16 GB" },
];

const queryClient = new QueryClient();

const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: ConsoleRoute,
});

const deviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/device",
  component: ConsoleRoute,
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite",
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === "string" ? search.id : "",
  }),
  component: InviteRoute,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, deviceRoute, inviteRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function AppShell() {
  return <Outlet />;
}

function InviteRoute() {
  const { id } = inviteRoute.useSearch();
  return <InvitePanel invitationId={id} />;
}

function ConsoleRoute() {
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || "");
  const [deviceUserCode, setDeviceUserCode] = useState(() => readDeviceUserCode());
  const [section, setSection] = useState<Section>(() => readInitialSection());
  const session = useQuery({
    queryKey: ["session", token],
    enabled: token.length > 0,
    retry: false,
    queryFn: () => apiFetch<WhoamiResponse>("/v1/auth/whoami", token),
  });
  const authenticated = Boolean(token && session.data?.authenticated);
  const isAdmin = Boolean(session.data?.admin);
  const activeSection: Section = section === "images" && !isAdmin ? "boxes" : section;

  function handleToken(nextToken: string) {
    localStorage.setItem(tokenKey, nextToken);
    setToken(nextToken);
  }

  function handleLogout() {
    if (token) {
      void apiFetch("/v1/auth/sign-out", token, { method: "POST", body: {} }).catch(() => undefined);
    }
    localStorage.removeItem(tokenKey);
    setToken("");
    setSection("boxes");
    queryClient.clear();
  }

  function clearDevicePrompt() {
    setDeviceUserCode("");
    if (window.location.pathname === "/device") {
      window.history.replaceState(null, "", "/");
    }
  }

  return (
    <main className="console">
      <div className="backdrop" />
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><img src={logoURL} alt="" /></div>
          <div>
            <strong>BoxHaven</strong>
            <span>remote dev boxes</span>
          </div>
        </div>
        {authenticated && !deviceUserCode ? (
          <nav className="section-tabs">
            <button type="button" className={activeSection === "boxes" ? "active" : ""} onClick={() => setSection("boxes")}>
              <Server size={15} />
              Boxes
            </button>
            <button type="button" className={activeSection === "team" ? "active" : ""} onClick={() => setSection("team")}>
              <Users size={15} />
              Team
            </button>
            {isAdmin ? (
              <button type="button" className={activeSection === "images" ? "active" : ""} onClick={() => setSection("images")}>
                <Layers size={15} />
                Images
              </button>
            ) : null}
          </nav>
        ) : null}
        <div className="topbar-actions">
          <span className="pulse"><Activity size={14} /> API</span>
          {authenticated ? (
            <button className="icon-button" type="button" onClick={handleLogout} title="Log out" aria-label="Log out">
              <LogOut size={17} />
            </button>
          ) : null}
        </div>
      </header>

      {authenticated ? (
        deviceUserCode ? (
          <DeviceGrantPanel token={token} user={session.data?.user} userCode={deviceUserCode} onDone={clearDevicePrompt} />
        ) : activeSection === "team" ? (
          <TeamView token={token} user={session.data?.user} />
        ) : activeSection === "images" ? (
          <ImagesView token={token} />
        ) : (
          <Dashboard token={token} user={session.data?.user} />
        )
      ) : (
        <AccessPanel onToken={handleToken} deviceUserCode={deviceUserCode} />
      )}
    </main>
  );
}

function DeviceGrantPanel({ token, user, userCode, onDone }: {
  token: string;
  user?: AuthUser;
  userCode: string;
  onDone: () => void;
}) {
  const verify = useQuery({
    queryKey: ["device-login", userCode, token],
    retry: false,
    queryFn: () => apiFetch<DeviceStatusResponse>(`/v1/auth/device?user_code=${encodeURIComponent(userCode)}`, token),
  });
  const approve = useMutation({
    mutationFn: () => apiFetch<{ success: boolean }>("/v1/auth/device/approve", token, { method: "POST", body: { userCode } }),
  });
  const deny = useMutation({
    mutationFn: () => apiFetch<{ success: boolean }>("/v1/auth/device/deny", token, { method: "POST", body: { userCode } }),
  });
  const finished = approve.isSuccess || deny.isSuccess;
  const blocked = verify.isLoading || verify.isError || finished || approve.isPending || deny.isPending;

  return (
    <section className="access-layout grant-layout">
      <div className="welcome-panel compact">
        <div className="logo-stage"><img src={logoURL} alt="BoxHaven logo" /></div>
        <div className="terminal-card">
          <div className="terminal-title">
            <span />
            <span />
            <span />
          </div>
          <pre>{`$ bh login
browser grant requested
account: ${user?.email || "signed-in user"}
code: ${formatUserCode(userCode)}`}</pre>
        </div>
      </div>
      <div className="auth-panel grant-panel">
        <div className="grant-icon"><ShieldCheck size={28} /></div>
        <div className="panel-heading">
          <span>CLI access request</span>
          <h1>Allow BoxHaven CLI?</h1>
          <p>Grant this terminal session access as <strong>{user?.email || "this account"}</strong>.</p>
        </div>
        <div className="code-chip">{formatUserCode(userCode)}</div>
        {verify.error ? <p className="error">{(verify.error as Error).message}</p> : null}
        {approve.isSuccess ? <p className="success-text">Access granted. You can return to the terminal.</p> : null}
        {deny.isSuccess ? <p className="error">Request denied. You can return to the terminal.</p> : null}
        <div className="grant-actions">
          {finished ? (
            <button className="primary-button" type="button" onClick={onDone}>
              <Check size={16} />
              Done
            </button>
          ) : (
            <>
              <button className="primary-button" type="button" onClick={() => approve.mutate()} disabled={blocked}>
                <Check size={16} />
                Allow
              </button>
              <button className="danger-button" type="button" onClick={() => deny.mutate()} disabled={blocked}>
                <XCircle size={16} />
                Deny
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Dashboard({ token, user }: { token: string; user?: AuthUser }) {
  const [name, setName] = useState("");
  const [tier, setTier] = useState<MachineTier>("small");
  const [provider, setProvider] = useState("");
  const [selected, setSelected] = useState<string>("");
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
  const createMachine = useMutation({
    mutationFn: () => apiFetch<MachineResponse>("/v1/machines", token, {
      method: "POST",
      body: { name, tier, ...(provider ? { provider } : {}) },
    }),
    onSuccess: (data) => {
      setName("");
      setSelected(data.machine.name);
      void queryClient.invalidateQueries({ queryKey: ["machines", token] });
    },
  });
  const destroyMachine = useMutation({
    mutationFn: (machineName: string) => apiFetch(`/v1/machines/${encodeURIComponent(machineName)}`, token, { method: "DELETE" }),
    onSuccess: () => {
      setSelected("");
      void queryClient.invalidateQueries({ queryKey: ["machines", token] });
    },
  });
  const machineList = useMemo(() => [...(machines.data?.machines || [])].sort((a, b) => a.name.localeCompare(b.name)), [machines.data]);
  const selectedMachine = machineList.find((machine) => machine.name === selected) || machineList[0];
  const connect = useQuery({
    queryKey: ["connect", selectedMachine?.name, token],
    enabled: Boolean(selectedMachine),
    queryFn: () => apiFetch<ConnectResponse>(`/v1/machines/${encodeURIComponent(selectedMachine?.name || "")}/connect`, token),
  });

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
            <h2>Make room</h2>
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
          <button className="primary-button" type="submit" disabled={createMachine.isPending}>
            <Plus size={16} />
            {createMachine.isPending ? "Creating" : "Create"}
          </button>
          {createMachine.error ? <p className="error">{(createMachine.error as Error).message}</p> : null}
        </form>
        <div className="provider-strip">
          {providerList.map((providerOption) => (
            <div className="provider-pill" key={providerOption.name}>
              <Cloud size={16} />
              <span>{providerOption.label}</span>
            </div>
          ))}
        </div>
      </aside>

      <div className="machine-table">
        <div className="section-heading">
          <div>
            <span>rooms occupied</span>
            <strong>{machineList.length}</strong>
          </div>
          <button className="icon-button" type="button" onClick={() => void machines.refetch()} title="Refresh" aria-label="Refresh machines">
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="rows">
          {machineList.map((machine) => (
            <button className={`machine-row ${machine.name === selectedMachine?.name ? "selected" : ""}`} type="button" key={machine.name} onClick={() => setSelected(machine.name)}>
              <span className="machine-status"><MonitorDot size={16} /></span>
              <span>
                <strong>{machine.name}</strong>
                <small>{machine.provider_label || machine.provider || "provider"} / {machine.region || "region"}</small>
              </span>
              <code>{machine.preview_hostname || machine.public_ipv4 || "pending"}</code>
            </button>
          ))}
          {!machineList.length ? (
            <div className="empty">
              <Home size={24} />
              <span>No boxes checked in.</span>
            </div>
          ) : null}
        </div>
      </div>

      <MachineDetail
        machine={selectedMachine}
        connect={connect.data}
        loading={machines.isLoading || connect.isLoading}
        onDestroy={(machineName) => destroyMachine.mutate(machineName)}
        destroying={destroyMachine.isPending}
      />
    </section>
  );
}

function MachineDetail({ machine, connect, loading, onDestroy, destroying }: {
  machine?: Machine;
  connect?: ConnectResponse;
  loading: boolean;
  onDestroy: (name: string) => void;
  destroying: boolean;
}) {
  if (!machine) {
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
        <div><dt>Provider ID</dt><dd>{machine.provider_id || "-"}</dd></div>
        <div><dt>Project path</dt><dd>{machine.project_path || "/opt/boxhaven/project"}</dd></div>
        <div><dt>Repo</dt><dd>{machine.repo_url || "-"}</dd></div>
        <div><dt>Branch</dt><dd>{machine.branch || "-"}</dd></div>
        <div><dt>Last sync</dt><dd>{formatDate(machine.last_synced_at)}</dd></div>
        <div><dt>Updated</dt><dd>{formatDate(machine.updated_at)}</dd></div>
      </dl>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function readDeviceUserCode(): string {
  const params = new URLSearchParams(window.location.search);
  return (params.get("user_code") || params.get("code") || "").trim();
}

function readInitialSection(): Section {
  const stored = sessionStorage.getItem(sectionKey);
  if (stored === "team" || stored === "images") {
    sessionStorage.removeItem(sectionKey);
    return stored;
  }
  return "boxes";
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
