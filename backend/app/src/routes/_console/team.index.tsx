import { createFileRoute } from "@tanstack/react-router";
import { TeamView } from "../../team";

// Members and settings for the session's active team.
export const Route = createFileRoute("/_console/team/")({
  head: () => ({ meta: [{ title: "Members | BoxHaven" }] }),
  component: () => <TeamView />,
});
