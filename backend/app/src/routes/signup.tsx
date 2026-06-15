import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { AuthFormPanel } from "../access";
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
      <section className="narrow-layout signup-page">
        <AuthFormPanel onToken={handleToken} />
        <div className="signup-self-host">
          <span>Want to self-host?</span>
          <a href="https://docs.boxhaven.dev/self-hosting" target="_blank" rel="noreferrer">
            Read the documentation
            <ArrowUpRight size={14} />
          </a>
        </div>
      </section>
    </>
  );
}
