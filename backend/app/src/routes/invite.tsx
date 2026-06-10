import { createFileRoute } from "@tanstack/react-router";
import { InvitePanel } from "../invite";

export const Route = createFileRoute("/invite")({
  validateSearch: (search: Record<string, unknown>) => ({
    id: typeof search.id === "string" ? search.id : "",
  }),
  head: () => ({ meta: [{ title: "Team invite | BoxHaven" }] }),
  component: InviteRoute,
});

function InviteRoute() {
  const { id } = Route.useSearch();
  return <InvitePanel invitationId={id} />;
}
