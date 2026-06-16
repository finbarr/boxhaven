import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, LogOut, Plus, Save, Trash2, Users } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { apiFetch, AuthUser } from "./api";
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

type TeamRowInfo = {
  org: Organization;
  members: OrgMember[];
  role: string;
  loading: boolean;
};

export function TeamsView() {
  const { token, user } = useConsole();
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [selectedTeamID, setSelectedTeamID] = useState("");
  const orgs = useQuery({
    queryKey: ["orgs", token],
    queryFn: () => apiFetch<Organization[]>("/v1/auth/organization/list", token),
  });
  const orgList = orgs.data || [];
  const selectedOrg = orgList.find((org) => org.id === selectedTeamID);

  useEffect(() => {
    if (selectedTeamID && !selectedOrg) setSelectedTeamID("");
  }, [selectedOrg, selectedTeamID]);

  return (
    <>
      <WorkspaceHead
        eyebrow="global"
        title="Teams"
        actions={(
          <button className="primary-button" type="button" onClick={() => setNewTeamOpen(true)}>
            <Plus size={16} />
            New team
          </button>
        )}
      />

      <div className="workspace-body">
        <div className="panel table-panel">
          {orgs.error ? <p className="error panel-error">{(orgs.error as Error).message}</p> : null}
          <table className="data-table rows-clickable teams-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Members</th>
                <th>Your role</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {orgList.map((org) => (
                <TeamTableRow
                  key={org.id}
                  token={token}
                  user={user}
                  org={org}
                  selected={org.id === selectedTeamID}
                  onOpen={() => setSelectedTeamID(org.id)}
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

      <TeamSettingsDrawer
        key={selectedOrg?.id || "closed"}
        open={Boolean(selectedOrg)}
        token={token}
        user={user}
        org={selectedOrg}
        onClose={() => setSelectedTeamID("")}
      />

      <Drawer open={newTeamOpen} onClose={() => setNewTeamOpen(false)} eyebrow="teams" title="New team">
        <NewTeamForm token={token} onCreated={() => setNewTeamOpen(false)} />
      </Drawer>
    </>
  );
}

function TeamTableRow({ token, user, org, selected, onOpen }: {
  token: string;
  user?: AuthUser;
  org: Organization;
  selected: boolean;
  onOpen: () => void;
}) {
  const info = useTeamRowInfo(token, user, org);
  return (
    <tr className={selected ? "selected" : undefined} onClick={onOpen}>
      <td><strong>{org.name}</strong></td>
      <td>{org.slug || "-"}</td>
      <td>{info.loading ? "Loading" : info.members.length}</td>
      <td>{info.loading ? "Loading" : info.role}</td>
      <td className="cell-chevron"><ChevronRight size={16} /></td>
    </tr>
  );
}

function TeamSettingsDrawer({ open, token, user, org, onClose }: {
  open: boolean;
  token: string;
  user?: AuthUser;
  org?: Organization;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [teamName, setTeamName] = useState(org?.name || "");
  const [teamSlugValue, setTeamSlugValue] = useState(org?.slug || (org ? teamSlug(org.name) : ""));
  const info = useTeamRowInfo(token, user, org);
  const callerRoles = info.role.split(",").map((role) => role.trim());
  const canManage = callerRoles.includes("owner") || callerRoles.includes("admin");
  const isOwner = callerRoles.includes("owner");
  const currentSlug = org?.slug || (org ? teamSlug(org.name) : "");
  const nextSlug = teamSlug(teamSlugValue);
  const teamFormDirty = Boolean(org) && (teamName !== org.name || nextSlug !== currentSlug);

  useEffect(() => {
    setTeamName(org?.name || "");
    setTeamSlugValue(org?.slug || (org ? teamSlug(org.name) : ""));
  }, [org]);

  const updateTeam = useMutation({
    mutationFn: () => apiFetch<Organization>("/v1/auth/organization/update", token, {
      method: "POST",
      body: { organizationId: org?.id, data: { name: teamName.trim(), slug: nextSlug } },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orgs", token] });
      void queryClient.invalidateQueries({ queryKey: ["session", token] });
    },
  });
  const deleteTeam = useMutation({
    mutationFn: () => apiFetch("/v1/auth/organization/delete", token, {
      method: "POST",
      body: { organizationId: org?.id },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orgs", token] });
      void queryClient.invalidateQueries({ queryKey: ["session", token] });
      onClose();
    },
  });
  const leaveTeam = useMutation({
    mutationFn: () => apiFetch("/v1/auth/organization/leave", token, {
      method: "POST",
      body: { organizationId: org?.id },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orgs", token] });
      void queryClient.invalidateQueries({ queryKey: ["session", token] });
      onClose();
    },
  });
  const busy = updateTeam.isPending || deleteTeam.isPending || leaveTeam.isPending;
  const error = updateTeam.error || deleteTeam.error || leaveTeam.error;

  function submit(event: FormEvent) {
    event.preventDefault();
    updateTeam.mutate();
  }

  return (
    <Drawer
      wide
      open={open}
      onClose={onClose}
      eyebrow="team"
      title={org?.name || "Team"}
      footer={org ? (
        isOwner ? (
          <button
            className="danger-button"
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete ${org.name}?`)) deleteTeam.mutate();
            }}
          >
            <Trash2 size={16} />
            {deleteTeam.isPending ? "Deleting" : "Delete team"}
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
            <LogOut size={16} />
            {leaveTeam.isPending ? "Leaving" : "Leave team"}
          </button>
        )
      ) : null}
    >
      {org ? (
        <>
          <div className="metrics">
            <Metric label="Members" value={info.loading ? "Loading" : String(info.members.length)} />
            <Metric label="Your role" value={info.loading ? "Loading" : info.role} />
          </div>
          <form className="create-form" onSubmit={submit}>
            <label>
              Team name
              <input value={teamName} onChange={(event) => setTeamName(event.target.value)} required disabled={!canManage || busy} />
            </label>
            <label>
              Team slug
              <input value={teamSlugValue} onChange={(event) => setTeamSlugValue(teamSlug(event.target.value))} required disabled={!canManage || busy} />
            </label>
            {canManage ? (
              <button className="primary-button" type="submit" disabled={busy || !teamName.trim() || !nextSlug || !teamFormDirty}>
                <Save size={16} />
                {updateTeam.isPending ? "Saving" : "Save team"}
              </button>
            ) : null}
            {error ? <p className="error">{(error as Error).message}</p> : null}
          </form>
        </>
      ) : (
        <div className="empty"><Users size={22} /><span>Select a team</span></div>
      )}
    </Drawer>
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

function useTeamRowInfo(token: string, user: AuthUser | undefined, org: Organization | undefined): TeamRowInfo {
  const members = useQuery({
    queryKey: ["org-members", org?.id, token],
    enabled: Boolean(org),
    queryFn: async () => {
      const raw = await apiFetch<{ members?: OrgMember[] } | OrgMember[]>(
        `/v1/auth/organization/list-members?organizationId=${encodeURIComponent(org?.id || "")}&limit=500`,
        token,
      );
      return Array.isArray(raw) ? raw : raw.members || [];
    },
  });
  const memberList = members.data || [];
  const role = memberList.find((member) => member.userId === user?.id)?.role || "member";
  return {
    org: org || { id: "", name: "" },
    members: memberList,
    role,
    loading: members.isLoading,
  };
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric" title={value}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function teamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
