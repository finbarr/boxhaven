import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight, CreditCard } from "lucide-react";
import { apiFetch, BillingResponse, BillingStatus } from "./api";
import { useConsole } from "./console-context";
import { WorkspaceHead } from "./shell";

// teamRef is the /billing/$team path param (slug or id); without it the
// session's active team (or first team) is shown.
export function BillingView({ teamRef }: { teamRef?: string }) {
  const { token, teams, activeTeam } = useConsole();
  const defaultTeam = activeTeam ? activeTeam.slug || activeTeam.id : teams[0]?.slug || teams[0]?.id || "";
  const selectedTeam = teamRef || defaultTeam;
  const billing = useQuery({
    queryKey: ["billing", selectedTeam, token],
    queryFn: () => apiFetch<BillingResponse>(selectedTeam ? `/v1/billing?team=${encodeURIComponent(selectedTeam)}` : "/v1/billing", token),
  });
  const checkout = useMutation({
    mutationFn: (teamRef: string) => apiFetch<{ url: string }>("/v1/billing/checkout", token, { method: "POST", body: { team: teamRef } }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });
  const portal = useMutation({
    mutationFn: (teamRef: string) => apiFetch<{ url: string }>("/v1/billing/portal", token, { method: "POST", body: { team: teamRef } }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const info = billing.data;

  if (info && !info.enabled) {
    return (
      <>
        <WorkspaceHead eyebrow="billing" title="Billing" />
        <div className="workspace-body billing-body">
          <div className="panel">
            <div className="panel-heading small">
              <span>billing</span>
              <h2>Billing is not enabled on this backend</h2>
            </div>
            <p className="hint">The operator has not configured Stripe, so boxes are not billed here.</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <WorkspaceHead eyebrow="billing" title="Billing" />
      <div className="workspace-body billing-body">
        {billing.isLoading ? (
          <div className="panel"><p className="hint">Loading billing</p></div>
        ) : null}
        {billing.error ? (
          <div className="panel"><p className="error">{(billing.error as Error).message}</p></div>
        ) : null}

        {info?.enabled ? <TeamBillingPanel info={info} teamRef={selectedTeam || info.team.slug || info.team.id} checkout={checkout} portal={portal} /> : null}
      </div>
    </>
  );
}

function TeamBillingPanel({ info, teamRef, checkout, portal }: {
  info: Extract<BillingResponse, { enabled: true }>;
  teamRef: string;
  checkout: { mutate: (teamRef: string) => void; isPending: boolean; error: unknown };
  portal: { mutate: (teamRef: string) => void; isPending: boolean; error: unknown };
}) {
  const free = info.free_machines;
  const used = info.machines_used;
  const teamName = info.team.name;
  const freeBoxes = `${free} box${free === 1 ? "" : "es"}`;
  const subscribed = info.status === "active" || info.status === "past_due";
  const meterPercent = free > 0 ? Math.min(100, (used / free) * 100) : used > 0 ? 100 : 0;
  const portalButton = info.can_manage && info.portal_available ? (
    <button className="link-button" type="button" onClick={() => portal.mutate(teamRef)} disabled={portal.isPending}>
      Open the billing portal
    </button>
  ) : null;

  return (
    <>
      {info.status === "past_due" ? (
        <div className="warning-banner">
          <strong><AlertTriangle size={15} /> Payment past due</strong>
          <p>The last payment for {teamName} failed. Update the payment method to keep its extra boxes running.</p>
          {portalButton}
        </div>
      ) : null}
      {info.status === "canceled" ? (
        <div className="warning-banner">
          <strong><AlertTriangle size={15} /> Subscription canceled</strong>
          <p>
            {free > 0
              ? `${teamName} is back on the free tier (${freeBoxes}). Upgrade again to run more boxes.`
              : `${teamName} needs a subscription to run boxes. Subscribe again to keep using it.`}
          </p>
          {portalButton}
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-heading small">
          <span>plan</span>
          <h2>
            {teamName}
            <span className={info.status === "past_due" ? "badge warn" : "badge"}>{statusLabel(info.status)}</span>
          </h2>
        </div>
        <p className="hint">
          {subscribed
            ? free > 0
              ? `The first ${free === 1 ? "box is" : `${free} boxes are`} free; boxes beyond that are usage-billed per box-hour.`
              : `Boxes in ${teamName} are usage-billed per box-hour.`
            : free > 0
              ? `${teamName} includes ${free === 1 ? "1 free box" : `${free} free boxes`}. Upgrade to run more; additional boxes are usage-billed per box-hour.`
              : `${teamName} needs a subscription to run boxes; boxes are usage-billed per box-hour.`}
        </p>
        <div className="usage-meter">
          <span>
            {free > 0
              ? `${used} of ${freeBoxes} free in use${subscribed && used > free ? ` — ${used - free} usage-billed` : ""}`
              : `${used} box${used === 1 ? "" : "es"} in use${subscribed && used > 0 ? " — all usage-billed" : ""}`}
          </span>
          <div className="meter-track">
            <div className={used > free ? "meter-fill over" : "meter-fill"} style={{ width: `${meterPercent}%` }} />
          </div>
        </div>
        <div className="billing-actions">
          {subscribed ? (
            info.can_manage ? (
              <button className="primary-button" type="button" onClick={() => portal.mutate(teamRef)} disabled={portal.isPending || !info.portal_available}>
                <CreditCard size={16} />
                {portal.isPending ? "Opening" : "Manage billing"}
              </button>
            ) : (
              <p className="hint">Billing for this team is managed by its owners and admins.</p>
            )
          ) : info.can_manage ? (
            <button className="primary-button" type="button" onClick={() => checkout.mutate(teamRef)} disabled={checkout.isPending}>
              <ArrowUpRight size={16} />
              {checkout.isPending ? "Redirecting" : "Upgrade"}
            </button>
          ) : (
            <p className="hint">Ask a team owner or admin to subscribe.</p>
          )}
        </div>
        {checkout.error ? <p className="error">{(checkout.error as Error).message}</p> : null}
        {portal.error ? <p className="error">{(portal.error as Error).message}</p> : null}
      </div>
    </>
  );
}

export function statusLabel(status: BillingStatus): string {
  if (status === "active") return "subscribed";
  if (status === "past_due") return "past due";
  if (status === "free") return "free tier";
  return status;
}
