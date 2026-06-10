import { createFileRoute } from "@tanstack/react-router";
import { TeamView } from "../../team";

// The session's active team.
export const Route = createFileRoute("/_console/team/")({
  head: () => ({ meta: [{ title: "Team | BoxHaven" }] }),
  component: () => <TeamView />,
});
