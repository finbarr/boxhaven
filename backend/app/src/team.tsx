import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Copy, CreditCard, LogOut, Plus, Save, Send, Trash2, Users, XCircle } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { apiFetch, AuthUser, BillingResponse, formatDate, inviteLink, TeamInfo } from "./api";
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

const memberRoles = ["member", "admin", "owner"] as const;

// teamRef is the /team/$team path param (slug or id). Without it, the
// session's active team from the shared console switcher is shown.
export function TeamView({ teamRef }: { teamRef?: string }) {
  const { token, user, teams, activeTeam } = useConsole();
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
      teamInfo={teams.find((team) => team.id === viewedOrg.id)}
    />
  );
}

function useCreateTeam(token: string, onCreated: (organization: Organization) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiFetch<Organization>("/v1/auth/organization/create", token, {
      method: "POST",
      body: { name, slug: teamSlug(name) },
    }),
    onSuccess: (organization) => {
      onCreated(organization);
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

function TeamDetail({ token, user, org, teamInfo }: {
  token: string;
  user?: AuthUser;
  org: Organization;
  teamInfo?: TeamInfo;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [teamName, setTeamName] = useState(org.name);
  const [teamSlugValue, setTeamSlugValue] = useState(org.slug || teamSlug(org.name));
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
  useEffect(() => {
    setTeamName(org.name);
    setTeamSlugValue(org.slug || teamSlug(org.name));
  }, [org.id, org.name, org.slug]);
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
    },
  });
  const updateTeam = useMutation({
    mutationFn: () => apiFetch<Organization>("/v1/auth/organization/update", token, {
      method: "POST",
      body: { organizationId: org.id, data: { name: teamName.trim(), slug: teamSlug(teamSlugValue) } },
    }),
    onSuccess: (organization) => {
      void queryClient.invalidateQueries({ queryKey: ["orgs", token] });
      void queryClient.invalidateQueries({ queryKey: ["session", token] });
      void navigate({ to: "/team/$team", params: { team: organization.slug || organization.id } });
    },
  });
  const deleteTeam = useMutation({
    mutationFn: () => apiFetch("/v1/auth/organization/delete", token, {
      method: "POST",
      body: { organizationId: org.id },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orgs", token] });
      void queryClient.invalidateQueries({ queryKey: ["session", token] });
      void navigate({ to: "/team" });
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
  const memberList = members.data || [];
  const callerRole = memberList.find((member) => member.userId === user?.id)?.role || "member";
  // Better Auth stores multiple roles as a comma-separated string.
  const callerRoles = callerRole.split(",").map((role) => role.trim());
  const canManage = callerRoles.includes("owner") || callerRoles.includes("admin");
  const isOwner = callerRoles.includes("owner");
  const pendingInvitations = (invitations.data || []).filter((invitation) => invitation.status === "pending");
  const onlyMember = memberList.length === 1;
  const isPersonalTeam = Boolean(teamInfo?.personal);
  const canDeleteTeam = isOwner && !isPersonalTeam;
  const teamFormDirty = teamName !== org.name || teamSlug(teamSlugValue) !== (org.slug || teamSlug(org.name));

  function submitInvite(event: FormEvent) {
    event.preventDefault();
    invite.mutate();
  }

  function submitTeam(event: FormEvent) {
    event.preventDefault();
    updateTeam.mutate();
  }

  return (
    <>
      <WorkspaceHead
        eyebrow={`team / ${callerRole}`}
        title="Members"
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
        <div className="panel team-settings">
          <div className="panel-heading small">
            <span>team</span>
            <h2>{org.name}</h2>
          </div>
          <form className="team-settings-form" onSubmit={submitTeam}>
            <label>
              Team name
              <input value={teamName} onChange={(event) => setTeamName(event.target.value)} required disabled={!canManage} />
            </label>
            <label>
              Team slug
              <input value={teamSlugValue} onChange={(event) => setTeamSlugValue(teamSlug(event.target.value))} required disabled={!canManage} />
            </label>
            {canManage ? (
              <button className="primary-button" type="submit" disabled={updateTeam.isPending || !teamName.trim() || !teamSlug(teamSlugValue) || !teamFormDirty}>
                <Save size={16} />
                {updateTeam.isPending ? "Saving" : "Save team"}
              </button>
            ) : null}
          </form>
          {updateTeam.error ? <p className="error">{(updateTeam.error as Error).message}</p> : null}
          <div className="team-settings-actions">
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
                {leave.isPending ? "Leaving" : "Leave team"}
              </button>
            ) : (
              <button
                className="danger-button"
                type="button"
                disabled={!canDeleteTeam || deleteTeam.isPending}
                title={isPersonalTeam ? "Personal teams cannot be deleted" : !isOwner ? "Only owners can delete teams" : undefined}
                onClick={() => {
                  if (window.confirm(`Delete ${org.name}? Team boxes move back to their owners' active teams the next time they list boxes.`)) deleteTeam.mutate();
                }}
              >
                <Trash2 size={16} />
                {deleteTeam.isPending ? "Deleting" : "Delete team"}
              </button>
            )}
            {leave.error ? <p className="error">{(leave.error as Error).message}</p> : null}
            {deleteTeam.error ? <p className="error">{(deleteTeam.error as Error).message}</p> : null}
          </div>
        </div>

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
        <NewTeamForm token={token} onCreated={(organization) => {
          setNewTeamOpen(false);
          void navigate({ to: "/team/$team", params: { team: organization.slug || organization.id } });
        }} />
      </Drawer>
    </>
  );
}

function NewTeamForm({ token, onCreated }: { token: string; onCreated?: (organization: Organization) => void }) {
  const [name, setName] = useState("");
  const create = useCreateTeam(token, (organization) => {
    setName("");
    onCreated?.(organization);
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
