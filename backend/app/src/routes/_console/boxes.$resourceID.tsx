import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "../../dashboard";

// Stable identities keep shared box links valid after a rename.
export const Route = createFileRoute("/_console/boxes/$resourceID")({
  head: () => ({ meta: [{ title: "Box | BoxHaven" }] }),
  component: BoxRoute,
});

function BoxRoute() {
  const { resourceID } = Route.useParams();
  return <Dashboard selectedResourceID={resourceID} />;
}
