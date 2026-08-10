import { useMutation, useQuery } from "@tanstack/react-query";
import { CreditCard, ExternalLink } from "lucide-react";
import { AccountSummary, apiFetch, TeamInfo } from "./api";
import { CentsCostEstimate } from "./cost-estimate";
import { WorkspaceHead } from "./shell";

const stateLabels: Record<AccountSummary["state"], string> = {
  trial: "Included usage",
  active: "Active",
  past_due: "Payment due",
  inactive: "Inactive",
};

export function AccountView({ token, team }: { token: string; team?: TeamInfo }) {
  const teamRef = team?.slug || team?.id || "";
  const summary = useQuery({
    queryKey: ["account", token, teamRef],
    enabled: Boolean(teamRef),
    retry: false,
    queryFn: () => apiFetch<AccountSummary>(`/v1/account?team=${encodeURIComponent(teamRef)}`, token),
  });
  const action = useMutation({
    mutationFn: () => apiFetch<{ url: string }>("/v1/account/action", token, {
      method: "POST",
      body: { team: teamRef },
    }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const account = summary.data;
  const actionLabel = account?.primary_action === "manage" ? "Manage plan" : "Choose a plan";

  return (
    <>
      <WorkspaceHead eyebrow={`team / ${team?.name || "current"}`} title="Account" />
      <section className="workspace-body account-workspace">
        <div className="panel account-panel">
          {summary.isPending ? <p className="hint">Loading account</p> : null}
          {summary.error ? <p className="error">{(summary.error as Error).message}</p> : null}
          {account ? (
            <>
              <div className="account-status">
                <span>Plan status</span>
                <strong className={`account-state account-state-${account.state}`}>{stateLabels[account.state]}</strong>
              </div>
              <div className="account-metrics">
                <div>
                  <span>Included credit remaining</span>
                  <strong title="Included credit balance">{formatUSD(account.included_credit_cents)}</strong>
                </div>
                <div>
                  <span>Current box rate</span>
                  <strong><CentsCostEstimate hourlyCents={account.active_hourly_cents} /></strong>
                </div>
              </div>
              <div className="account-actions">
                {account.can_manage && account.primary_action ? (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={action.isPending}
                    onClick={() => action.mutate()}
                  >
                    {account.primary_action === "manage" ? <ExternalLink size={17} /> : <CreditCard size={17} />}
                    {action.isPending ? "Opening" : actionLabel}
                  </button>
                ) : (
                  <p className="hint">Only team owners and admins can manage the plan.</p>
                )}
                {action.error ? <p className="error">{(action.error as Error).message}</p> : null}
              </div>
            </>
          ) : null}
        </div>
      </section>
    </>
  );
}

function formatUSD(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(cents / 100);
}
