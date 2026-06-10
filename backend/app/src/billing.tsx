import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowUpRight, CreditCard } from "lucide-react";
import { apiFetch, BillingResponse } from "./api";

export function BillingView({ token }: { token: string }) {
  const billing = useQuery({
    queryKey: ["billing", token],
    queryFn: () => apiFetch<BillingResponse>("/v1/billing", token),
  });
  const checkout = useMutation({
    mutationFn: () => apiFetch<{ url: string }>("/v1/billing/checkout", token, { method: "POST", body: {} }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });
  const portal = useMutation({
    mutationFn: () => apiFetch<{ url: string }>("/v1/billing/portal", token, { method: "POST", body: {} }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  if (billing.isLoading) {
    return (
      <section className="billing-layout">
        <div className="panel"><p className="hint">Loading billing</p></div>
      </section>
    );
  }
  if (billing.error) {
    return (
      <section className="billing-layout">
        <div className="panel"><p className="error">{(billing.error as Error).message}</p></div>
      </section>
    );
  }
  const info = billing.data;
  if (!info || !info.enabled) {
    return (
      <section className="billing-layout">
        <div className="panel">
          <div className="panel-heading small">
            <span>billing</span>
            <h2>Billing is not enabled on this backend</h2>
          </div>
          <p className="hint">The operator has not configured Stripe, so boxes are not billed here.</p>
        </div>
      </section>
    );
  }

  const free = info.free_machines;
  const used = info.machines_used;
  const freeBoxes = `${free} box${free === 1 ? "" : "es"}`;
  const subscribed = info.status === "active" || info.status === "past_due";
  const meterPercent = free > 0 ? Math.min(100, (used / free) * 100) : 100;

  return (
    <section className="billing-layout">
      {info.status === "past_due" ? (
        <div className="warning-banner">
          <strong><AlertTriangle size={15} /> Payment past due</strong>
          <p>Your last payment failed. Update your payment method to keep extra boxes running.</p>
          {info.portal_available ? (
            <button className="link-button" type="button" onClick={() => portal.mutate()} disabled={portal.isPending}>
              Open the billing portal
            </button>
          ) : null}
        </div>
      ) : null}
      {info.status === "canceled" ? (
        <div className="warning-banner">
          <strong><AlertTriangle size={15} /> Subscription canceled</strong>
          <p>You are back on the free tier ({freeBoxes}). Upgrade again to run more boxes.</p>
          {info.portal_available ? (
            <button className="link-button" type="button" onClick={() => portal.mutate()} disabled={portal.isPending}>
              Open the billing portal
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-heading small">
          <span>plan</span>
          <h2>
            {info.status === "active" ? "Subscribed" : `Free — ${freeBoxes} included`}
            <span className={info.status === "past_due" ? "badge warn" : "badge"}>{statusLabel(info.status)}</span>
          </h2>
        </div>
        <p className="hint">
          {subscribed
            ? `Your first ${free === 1 ? "box is" : `${free} boxes are`} free; boxes beyond that are usage-billed per box-hour.`
            : `Your account includes ${free === 1 ? "1 free box" : `${free} free boxes`}. Upgrade to run more — additional boxes are usage-billed per box-hour.`}
        </p>
        <div className="usage-meter">
          <span>
            {used} of {freeBoxes} free in use
            {subscribed && used > free ? ` — ${used - free} usage-billed` : ""}
          </span>
          <div className="meter-track">
            <div className={used > free ? "meter-fill over" : "meter-fill"} style={{ width: `${meterPercent}%` }} />
          </div>
        </div>
        <div className="billing-actions">
          {subscribed ? (
            <button className="primary-button" type="button" onClick={() => portal.mutate()} disabled={portal.isPending || !info.portal_available}>
              <CreditCard size={16} />
              {portal.isPending ? "Opening" : "Manage billing"}
            </button>
          ) : (
            <button className="primary-button" type="button" onClick={() => checkout.mutate()} disabled={checkout.isPending}>
              <ArrowUpRight size={16} />
              {checkout.isPending ? "Redirecting" : "Upgrade"}
            </button>
          )}
        </div>
        {checkout.error ? <p className="error">{(checkout.error as Error).message}</p> : null}
        {portal.error ? <p className="error">{(portal.error as Error).message}</p> : null}
      </div>
    </section>
  );
}

function statusLabel(status: BillingResponse["status"]): string {
  if (status === "past_due") return "past due";
  return status;
}
