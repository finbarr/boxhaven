import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Copy, CreditCard, LogOut, Plus, Send, Server, Trash2, Users, XCircle } from "lucide-react";
import { FormEvent, useState } from "react";
import { apiFetch, AuthUser, BillingResponse, formatDate, inviteLink, Machine } from "./api";
import { CommandBlock } from "./access";
import { statusLabel } from "./billing";
import { useConsole } from "./console-context";
import { Drawer } from "./drawer";
import { WorkspaceHead } from "./shell";

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

// teamRef is the /team/$team path param (slug or id). Without it, the
// session's active team from the shared console switcher is shown.
export function TeamView({ teamRef }: { teamRef?: string }) {
  const { token, user, activeTeam } = useConsole();
  const activeTeamId = activeTeam?.id;
  const orgs = useQuery({
    queryKey: ["orgs", token],
    queryFn: () => apiFetch<Organization[]>("/v1/auth/organization/list", token),
  });
  const orgList = orgs.data || [];
  const viewedOrg = teamRef
    ? orgList.find((org) => org.slug === teamRef || org.id === teamRef)
    : orgList.find((org) => org.id === activeTeamId) || orgList[0];

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
  if (!orgList.length) {
    return <CreateTeamPanel token={token} />;
  }
  if (!viewedOrg) {
    return (
      <section className="narrow-layout">
        <div className="auth-panel">
          <div className="panel-heading">
            <span>teams</span>
            <h1>Team not found</h1>
            <p>You are not a member of a team called <strong>{teamRef}</strong>.</p>
          </div>
          <Link className="primary-button" to="/team">
            <Users size={16} />
            Back to your team
          </Link>
        </div>
      </section>
    );
  }
  return (
    <TeamDetail
      key={viewedOrg.id}
      token={token}
      user={user}
      org={viewedOrg}
      activeTeamId={activeTeamId}
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

function TeamDetail({ token, user, org, activeTeamId }: {
  token: string;
  user?: AuthUser;
  org: Organization;
  activeTeamId?: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("member");
  const [lastInvitation, setLastInvitation] = useState<Invitation | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [newTeamOpen, setNewTeamOpen] = useState(false);
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
      void queryClient.invalidateQueries({ queryKey: ["orgs", token] });
      void queryClient.invalidateQueries({ queryKey: ["session", token] });
      void navigate({ to: "/team" });
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
  const onlyMember = memberList.length === 1;
  const orgIsActive = org.id === activeTeamId;

  function submitInvite(event: FormEvent) {
    event.preventDefault();
    invite.mutate();
  }

  return (
    <>
      <WorkspaceHead
        eyebrow={`team / ${callerRole}`}
        title={org.name}
        actions={(
          <>
            <button className="secondary-button" type="button" onClick={() => setNewTeamOpen(true)}>
              <Plus size={16} />
              New team
            </button>
            {canManage ? (
              <button className="primary-button" type="button" onClick={() => { setLastInvitation(null); setInviteOpen(true); }}>
                <Send size={16} />
                Invite
              </button>
            ) : null}
          </>
        )}
      />

      <div className="workspace-body">
        <TeamBillingHint token={token} org={org} />

        <div className="panel table-panel">
          <div className="panel-heading small">
            <span>members</span>
            <h2>Team members</h2>
          </div>
          {members.error ? <p className="error panel-error">{(members.error as Error).message}</p> : null}
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
              {memberList.map((member) => {
                const isSelf = member.userId === user?.id;
                const selfOnlyMember = onlyMember && isSelf;
                const roleDisabled = !canManage || updateRole.isPending || selfOnlyMember;
                const removeDisabled = !canManage || removeMember.isPending || onlyMember;
                return (
                  <tr key={member.id}>
                    <td>{member.user?.email || "-"}</td>
                    <td>{member.user?.name || "-"}</td>
                    <td>
                      <select
                        value={member.role}
                        disabled={roleDisabled}
                        title={selfOnlyMember ? "The only team member must keep their role" : undefined}
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
                        disabled={removeDisabled}
                        title={onlyMember ? "Cannot remove the only team member" : undefined}
                        onClick={() => {
                          if (window.confirm(`Remove ${member.user?.email || "this member"} from ${org.name}?`)) removeMember.mutate(member.id);
                        }}
                      >
                        <Trash2 size={14} />
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!memberList.length ? (
            <div className="empty">
              <Users size={20} />
              <span>{members.isLoading ? "Loading members" : "No members yet."}</span>
            </div>
          ) : null}
          {updateRole.error ? <p className="error panel-error">{(updateRole.error as Error).message}</p> : null}
          {removeMember.error ? <p className="error panel-error">{(removeMember.error as Error).message}</p> : null}
        </div>

        {pendingInvitations.length ? (
          <div className="panel table-panel">
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
            {cancelInvitation.error ? <p className="error panel-error">{(cancelInvitation.error as Error).message}</p> : null}
          </div>
        ) : null}

        <div className="panel table-panel">
          <div className="panel-heading small">
            <span>team boxes</span>
            <h2>This team's boxes</h2>
          </div>
          <p className="hint">
            {orgIsActive ? (
              <>
                New boxes land in <strong>{org.name}</strong>, or target it directly:{" "}
                <code>bh create work --team {org.slug || org.name}</code>
              </>
            ) : (
              <>
                This is not the active team. Switch to <strong>{org.name}</strong> in the sidebar, or target it directly:{" "}
                <code>bh create work --team {org.slug || org.name}</code>
              </>
            )}
          </p>
          {orgMachines.error ? <p className="error panel-error">{(orgMachines.error as Error).message}</p> : null}
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
          {destroyMachine.error ? <p className="error panel-error">{(destroyMachine.error as Error).message}</p> : null}
        </div>

        {!callerRoles.includes("owner") ? (
          <div className="workspace-foot">
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
            {leave.error ? <p className="error">{(leave.error as Error).message}</p> : null}
          </div>
        ) : null}
      </div>

      <Drawer open={inviteOpen} onClose={() => setInviteOpen(false)} eyebrow="invite" title="Add a teammate">
        <form className="create-form" onSubmit={submitInvite}>
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
            {invite.isPending ? "Inviting" : "Send invite"}
          </button>
          {invite.error ? <p className="error">{(invite.error as Error).message}</p> : null}
        </form>
        {lastInvitation ? (
          <div className="invite-result">
            <CommandBlock label="Invite" value={inviteLink(lastInvitation.id)} />
            <p className="hint">Share this link with <strong>{lastInvitation.email}</strong> — it only works for that email.</p>
          </div>
        ) : null}
      </Drawer>

      <Drawer open={newTeamOpen} onClose={() => setNewTeamOpen(false)} eyebrow="teams" title="New team">
        <NewTeamForm token={token} onCreated={() => setNewTeamOpen(false)} />
      </Drawer>
    </>
  );
}

function NewTeamForm({ token, onCreated }: { token: string; onCreated?: () => void }) {
  const [name, setName] = useState("");
  const create = useCreateTeam(token, () => {
    setName("");
    onCreated?.();
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate(name);
  }

  return (
    <form className="create-form" onSubmit={submit}>
      <p className="hint">Create a team to share boxes and invite teammates. It becomes your active team.</p>
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
function TeamBillingHint({ token, org }: {
  token: string;
  org: Organization;
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
      <Link className="link-button" to="/billing/$team" params={{ team: teamRef }}>Open Billing</Link>
    </p>
  );
}

function teamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
