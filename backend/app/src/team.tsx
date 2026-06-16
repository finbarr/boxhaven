import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, Send, Trash2, Users, XCircle } from "lucide-react";
import { FormEvent, useState } from "react";
import { apiFetch, AuthUser, formatDate, inviteLink } from "./api";
import { CommandBlock } from "./access";
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
    return <NoTeamPanel />;
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
  return <TeamDetail key={viewedOrg.id} token={token} user={user} org={viewedOrg} />;
}

function NoTeamPanel() {
  return (
    <section className="narrow-layout">
      <div className="auth-panel">
        <div className="panel-heading">
          <span>teams</span>
          <h1>No team selected</h1>
          <p>Create a team before managing members.</p>
        </div>
        <Link className="primary-button" to="/teams">
          <Users size={16} />
          Open teams
        </Link>
      </div>
    </section>
  );
}

function TeamDetail({ token, user, org }: {
  token: string;
  user?: AuthUser;
  org: Organization;
}) {
  const queryClient = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("member");
  const [lastInvitation, setLastInvitation] = useState<Invitation | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
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
  const memberList = members.data || [];
  const callerRole = memberList.find((member) => member.userId === user?.id)?.role || "member";
  // Better Auth stores multiple roles as a comma-separated string.
  const callerRoles = callerRole.split(",").map((role) => role.trim());
  const canManage = callerRoles.includes("owner") || callerRoles.includes("admin");
  const pendingInvitations = (invitations.data || []).filter((invitation) => invitation.status === "pending");
  const onlyMember = memberList.length === 1;

  function submitInvite(event: FormEvent) {
    event.preventDefault();
    invite.mutate();
  }

  return (
    <>
      <WorkspaceHead
        eyebrow={`team / ${org.name}`}
        title="Members"
        actions={canManage ? (
          <button className="primary-button" type="button" onClick={() => { setLastInvitation(null); setInviteOpen(true); }}>
            <Send size={16} />
            Invite
          </button>
        ) : null}
      />

      <div className="workspace-body">
        <div className="panel table-panel">
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
                    <td className="cell-actions">
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
                          onClick={() => {
                            if (window.confirm(`Cancel invitation for ${invitation.email}?`)) cancelInvitation.mutate(invitation.id);
                          }}
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
            <p className="hint">Share this link with <strong>{lastInvitation.email}</strong> - it only works for that email.</p>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
