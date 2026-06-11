import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "../../dashboard";

// Boxes dashboard with nothing selected.
export const Route = createFileRoute("/_console/")({
  head: () => ({ meta: [{ title: "Boxes | BoxHaven" }] }),
  component: () => <Dashboard />,
});
