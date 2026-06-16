import { createFileRoute } from "@tanstack/react-router";
import { TeamsView } from "../../teams";

export const Route = createFileRoute("/_console/teams")({
  head: () => ({ meta: [{ title: "Teams | BoxHaven" }] }),
  component: () => <TeamsView />,
});
