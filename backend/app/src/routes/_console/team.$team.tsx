import { createFileRoute } from "@tanstack/react-router";
import { TeamView } from "../../team";

// A specific team by slug or id. Deep links only VIEW the team — they never
// re-pin the session's active team (only the selector fires set-active).
export const Route = createFileRoute("/_console/team/$team")({
  head: ({ params }) => ({ meta: [{ title: `Team ${params.team} | BoxHaven` }] }),
  component: TeamRoute,
});

function TeamRoute() {
  const { team } = Route.useParams();
  return <TeamView teamRef={team} />;
}
