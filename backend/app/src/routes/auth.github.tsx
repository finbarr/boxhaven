import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { apiFetch, tokenKey } from "../api";
import { GitHubMark, TopBar } from "../shell";

// GitHub OAuth lands back here after the backend callback sets the session
// cookie on the API origin; exchange it for the bearer token the console
// stores, then continue to wherever the user was headed.
export const Route = createFileRoute("/auth/github")({
  head: () => ({ meta: [{ title: "Signing in | BoxHaven" }] }),
  component: GitHubCallback,
});

type SessionResponse = {
  session?: { token?: string };
};

function GitHubCallback() {
  const navigate = useNavigate();
  const session = useQuery({
    queryKey: ["github-callback-session"],
    retry: 1,
    queryFn: () => apiFetch<SessionResponse | null>("/v1/auth/get-session", "", { credentials: "include" }),
  });
  const token = session.data?.session?.token;

  useEffect(() => {
    if (token) {
      localStorage.setItem(tokenKey, token);
      void navigate({ to: "/", replace: true });
    }
  }, [token, navigate]);

  return (
    <>
      <TopBar subtitle="signing in" />
      <section className="narrow-layout">
        <div className="auth-panel grant-panel">
          <div className="grant-icon"><GitHubMark size={26} /></div>
          <div className="panel-heading">
            <span>github</span>
            <h1>{session.isLoading ? "Finishing sign-in" : token ? "Signed in" : "Sign-in incomplete"}</h1>
            {!session.isLoading && !token ? (
              <p>The GitHub sign-in did not produce a session. Head back and try again.</p>
            ) : null}
          </div>
          {session.error ? <p className="error">{(session.error as Error).message}</p> : null}
          {!session.isLoading && !token ? (
            <a className="primary-button" href="/signup">Back to sign-in</a>
          ) : null}
        </div>
      </section>
    </>
  );
}
