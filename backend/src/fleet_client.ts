import { apiRequest, BoxHavenAPIError } from "./client.js";
import type { FleetResponse } from "./resource_types.js";

/** Cached backend state plus SSE invalidations; this never polls provider APIs. */
export async function watchTeamResources(baseURL: string, teamID: string, token: string, signal: AbortSignal, onSnapshot: (snapshot: FleetResponse) => void): Promise<void> {
  const base = baseURL.replace(/\/+$/, "");
  const path = `/v1/teams/${encodeURIComponent(teamID)}`;
  let retry = 1000;
  while (!signal.aborted) {
    try {
      let snapshot = await apiRequest<FleetResponse>(base, `${path}/resources`, token, { signal });
      onSnapshot(snapshot);
      const response = await fetch(`${base}${path}/events?cursor=${snapshot.cursor}`, {
        signal, headers: { Authorization: `Bearer ${token}`, "X-BoxHaven-Protocol": "1" },
      });
      if (response.status === 409) { await response.body?.cancel(); continue; }
      if (!response.ok) {
        await response.body?.cancel();
        throw new BoxHavenAPIError("Boxes subscription is unavailable.", response.status);
      }
      if (!response.body) throw new Error("Boxes subscription has no event stream.");
      retry = 1000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 256 * 1024) throw new Error("Boxes event buffer exceeded its limit.");
          let reset = false, changed = false, boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (event.includes("event: access.revoked")) throw new BoxHavenAPIError("Team access was revoked.", 403);
            if (event.includes("event: sync.reset")) { reset = true; break; }
            const id = Number(/^id: (\d+)$/m.exec(event)?.[1] || 0);
            if (id > snapshot.cursor && /^event: resource\.(changed|removed)$/m.test(event)) changed = true;
          }
          if (reset) break;
          if (changed) {
            snapshot = await apiRequest<FleetResponse>(base, `${path}/resources`, token, { signal });
            onSnapshot(snapshot);
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof BoxHavenAPIError && [401, 403, 404, 426].includes(error.status)) throw error;
      // Network loss does not remove resources. Reconnect with a fresh snapshot.
    }
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, retry);
      signal.addEventListener("abort", done, { once: true });
    });
    retry = Math.min(10000, retry * 2);
  }
}
