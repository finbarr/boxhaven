import { createFileRoute } from "@tanstack/react-router";
import { BillingView } from "../../billing";

// Billing for the default (active) team.
export const Route = createFileRoute("/_console/billing/")({
  head: () => ({ meta: [{ title: "Billing | BoxHaven" }] }),
  component: () => <BillingView />,
});
