import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Plus, Save, Trash2, Users } from "lucide-react";
import { FormEvent, Fragment, useEffect, useState } from "react";
import { apiFetch, AuthUser, TeamInfo } from "./api";
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

export function TeamsView() {
  const { token, user, teams } = useConsole();
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const orgs = useQuery({
    queryKey: ["orgs", token],
    queryFn: () => apiFetch<Organization[]>("/v1/auth/organization/list", token),
  });
  const orgList = orgs.data || [];

  return (
    <>
      <WorkspaceHead
        eyebrow="global / settings"
        title="Teams"
        actions={(
          <button className="primary-button" type="button" onClick={() => setNewTeamOpen(true)}>
            <Plus size={16} />
            New team
          </button>
        )}
      />

      <div className="workspace-body">
        <div className="panel table-panel teams-table-panel">
          <div className="panel-heading small">
            <span>teams</span>
            <h2>Team settings</h2>
          </div>
          {orgs.error ? <p className="error panel-error">{(orgs.error as Error).message}</p> : null}
          <table className="data-table teams-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Members</th>
                <th>Your role</th>
                <th>Type</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {orgList.map((org) => (
                <TeamSettingsRow
                  key={org.id}
                  token={token}
                  user={user}
                  org={org}
                  teamInfo={teams.find((team) => team.id === org.id)}
                />
              ))}
            </tbody>
          </table>
          {!orgList.length ? (
            <div className="empty">
              <Users size={20} />
              <span>{orgs.isLoading ? "Loading teams" : "No teams yet."}</span>
            </div>
          ) : null}
        </div>
      </div>

      <Drawer open={newTeamOpen} onClose={() => setNewTeamOpen(false)} eyebrow="teams" title="New team">
        <NewTeamForm token={token} onCreated={() => setNewTeamOpen(false)} />
      </Drawer>
    </>
  );
}

function TeamSettingsRow({ token, user, org, teamInfo }: {
  token: string;
  user?: AuthUser;
  org: Organization;
  teamInfo?: TeamInfo;
}) {
  const queryClient = useQueryClient();
  const [teamName, setTeamName] = useState(org.name);
  const [teamSlugValue, setTeamSlugValue] = useState(org.slug || teamSlug(org.name));
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
  useEffect(() => {
    setTeamName(org.name);
    setTeamSlugValue(org.slug || teamSlug(org.name));
  }, [org.id, org.name, org.slug]);

  const updateTeam = useMutation({
    mutationFn: () => apiFetch<Organization>("/v1/auth/organization/update", token, {
      method: "POST",
      body: { organizationId: org.id, data: { name: teamName.trim(), slug: teamSlug(teamSlugValue) } },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orgs", token] });
      void queryClient.invalidateQueries({ queryKey: ["session", token] });
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
    },
  });
  const leaveTeam = useMutation({
    mutationFn: () => apiFetch("/v1/auth/organization/leave", token, {
      method: "POST",
      body: { organizationId: org.id },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orgs", token] });
      void queryClient.invalidateQueries({ queryKey: ["session", token] });
    },
  });

  const memberList = members.data || [];
  const callerRole = memberList.find((member) => member.userId === user?.id)?.role || "member";
  // Better Auth stores multiple roles as a comma-separated string.
  const callerRoles = callerRole.split(",").map((role) => role.trim());
  const canManage = callerRoles.includes("owner") || callerRoles.includes("admin");
  const isOwner = callerRoles.includes("owner");
  const isPersonalTeam = Boolean(teamInfo?.personal);
  const currentSlug = org.slug || teamSlug(org.name);
  const nextSlug = teamSlug(teamSlugValue);
  const teamFormDirty = teamName !== org.name || nextSlug !== currentSlug;
  const busy = updateTeam.isPending || deleteTeam.isPending || leaveTeam.isPending;
  const rowError = updateTeam.error || deleteTeam.error || leaveTeam.error;

  return (
    <Fragment>
      <tr>
        <td>
          <input
            aria-label={`Team name for ${org.name}`}
            value={teamName}
            onChange={(event) => setTeamName(event.target.value)}
            disabled={!canManage || busy}
            required
          />
        </td>
        <td>
          <input
            aria-label={`Team slug for ${org.name}`}
            value={teamSlugValue}
            onChange={(event) => setTeamSlugValue(teamSlug(event.target.value))}
            disabled={!canManage || busy}
            required
          />
        </td>
        <td>{members.isLoading ? "Loading" : memberList.length}</td>
        <td>{members.isLoading ? "Loading" : callerRole}</td>
        <td>{isPersonalTeam ? "Personal" : "Shared"}</td>
        <td>
          <div className="table-actions">
            {canManage ? (
              <button
                className="primary-button"
                type="button"
                disabled={busy || !teamName.trim() || !nextSlug || !teamFormDirty}
                onClick={() => updateTeam.mutate()}
              >
                <Save size={14} />
                {updateTeam.isPending ? "Saving" : "Save"}
              </button>
            ) : null}
            {isOwner ? (
              <button
                className="danger-button"
                type="button"
                disabled={busy || isPersonalTeam}
                title={isPersonalTeam ? "Personal teams cannot be deleted" : undefined}
                onClick={() => {
                  if (window.confirm(`Delete ${org.name}?`)) deleteTeam.mutate();
                }}
              >
                <Trash2 size={14} />
                {deleteTeam.isPending ? "Deleting" : "Delete"}
              </button>
            ) : (
              <button
                className="danger-button"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Leave ${org.name}?`)) leaveTeam.mutate();
                }}
              >
                <LogOut size={14} />
                {leaveTeam.isPending ? "Leaving" : "Leave"}
              </button>
            )}
          </div>
        </td>
      </tr>
      {rowError ? (
        <tr>
          <td colSpan={6}>
            <p className="error panel-error">{(rowError as Error).message}</p>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function NewTeamForm({ token, onCreated }: { token: string; onCreated?: (organization: Organization) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const create = useCreateTeam(token, (organization) => {
    setName("");
    setSlug("");
    setSlugTouched(false);
    onCreated?.(organization);
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ name: name.trim(), slug: teamSlug(slug) });
  }

  return (
    <form className="create-form" onSubmit={submit}>
      <label>
        Team name
        <input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (!slugTouched) setSlug(teamSlug(event.target.value));
          }}
          placeholder="The Treehouse"
          required
        />
      </label>
      <label>
        Team slug
        <input
          value={slug}
          onChange={(event) => {
            setSlugTouched(true);
            setSlug(teamSlug(event.target.value));
          }}
          placeholder="the-treehouse"
          required
        />
      </label>
      <button className="primary-button" type="submit" disabled={create.isPending || !name.trim() || !teamSlug(slug)}>
        <Plus size={16} />
        {create.isPending ? "Creating" : "Create team"}
      </button>
      {create.error ? <p className="error">{(create.error as Error).message}</p> : null}
    </form>
  );
}

function useCreateTeam(token: string, onCreated: (organization: Organization) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; slug: string }) => apiFetch<Organization>("/v1/auth/organization/create", token, {
      method: "POST",
      body: input,
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

function teamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
