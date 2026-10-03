import { createFileRoute } from "@tanstack/react-router";
import { ResourceDetail } from "../../fleet";

export const Route = createFileRoute("/_console/resources/$resourceID")({ component: ResourceRoute });

function ResourceRoute() {
  const { resourceID } = Route.useParams();
  return <ResourceDetail key={resourceID} resourceID={resourceID} />;
}
