import { createFileRoute } from "@tanstack/react-router";
import { BillingView } from "../../billing";

// Billing for the team in the path (slug or id) — replaces the old
// billingTeam preselect state.
export const Route = createFileRoute("/_console/billing/$team")({
  head: ({ params }) => ({ meta: [{ title: `Billing ${params.team} | BoxHaven` }] }),
  component: BillingRoute,
});

function BillingRoute() {
  const { team } = Route.useParams();
  return <BillingView teamRef={team} />;
}
