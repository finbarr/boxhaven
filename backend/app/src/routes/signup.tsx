import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AuthFormPanel } from "../access";
import { tokenKey } from "../api";
import { TopBar } from "../shell";

export const Route = createFileRoute("/signup")({
  head: () => ({ meta: [{ title: "Access | BoxHaven" }] }),
  validateSearch: (search: Record<string, unknown>): { mode?: "signin" } => (
    search.mode === "signin" ? { mode: "signin" } : {}
  ),
  component: SignupRoute,
});

function SignupRoute() {
  const navigate = useNavigate();
  const { mode } = Route.useSearch();

  function handleToken(token: string) {
    localStorage.setItem(tokenKey, token);
    void navigate({ to: "/" });
  }

  return (
    <>
      <TopBar subtitle="console access" />
      <section className="narrow-layout signup-page">
        <AuthFormPanel onToken={handleToken} initialMode={mode} />
      </section>
    </>
  );
}
