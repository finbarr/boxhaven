import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useMatchRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { AccessPanel, LandingPage } from "../../access";
import { apiFetch, tokenKey, WhoamiResponse } from "../../api";
import { ConsoleProvider } from "../../console-context";
import { ConsoleSection, ConsoleShell, TopBar } from "../../shell";

// Pathless authed layout: owns the localStorage token, the whoami session
// query, the topbar and section nav. Unauthenticated visitors get the
// Unauthenticated visitors see the public landing page at `/`; deep console
// links render the auth form in place so the requested route survives sign-in.
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
  const onHome = Boolean(matchRoute({ to: "/", fuzzy: false }));
  const onBox = Boolean(matchRoute({ to: "/boxes/$name" }));
  const onDevice = Boolean(matchRoute({ to: "/device" }));
  const onTeam = Boolean(matchRoute({ to: "/team" }) || matchRoute({ to: "/team/$team" }));
  const onTeams = Boolean(matchRoute({ to: "/teams" }));
  const onImages = Boolean(matchRoute({ to: "/images" }));
  const activeSection: ConsoleSection = onTeam ? "team" : onTeams ? "teams" : onImages ? "images" : (onHome || onBox) ? "boxes" : "billing";
  // Surfaced in the sign-in hint when someone deep-links to /device.
  const deviceUserCode = typeof search.user_code === "string" ? search.user_code : "";
  const switchTeam = useMutation({
    mutationFn: (organizationId: string) => apiFetch("/v1/auth/organization/set-active", token, {
      method: "POST",
      body: { organizationId },
    }),
    onSuccess: (_data, organizationId) => {
      const team = (session.data?.teams || []).find((candidate) => candidate.id === organizationId);
      const teamRef = team?.slug || team?.id || organizationId;
      void queryClient.invalidateQueries({ queryKey: ["session", token] });
      void queryClient.invalidateQueries({ queryKey: ["machines", token] });
      void queryClient.invalidateQueries({ queryKey: ["billing"] });
      if (activeSection === "team") {
        void navigate({ to: "/team/$team", params: { team: teamRef } });
      } else if (activeSection === "billing") {
        void navigate({ to: "/billing/$team", params: { team: teamRef } });
      } else if (onBox) {
        void navigate({ to: "/" });
      }
    },
  });

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

  function handleTeamSwitch(organizationId: string) {
    if (!organizationId || organizationId === session.data?.team?.id || switchTeam.isPending) return;
    switchTeam.mutate(organizationId);
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
        <TopBar
          subtitle="remote dev boxes"
          actions={onHome ? (
            <div className="auth-cta">
              <Link className="secondary-button" to="/signup" search={{ mode: "signin" }}>Sign in</Link>
              <Link className="primary-button" to="/signup">Sign up</Link>
            </div>
          ) : undefined}
        />
        {onHome ? <LandingPage /> : <AccessPanel onToken={handleToken} deviceUserCode={deviceUserCode} />}
      </>
    );
  }

  const consoleValue = {
    token,
    user: session.data?.user,
    teams: session.data?.teams || [],
    activeTeam: session.data?.team || undefined,
    isAdmin,
  };

  // The CLI device-approval page is a focused confirmation; render it without
  // the nav shell so nothing competes with the approve/deny choice.
  if (onDevice) {
    return (
      <>
        <TopBar subtitle="remote dev boxes" />
        <ConsoleProvider value={consoleValue}>
          <Outlet />
        </ConsoleProvider>
      </>
    );
  }

  return (
    <ConsoleProvider value={consoleValue}>
      <ConsoleShell
        activeSection={activeSection}
        isAdmin={isAdmin}
        email={session.data?.user?.email}
        teams={consoleValue.teams}
        activeTeam={consoleValue.activeTeam}
        teamSwitching={switchTeam.isPending}
        teamSwitchError={switchTeam.error ? (switchTeam.error as Error).message : ""}
        onTeamSwitch={handleTeamSwitch}
        onLogout={handleLogout}
      >
        <Outlet />
      </ConsoleShell>
    </ConsoleProvider>
  );
}
