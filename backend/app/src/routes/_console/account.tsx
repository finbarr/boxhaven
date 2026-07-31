import { createFileRoute } from "@tanstack/react-router";
import { AccountView } from "../../account";
import { useConsole } from "../../console-context";

export const Route = createFileRoute("/_console/account")({
  head: () => ({ meta: [{ title: "Account | BoxHaven" }] }),
  component: AccountRoute,
});

function AccountRoute() {
  const { token, activeTeam } = useConsole();
  return <AccountView token={token} team={activeTeam} />;
}
