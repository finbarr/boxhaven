import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AccessPanel } from "../access";
import { tokenKey } from "../api";
import { TopBar } from "../shell";

export const Route = createFileRoute("/signup")({
  head: () => ({ meta: [{ title: "Sign up | BoxHaven" }] }),
  component: SignupRoute,
});

function SignupRoute() {
  const navigate = useNavigate();

  function handleToken(token: string) {
    localStorage.setItem(tokenKey, token);
    void navigate({ to: "/" });
  }

  return (
    <>
      <TopBar subtitle="hosted beta" />
      <AccessPanel onToken={handleToken} />
    </>
  );
}
