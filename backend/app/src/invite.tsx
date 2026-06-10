import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Activity, Check, LogOut, Users } from "lucide-react";
import { useState } from "react";
import { apiFetch, sectionKey, tokenKey, WhoamiResponse } from "./api";
import { AccessPanel } from "./access";
import logoURL from "./assets/boxhaven-logo.png";

type InvitationDetail = {
  id: string;
  email?: string;
  role?: string;
  status?: string;
  expiresAt?: string;
  organizationName?: string;
  inviterEmail?: string;
};

export function InvitePanel({ invitationId }: { invitationId: string }) {
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || "");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: ["session", token],
    enabled: token.length > 0,
    retry: false,
    queryFn: () => apiFetch<WhoamiResponse>("/v1/auth/whoami", token),
  });
  const invitation = useQuery({
    queryKey: ["invitation", invitationId, token],
    enabled: Boolean(invitationId && token && session.data?.authenticated),
    retry: false,
    queryFn: () => apiFetch<InvitationDetail>(`/v1/auth/organization/get-invitation?id=${encodeURIComponent(invitationId)}`, token),
  });
  const accept = useMutation({
    mutationFn: () => apiFetch("/v1/auth/organization/accept-invitation", token, {
      method: "POST",
      body: { invitationId },
    }),
    onSuccess: () => {
      sessionStorage.setItem(sectionKey, "team");
      void queryClient.invalidateQueries();
      void navigate({ to: "/" });
    },
  });
  const authenticated = Boolean(token && session.data?.authenticated);

  function handleToken(nextToken: string) {
    localStorage.setItem(tokenKey, nextToken);
    setToken(nextToken);
  }

  function handleLogout() {
    void apiFetch("/v1/auth/sign-out", token, { method: "POST", body: {} }).catch(() => undefined);
    localStorage.removeItem(tokenKey);
    setToken("");
    queryClient.clear();
  }

  return (
    <main className="console">
      <div className="backdrop" />
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><img src={logoURL} alt="" /></div>
          <div>
            <strong>BoxHaven</strong>
            <span>team invitation</span>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="pulse"><Activity size={14} /> API</span>
          {authenticated ? (
            <button className="icon-button" type="button" title="Sign out" aria-label="Sign out" onClick={handleLogout}>
              <LogOut size={15} />
            </button>
          ) : null}
        </div>
      </header>

      {!invitationId ? (
        <section className="narrow-layout">
          <div className="auth-panel">
            <div className="panel-heading">
              <span>team invitation</span>
              <h1>Missing invitation</h1>
              <p>This link is missing its invitation id. Ask your teammate to send the full invite link.</p>
            </div>
          </div>
        </section>
      ) : !authenticated ? (
        <AccessPanel onToken={handleToken} notice="Sign in with the invited email to join the team." />
      ) : (
        <section className="narrow-layout">
          <div className="auth-panel grant-panel">
            <div className="grant-icon"><Users size={28} /></div>
            <div className="panel-heading">
              <span>team invitation</span>
              <h1>{invitation.data?.organizationName || "Join the team"}</h1>
              {invitation.data ? (
                <p>
                  {invitation.data.inviterEmail ? <>Invited by <strong>{invitation.data.inviterEmail}</strong> as </> : <>Join as </>}
                  <strong>{invitation.data.role || "member"}</strong>
                  {invitation.data.email ? <> ({invitation.data.email})</> : null}.
                </p>
              ) : null}
            </div>
            {invitation.data && !invitation.error ? (
              <p className="hint">Accepting joins the team and makes it your active team — new boxes land there until you switch.</p>
            ) : null}
            {invitation.isLoading ? <p className="hint">Loading invitation</p> : null}
            {invitation.error ? (
              <>
                <p className="error">{(invitation.error as Error).message}</p>
                <p className="hint">
                  Signed in as <strong>{session.data?.user?.email}</strong>.{" "}
                  <button className="link-button" type="button" onClick={handleLogout}>
                    Sign in with a different account
                  </button>
                </p>
              </>
            ) : null}
            {accept.error ? <p className="error">{(accept.error as Error).message}</p> : null}
            <button
              className="primary-button"
              type="button"
              disabled={accept.isPending || invitation.isLoading || Boolean(invitation.error)}
              onClick={() => accept.mutate()}
            >
              <Check size={16} />
              {accept.isPending ? "Joining" : "Accept invitation"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
