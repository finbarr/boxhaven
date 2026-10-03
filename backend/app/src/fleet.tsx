import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { watchTeamResources } from "../../src/fleet_client";
import type { FleetResponse, ResourceOperation, ResourceResponse, ResourceSharing } from "../../src/client";
import { apiBaseURL, apiFetch, BoxHavenAPIError, formatDate } from "./api";
import { useConsole } from "./console-context";
import { WorkspaceHead } from "./shell";

function useFleet(teamID?: string) {
  const { token } = useConsole();
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ teamID?: string; snapshot?: FleetResponse; error?: string }>({});
  useEffect(() => {
    if (!teamID) return;
    const controller = new AbortController();
    void watchTeamResources(apiBaseURL, teamID, token, controller.signal, snapshot => {
      if (controller.signal.aborted) return;
      setState({ teamID, snapshot });
      void queryClient.invalidateQueries({ queryKey: ["resource", token] });
    }).catch(error => {
      if (!controller.signal.aborted) {
        setState({ teamID, error: error.message });
        queryClient.removeQueries({ queryKey: ["resource", token] });
      }
    });
    return () => controller.abort();
  }, [teamID, token, queryClient]);
  return state.teamID === teamID ? state : {};
}

export function Fleet() {
  const { activeTeam } = useConsole();
  const { snapshot, error } = useFleet(activeTeam?.id);
  return <>
    <WorkspaceHead title="Fleet" eyebrow="Shared resources across your team's providers" />
    <section className="fleet-layout">
      {error ? <p className="error">{error}</p> : !snapshot ? <p>Loading team resources…</p> : <>
        <p className="hint">{snapshot.resources.length} resources · Updates sync across your team.</p>
        {!snapshot.resources.length && <p>Create a box to add the first resource to this team's fleet.</p>}
        <div className="fleet-grid">{snapshot.resources.map(resource => <Link to="/resources/$resourceID" params={{ resourceID: resource.resource_id }} className="fleet-card" key={resource.resource_id}>
          <span className="hint">{resource.provider_label || resource.provider}</span>
          <h2>{resource.name}</h2>
          <p>{resource.create_state === "recovery_required" ? "Needs recovery" : resource.create_state ? "Provisioning" : resource.bootstrap_complete ? "Runtime installed" : "Runtime unavailable"}</p>
          <small>{[resource.region, resource.size].filter(Boolean).join(" · ") || "View resource and access"}</small>
        </Link>)}</div>
      </>}
    </section>
  </>;
}

export function ResourceDetail({ resourceID }: { resourceID: string }) {
  const { token, teams } = useConsole();
  const queryClient = useQueryClient();
  const path = `/v1/resources/${encodeURIComponent(resourceID)}`;
  const query = useQuery({ queryKey: ["resource", token, resourceID], queryFn: () => apiFetch<ResourceResponse>(path, token), retry: false });
  const data = query.data;
  const subscription = useFleet(data?.resource.team_id);
  const mayOperate = !!data && data.role !== "viewer";
  const operations = useQuery({ queryKey: ["resource", token, resourceID, "operations"], queryFn: () => apiFetch<{ operations: ResourceOperation[] }>(`${path}/operations`, token), enabled: mayOperate, retry: false });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [startKey, setStartKey] = useState(() => crypto.randomUUID());
  const start = useMutation({
    mutationFn: () => apiFetch<{ operation: ResourceOperation }>(`${path}/sessions/prepare`, token, { method: "POST", idempotencyKey: startKey, body: { command: ["codex"], attach: false } }),
    onSuccess: result => { if (result.operation.state === "completed") setStartKey(crypto.randomUUID()); void queryClient.invalidateQueries({ queryKey: ["resource", token, resourceID] }); },
    onError: error => { if (error instanceof BoxHavenAPIError && error.code === "session_exists") setStartKey(crypto.randomUUID()); },
  });
  const preview = useMutation({ mutationFn: () => apiFetch<{ url: string; authentication: string }>(`${path}/preview`, token) });
  if (query.error || subscription.error) return <section className="fleet-layout"><p className="error">{subscription.error || (query.error as Error).message}</p><Link to="/fleet">Back to fleet</Link></section>;
  if (!data) return <section className="fleet-layout"><p>Loading resource…</p></section>;
  const team = teams.find(team => team.id === data.resource.team_id);
  return <>
    <WorkspaceHead title={data.resource.name} eyebrow={`${team?.name || "Team"} · ${data.resource.provider_label || data.resource.provider} · ${data.role} access`} />
    <section className="fleet-layout">
      <Link to="/fleet">Back to fleet</Link>
      <div className="fleet-card">
        <h2>Share this resource</h2>
        <p>This link stays the same when the resource is renamed. Team membership is required.</p>
        <p className="resource-link">{data.url}</p>
        <button className="secondary-button" onClick={() => { void navigator.clipboard.writeText(data.url).then(() => setCopied(true)).catch(() => setCopyError("Copy the link above.")); }}>{copied ? "Copied" : "Copy link"}</button>
        {copyError && <p className="hint">{copyError}</p>}
      </div>
      {data.role === "manager" && <SharingEditor key={resourceID} resourceID={resourceID} teamID={data.resource.team_id!} ownerID={data.resource.owner_id!} />}
      {mayOperate ? <div className="fleet-card">
        <h2>Agent session</h2>
        <p>Start Codex in the resource's persistent session. Closing this page leaves it running.</p>
        <button className="primary-button" disabled={!data.capabilities.session_prepare || start.isPending} onClick={() => start.mutate()}>Start Codex</button>
        {!data.capabilities.session_prepare && <p className="hint">The resource runtime must be connected before starting a session.</p>}
        {start.error && <p className="error">{(start.error as Error).message}</p>}
        {operations.error && <p className="error">{(operations.error as Error).message}</p>}
        {operations.data?.operations.length ? <ul className="resource-operations">{operations.data.operations.map(operation => <li key={operation.id}>
          <strong>{operation.state === "completed" ? "Session prepared" : operation.state === "pending" ? "Preparing session" : operation.state === "unknown" ? "Outcome unknown — inspect the resource before retrying" : "Session request failed"}</strong>
          <span>{formatDate(operation.updated_at)}</span>
        </li>)}</ul> : <p className="hint">No session requests from the fleet yet.</p>}
        <p className="hint">These are recorded request outcomes. They do not report whether an agent is currently working.</p>
      </div> : <p className="hint">Ask the resource owner or a team administrator for operator access to start sessions and open previews.</p>}
      {mayOperate && data.capabilities.preview !== "unavailable" && <div className="fleet-card">
        <h2>Preview</h2>
        <p>{data.capabilities.preview === "provider-login" ? "Your provider's sign-in and sharing settings control access to this preview." : "This resource's preview is public. Fleet permissions do not make the preview private."}</p>
        <button className="secondary-button" disabled={preview.isPending} onClick={() => preview.mutate()}>Get preview link</button>
        {preview.error && <p className="error">{(preview.error as Error).message}</p>}
        {preview.data && <p><a href={preview.data.url} target="_blank" rel="noreferrer">Open preview</a></p>}
      </div>}
    </section>
  </>;
}

function SharingEditor({ resourceID, teamID, ownerID }: { resourceID: string; teamID: string; ownerID: string }) {
  const { token } = useConsole();
  const queryClient = useQueryClient();
  const path = `/v1/resources/${encodeURIComponent(resourceID)}/sharing`;
  const sharing = useQuery({ queryKey: ["resource", token, resourceID, "sharing"], queryFn: () => apiFetch<{ sharing: ResourceSharing }>(path, token), retry: false });
  const members = useQuery({ queryKey: ["resource-members", teamID, token], queryFn: () => apiFetch<{ members: Array<{ id: string; userId: string; role: string; user?: { name?: string; email?: string } }> }>(`/v1/auth/organization/list-members?organizationId=${encodeURIComponent(teamID)}&limit=500`, token) });
  const save = useMutation({
    mutationFn: (next: ResourceSharing) => apiFetch<{ sharing: ResourceSharing }>(path, token, { method: "PUT", body: next }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["resource", token, resourceID] }); },
    onError: () => { void sharing.refetch(); },
  });
  const policy = sharing.data?.sharing;
  return <div className="fleet-card">
    <h2>Resource access</h2>
    <p>Viewers can see resource details. Operators can run commands and access files. The owner and team administrators manage sharing.</p>
    {sharing.error && <p className="error">{(sharing.error as Error).message}</p>}
    {save.error && <p className="error">{(save.error as Error).message}</p>}
    {policy && <>
      <label className="resource-access-row">Team default<select aria-label="Team default access" value={policy.team_role} disabled={save.isPending} onChange={event => save.mutate({ ...policy, team_role: event.target.value as "viewer" | "operator" })}><option value="viewer">Viewer</option><option value="operator">Operator</option></select></label>
      {(members.data?.members || []).map(member => <label className="resource-access-row" key={member.id}>
        <span>{member.user?.name || member.user?.email || member.userId}</span>
        {member.userId === ownerID || member.role.split(",").some(role => ["owner", "admin"].includes(role.trim())) ? <span className="hint">Manager</span> : <select aria-label={`Access for ${member.user?.name || member.userId}`} disabled={save.isPending} value={policy.members.find(grant => grant.member_id === member.id)?.role || "default"} onChange={event => save.mutate({ ...policy, members: [...policy.members.filter(grant => grant.member_id !== member.id), ...(event.target.value === "default" ? [] : [{ member_id: member.id, role: event.target.value as "viewer" | "operator" }])] })}>
          <option value="default">Team default</option><option value="viewer">Viewer</option><option value="operator">Operator</option>
        </select>}
      </label>)}
      {members.error && <p className="error">{(members.error as Error).message}</p>}
    </>}
  </div>;
}
