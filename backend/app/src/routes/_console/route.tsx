import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useMatchRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { CreditCard, Layers, LogOut, Server, Users } from "lucide-react";
import { useState } from "react";
import { AccessPanel } from "../../access";
import { apiFetch, tokenKey, WhoamiResponse } from "../../api";
import { ConsoleProvider } from "../../console-context";
import { TopBar } from "../../shell";

// Pathless authed layout: owns the localStorage token, the whoami session
// query, the topbar and section nav. Unauthenticated visitors get the
// AccessPanel mini-landing rendered in place for ANY console URL, so the
// deep link survives sign-in.
export const Route = createFileRoute("/_console")({
  component: ConsoleLayout,
});

function ConsoleLayout() {
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || "");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const search = useSearch({ strict: false });
  const session = useQuery({
    queryKey: ["session", token],
    enabled: token.length > 0,
    retry: false,
    queryFn: () => apiFetch<WhoamiResponse>("/v1/auth/whoami", token),
  });
  const authenticated = Boolean(token && session.data?.authenticated);
  const isAdmin = Boolean(session.data?.admin);
  const onBox = Boolean(matchRoute({ to: "/boxes/$name" }));
  const onDevice = Boolean(matchRoute({ to: "/device" }));
  // Surfaced in the sign-in hint when someone deep-links to /device.
  const deviceUserCode = typeof search.user_code === "string" ? search.user_code : "";

  function handleToken(nextToken: string) {
    localStorage.setItem(tokenKey, nextToken);
    setToken(nextToken);
  }

  function handleLogout() {
    if (token) {
      void apiFetch("/v1/auth/sign-out", token, { method: "POST", body: {} }).catch(() => undefined);
    }
    localStorage.removeItem(tokenKey);
    setToken("");
    queryClient.clear();
    void navigate({ to: "/" });
  }

  if (token && session.isPending) {
    return (
      <>
        <TopBar subtitle="remote dev boxes" />
        <section className="narrow-layout">
          <div className="auth-panel"><p className="hint">Loading session</p></div>
        </section>
      </>
    );
  }

  if (!authenticated) {
    return (
      <>
        <TopBar subtitle="remote dev boxes" />
        <AccessPanel onToken={handleToken} deviceUserCode={deviceUserCode} />
      </>
    );
  }

  return (
    <>
      <TopBar
        subtitle="remote dev boxes"
        nav={onDevice ? undefined : (
          <nav className="section-tabs">
            <Link
              to="/"
              activeOptions={{ exact: true }}
              activeProps={{ className: "active" }}
              className={onBox ? "active" : undefined}
            >
              <Server size={15} />
              Boxes
            </Link>
            <Link to="/team" activeProps={{ className: "active" }}>
              <Users size={15} />
              Team
            </Link>
            {isAdmin ? (
              <Link to="/images" activeProps={{ className: "active" }}>
                <Layers size={15} />
                Images
              </Link>
            ) : null}
            <Link to="/billing" activeProps={{ className: "active" }}>
              <CreditCard size={15} />
              Billing
            </Link>
          </nav>
        )}
        actions={(
          <button className="icon-button" type="button" onClick={handleLogout} title="Log out" aria-label="Log out">
            <LogOut size={17} />
          </button>
        )}
      />
      <ConsoleProvider
        value={{
          token,
          user: session.data?.user,
          teams: session.data?.teams || [],
          activeTeam: session.data?.team || undefined,
          isAdmin,
        }}
      >
        <Outlet />
      </ConsoleProvider>
    </>
  );
}
