import { createFileRoute } from "@tanstack/react-router";
import { TeamView } from "../../team";

// Members and settings for a specific team by slug or id. Deep links only
// VIEW the team — they never re-pin the session's active team.
export const Route = createFileRoute("/_console/team/$team")({
  head: ({ params }) => ({ meta: [{ title: `Members ${params.team} | BoxHaven` }] }),
  component: TeamRoute,
});

function TeamRoute() {
  const { team } = Route.useParams();
  return <TeamView teamRef={team} />;
}
