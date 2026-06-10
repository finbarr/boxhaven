import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, CreditCard, LogOut, Plus, Send, Server, Trash2, Users, XCircle } from "lucide-react";
import { FormEvent, useState } from "react";
import { apiFetch, AuthUser, BillingResponse, formatDate, inviteLink, Machine } from "./api";
import { CommandBlock } from "./access";
import { statusLabel } from "./billing";

type Organization = {
  id: string;
  name: string;
  slug?: string;
};

type OrgMember = {
  id: string;
  userId: string;
  role: string;
  user?: { email?: string; name?: string };
};

type Invitation = {
  id: string;
  email: string;
  role?: string;
  status?: string;
  expiresAt?: string;
};

type OrgMachine = Machine & {
  owner_email?: string;
  owner_name?: string;
};

type OrgMachinesResponse = {
  machines: OrgMachine[];
  role?: string;
};

const memberRoles = ["member", "admin", "owner"] as const;

export function TeamView({ token, user, activeTeamId, onShowBilling }: {
  token: string;
  user?: AuthUser;
  activeTeamId?: string;
  onShowBilling: (teamRef?: string) => void;
}) {
  const [orgId, setOrgId] = useState("");
  const queryClient = useQueryClient();
  const orgs = useQuery({
    queryKey: ["orgs", token],
    queryFn: () => apiFetch<Organization[]>("/v1/auth/organization/list", token),
  });
  const setActive = useMutation({
    mutationFn: (organizationId: string) => apiFetch("/v1/auth/organization/set-active", token, {
      method: "POST",
      body: { organizationId },
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["session", token] }),
  });
  const orgList = orgs.data || [];
  const activeOrg = orgList.find((org) => org.id === orgId) || orgList.find((org) => org.id === activeTeamId) || orgList[0];

  function selectOrg(id: string) {
    if (!id || id === activeTeamId) {
      setOrgId(id);
      return;
    }
    // Switch the view only once the session's active team actually changed,
    // so the dropdown never disagrees with where new boxes land.
    setActive.mutate(id, { onSuccess: () => setOrgId(id) });
  }

  if (orgs.isLoading) {
    return (
      <section className="narrow-layout">
        <div className="auth-panel"><p className="hint">Loading teams</p></div>
      </section>
    );
  }
  if (orgs.error) {
    return (
      <section className="narrow-layout">
        <div className="auth-panel"><p className="error">{(orgs.error as Error).message}</p></div>
      </section>
    );
  }
  if (!activeOrg) {
    return <CreateTeamPanel token={token} />;
  }
  return (
    <TeamDetail
      key={activeOrg.id}
      token={token}
      user={user}
      org={activeOrg}
      orgList={orgList}
      activeTeamId={activeTeamId}
      onSelectOrg={selectOrg}
      onShowBilling={onShowBilling}
      switchError={setActive.error ? (setActive.error as Error).message : ""}
    />
  );
}

function useCreateTeam(token: string, onCreated: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiFetch<Organization>("/v1/auth/organization/create", token, {
      method: "POST",
      body: { name, slug: teamSlug(name) },
    }),
    onSuccess: () => {
      onCreated();
      void queryClient.invalidateQueries({ queryKey: ["orgs", token] });
      // Creating a team makes it the session's active team (Better Auth
      // behavior), so the whoami snapshot must refresh too.
      void queryClient.invalidateQueries({ queryKey: ["session", token] });
    },
  });
}

function CreateTeamPanel({ token }: { token: string }) {
  const [name, setName] = useState("");
  const create = useCreateTeam(token, () => setName(""));

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate(name);
  }

  return (
    <section className="narrow-layout">
      <form className="auth-panel" onSubmit={submit}>
        <div className="panel-heading">
          <span>teams</span>
          <h1>Start a team</h1>
          <p>You are not part of a team yet. Create one to share boxes and invite teammates.</p>
        </div>
        <label>
          Team name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="The Treehouse" required />
        </label>
        <button className="primary-button" type="submit" disabled={create.isPending || !teamSlug(name)}>
          <Plus size={16} />
          {create.isPending ? "Creating" : "Create team"}
        </button>
        {create.error ? <p className="error">{(create.error as Error).message}</p> : null}
      </form>
    </section>
  );
}

function TeamDetail({ token, user, org, orgList, activeTeamId, onSelectOrg, onShowBilling, switchError }: {
  token: string;
  user?: AuthUser;
  org: Organization;
  orgList: Organization[];
  activeTeamId?: string;
  onSelectOrg: (id: string) => void;
  onShowBilling: (teamRef?: string) => void;
  switchError: string;
}) {
  const queryClient = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("member");
  const [lastInvitation, setLastInvitation] = useState<Invitation | null>(null);
  const members = useQuery({
    queryKey: ["org-members", org.id, token],
    queryFn: async () => {
      const raw = await apiFetch<{ members?: OrgMember[] } | OrgMember[]>(
        `/v1/auth/organization/list-members?organizationId=${encodeURIComponent(org.id)}&limit=500`,
        token,
      );
      return Array.isArray(raw) ? raw : raw.members || [];
    },
  });
  const invitations = useQuery({
    queryKey: ["org-invitations", org.id, token],
    queryFn: () => apiFetch<Invitation[]>(`/v1/auth/organization/list-invitations?organizationId=${encodeURIComponent(org.id)}`, token),
  });
  const orgMachines = useQuery({
    queryKey: ["org-machines", org.id, token],
    queryFn: () => apiFetch<OrgMachinesResponse>(`/v1/orgs/${encodeURIComponent(org.id)}/machines`, token),
    refetchInterval: 30000,
  });
  const invite = useMutation({
    mutationFn: () => apiFetch<Invitation>("/v1/auth/organization/invite-member", token, {
      method: "POST",
      body: { email: inviteEmail, role: inviteRole, organizationId: org.id },
    }),
    onSuccess: (invitation) => {
      setInviteEmail("");
      setLastInvitation(invitation);
      void queryClient.invalidateQueries({ queryKey: ["org-invitations", org.id, token] });
    },
  });
  const cancelInvitation = useMutation({
    mutationFn: (invitationId: string) => apiFetch("/v1/auth/organization/cancel-invitation", token, {
      method: "POST",
      body: { invitationId },
    }),
    onSuccess: (_data, invitationId) => {
      if (lastInvitation?.id === invitationId) setLastInvitation(null);
      void queryClient.invalidateQueries({ queryKey: ["org-invitations", org.id, token] });
    },
  });
  const updateRole = useMutation({
    mutationFn: (input: { memberId: string; role: string }) => apiFetch("/v1/auth/organization/update-member-role", token, {
      method: "POST",
      body: { memberId: input.memberId, role: input.role, organizationId: org.id },
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["org-members", org.id, token] }),
  });
  const removeMember = useMutation({
    mutationFn: (memberId: string) => apiFetch("/v1/auth/organization/remove-member", token, {
      method: "POST",
      body: { memberIdOrEmail: memberId, organizationId: org.id },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["org-members", org.id, token] });
      void queryClient.invalidateQueries({ queryKey: ["org-machines", org.id, token] });
    },
  });
  const leave = useMutation({
    mutationFn: () => apiFetch("/v1/auth/organization/leave", token, {
      method: "POST",
      body: { organizationId: org.id },
    }),
    onSuccess: () => {
      onSelectOrg("");
      void queryClient.invalidateQueries({ queryKey: ["orgs", token] });
      void queryClient.invalidateQueries({ queryKey: ["session", token] });
    },
  });
  const destroyMachine = useMutation({
    mutationFn: (machine: OrgMachine) => apiFetch(
      `/v1/orgs/${encodeURIComponent(org.id)}/machines/${encodeURIComponent(machine.user_id || "")}/${encodeURIComponent(machine.name)}`,
      token,
      { method: "DELETE" },
    ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["org-machines", org.id, token] }),
  });

  const memberList = members.data || [];
  const callerRole = memberList.find((member) => member.userId === user?.id)?.role || orgMachines.data?.role || "member";
  // Better Auth stores multiple roles as a comma-separated string.
  const callerRoles = callerRole.split(",").map((role) => role.trim());
  const canManage = callerRoles.includes("owner") || callerRoles.includes("admin");
  const pendingInvitations = (invitations.data || []).filter((invitation) => invitation.status === "pending");
  const machineList = orgMachines.data?.machines || [];

  function submitInvite(event: FormEvent) {
    event.preventDefault();
    invite.mutate();
  }

  return (
    <section className="dashboard two-col">
      <aside className="rail rail-grid">
        <div className="panel-heading small">
          <span>team / {callerRole}</span>
          <h2>{org.name}</h2>
        </div>
        {orgList.length > 1 ? (
          <label>
            Team
            <select value={org.id} onChange={(event) => onSelectOrg(event.target.value)}>
              {orgList.map((option) => (
                <option value={option.id} key={option.id}>{option.name}{option.id === activeTeamId ? " (active)" : ""}</option>
              ))}
            </select>
          </label>
        ) : null}
        {switchError ? <p className="error">{switchError}</p> : null}
        <TeamBillingHint token={token} org={org} onShowBilling={onShowBilling} />
        <form className="create-form" onSubmit={submitInvite}>
          <div className="panel-heading small">
            <span>invite</span>
            <h2>Add a teammate</h2>
          </div>
          <label>
            Email
            <input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} type="email" placeholder="friend@example.com" required />
          </label>
          <label>
            Role
            <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>
              {memberRoles.map((role) => (
                <option value={role} key={role}>{role}</option>
              ))}
            </select>
          </label>
          <button className="primary-button" type="submit" disabled={invite.isPending}>
            <Send size={16} />
            {invite.isPending ? "Inviting" : "Invite"}
          </button>
          {invite.error ? <p className="error">{(invite.error as Error).message}</p> : null}
        </form>
        {lastInvitation ? (
          <div className="invite-result">
            <CommandBlock label="Invite" value={inviteLink(lastInvitation.id)} />
            <p className="hint">Share this link with <strong>{lastInvitation.email}</strong> — it only works for that email.</p>
          </div>
        ) : null}
        <NewTeamForm token={token} />
        {!callerRoles.includes("owner") ? (
          <button
            className="danger-button"
            type="button"
            disabled={leave.isPending}
            onClick={() => {
              if (window.confirm(`Leave ${org.name}?`)) leave.mutate();
            }}
          >
            <LogOut size={16} />
            Leave team
          </button>
        ) : null}
        {leave.error ? <p className="error">{(leave.error as Error).message}</p> : null}
      </aside>

      <div className="panel-stack">
        <div className="panel">
          <div className="panel-heading small">
            <span>members</span>
            <h2>Team members</h2>
          </div>
          {members.error ? <p className="error">{(members.error as Error).message}</p> : null}
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {memberList.map((member) => (
                <tr key={member.id}>
                  <td>{member.user?.email || "-"}</td>
                  <td>{member.user?.name || "-"}</td>
                  <td>
                    <select
                      value={member.role}
                      disabled={!canManage || updateRole.isPending}
                      onChange={(event) => updateRole.mutate({ memberId: member.id, role: event.target.value })}
                    >
                      {memberRoles.map((role) => (
                        <option value={role} key={role}>{role}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button
                      className="danger-button"
                      type="button"
                      disabled={!canManage || removeMember.isPending}
                      onClick={() => {
                        if (window.confirm(`Remove ${member.user?.email || "this member"} from ${org.name}?`)) removeMember.mutate(member.id);
                      }}
                    >
                      <Trash2 size={14} />
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!memberList.length ? (
            <div className="empty">
              <Users size={20} />
              <span>{members.isLoading ? "Loading members" : "No members yet."}</span>
            </div>
          ) : null}
          {updateRole.error ? <p className="error">{(updateRole.error as Error).message}</p> : null}
          {removeMember.error ? <p className="error">{(removeMember.error as Error).message}</p> : null}
        </div>

        {pendingInvitations.length ? (
          <div className="panel">
            <div className="panel-heading small">
              <span>pending</span>
              <h2>Invitations</h2>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Expires</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {pendingInvitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <td>{invitation.email}</td>
                    <td>{invitation.role || "member"}</td>
                    <td>{formatDate(invitation.expiresAt)}</td>
                    <td>
                      <div className="table-actions">
                        <button
                          className="icon-button"
                          type="button"
                          title="Copy invite link"
                          aria-label={`Copy invite link for ${invitation.email}`}
                          onClick={() => void navigator.clipboard.writeText(inviteLink(invitation.id))}
                        >
                          <Copy size={15} />
                        </button>
                        <button
                          className="danger-button"
                          type="button"
                          disabled={cancelInvitation.isPending}
                          onClick={() => cancelInvitation.mutate(invitation.id)}
                        >
                          <XCircle size={14} />
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cancelInvitation.error ? <p className="error">{(cancelInvitation.error as Error).message}</p> : null}
          </div>
        ) : null}

        <div className="panel">
          <div className="panel-heading small">
            <span>team boxes</span>
            <h2>This team's rooms</h2>
          </div>
          <p className="hint">
            Boxes created while <strong>{org.name}</strong> is your active team land here. <code>bh create --team {org.slug || org.name}</code> targets it explicitly.
          </p>
          {orgMachines.error ? <p className="error">{(orgMachines.error as Error).message}</p> : null}
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Owner</th>
                <th>Provider</th>
                <th>Size</th>
                <th>Preview</th>
                {canManage ? <th aria-label="Actions" /> : null}
              </tr>
            </thead>
            <tbody>
              {machineList.map((machine) => (
                <tr key={`${machine.user_id || "user"}/${machine.name}`}>
                  <td>{machine.name}</td>
                  <td>{machine.owner_email || "-"}</td>
                  <td>{machine.provider_label || machine.provider || "-"}</td>
                  <td>{machine.size || "-"}</td>
                  <td>
                    {machine.preview_url ? (
                      <a href={machine.preview_url} target="_blank" rel="noreferrer">preview</a>
                    ) : "-"}
                  </td>
                  {canManage ? (
                    <td>
                      <button
                        className="danger-button"
                        type="button"
                        disabled={destroyMachine.isPending}
                        onClick={() => {
                          if (window.confirm(`Destroy ${machine.name} (${machine.owner_email || "unknown owner"})?`)) destroyMachine.mutate(machine);
                        }}
                      >
                        <Trash2 size={14} />
                        Destroy
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {!machineList.length ? (
            <div className="empty">
              <Server size={20} />
              <span>{orgMachines.isLoading ? "Loading boxes" : "No boxes in this team yet."}</span>
            </div>
          ) : null}
          {destroyMachine.error ? <p className="error">{(destroyMachine.error as Error).message}</p> : null}
        </div>
      </div>
    </section>
  );
}

function NewTeamForm({ token }: { token: string }) {
  const [name, setName] = useState("");
  const create = useCreateTeam(token, () => setName(""));

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate(name);
  }

  return (
    <form className="create-form" onSubmit={submit}>
      <div className="panel-heading small">
        <span>teams</span>
        <h2>New team</h2>
      </div>
      <label>
        Team name
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="The Treehouse" required />
      </label>
      <button className="primary-button" type="submit" disabled={create.isPending || !teamSlug(name)}>
        <Plus size={16} />
        {create.isPending ? "Creating" : "Create team"}
      </button>
      {create.error ? <p className="error">{(create.error as Error).message}</p> : null}
    </form>
  );
}

// Small billing status line so owners/admins discover team billing from here.
// Hidden while loading, on error, or when billing is disabled on the backend.
function TeamBillingHint({ token, org, onShowBilling }: {
  token: string;
  org: Organization;
  onShowBilling: (teamRef?: string) => void;
}) {
  const teamRef = org.slug || org.id;
  const billing = useQuery({
    queryKey: ["billing", teamRef, token],
    queryFn: () => apiFetch<BillingResponse>(`/v1/billing?team=${encodeURIComponent(teamRef)}`, token),
  });
  const info = billing.data;
  if (!info?.enabled) return null;
  return (
    <p className="hint billing-hint">
      <CreditCard size={14} />
      <span className={info.status === "past_due" ? "badge warn" : "badge"}>{statusLabel(info.status)}</span>
      <button className="link-button" type="button" onClick={() => onShowBilling(teamRef)}>Open Billing</button>
    </p>
  );
}

function teamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
