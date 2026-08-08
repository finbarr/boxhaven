import { createFileRoute } from "@tanstack/react-router";
import { useConsole } from "../../console-context";
import { SecurityView } from "../../security";

export const Route = createFileRoute("/_console/security")({
  head: () => ({ meta: [{ title: "Security | BoxHaven" }] }),
  component: SecurityRoute,
});

function SecurityRoute() {
  const { token, replaceToken } = useConsole();
  return <SecurityView token={token} replaceToken={replaceToken} />;
}
