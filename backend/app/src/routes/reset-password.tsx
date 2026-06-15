import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ResetPasswordPanel } from "../access";
import { TopBar } from "../shell";

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
    error: typeof search.error === "string" ? search.error : "",
  }),
  head: () => ({ meta: [{ title: "Reset password | BoxHaven" }] }),
  component: ResetPasswordRoute,
});

function ResetPasswordRoute() {
  const { token, error } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <>
      <TopBar subtitle="account recovery" />
      <ResetPasswordPanel resetToken={token} linkError={error} onDone={() => void navigate({ to: "/signup" })} />
    </>
  );
}
