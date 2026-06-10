import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "../../dashboard";

// Dashboard with the box from the path selected. Unknown names render an
// inline not-found state in the detail panel (handled by Dashboard).
export const Route = createFileRoute("/_console/boxes/$name")({
  head: ({ params }) => ({ meta: [{ title: `${params.name} | BoxHaven` }] }),
  component: BoxRoute,
});

function BoxRoute() {
  const { name } = Route.useParams();
  return <Dashboard selectedName={name} />;
}
