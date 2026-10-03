import { createFileRoute } from "@tanstack/react-router";
import { Fleet } from "../../fleet";

export const Route = createFileRoute("/_console/fleet")({
  head: () => ({ meta: [{ title: "Fleet | BoxHaven" }] }),
  component: Fleet,
});
