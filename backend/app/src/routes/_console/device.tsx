import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Check, ShieldCheck, XCircle } from "lucide-react";
import { apiFetch, AuthUser, formatUserCode } from "../../api";
import logoURL from "../../assets/boxhaven-logo.png";
import { useConsole } from "../../console-context";

type DeviceStatusResponse = {
  user_code: string;
  status: "pending" | "approved" | "denied";
};

// CLI device-grant approval. The CLI sends the user here as
// /device?user_code=XXXX (legacy links also used ?code=).
export const Route = createFileRoute("/_console/device")({
  validateSearch: (search: Record<string, unknown>) => ({
    user_code: typeof search.user_code === "string" && search.user_code.trim()
      ? search.user_code.trim()
      : typeof search.code === "string"
        ? search.code.trim()
        : "",
  }),
  head: () => ({ meta: [{ title: "Approve CLI | BoxHaven" }] }),
  component: DeviceRoute,
});

function DeviceRoute() {
  const { user_code } = Route.useSearch();
  const { token, user } = useConsole();
  const navigate = useNavigate();
  if (!user_code) {
    return (
      <section className="narrow-layout">
        <div className="auth-panel grant-panel">
          <div className="grant-icon"><ShieldCheck size={28} /></div>
          <div className="panel-heading">
            <span>CLI access request</span>
            <h1>Missing device code</h1>
            <p>This link has no device code. Run <code>bh login</code> again and follow the link it prints.</p>
          </div>
          <Link className="primary-button" to="/">Back to the console</Link>
        </div>
      </section>
    );
  }
  return <DeviceGrantPanel token={token} user={user} userCode={user_code} onDone={() => void navigate({ to: "/" })} />;
}

function DeviceGrantPanel({ token, user, userCode, onDone }: {
  token: string;
  user?: AuthUser;
  userCode: string;
  onDone: () => void;
}) {
  const verify = useQuery({
    queryKey: ["device-login", userCode, token],
    retry: false,
    queryFn: () => apiFetch<DeviceStatusResponse>(`/v1/auth/device?user_code=${encodeURIComponent(userCode)}`, token),
  });
  const approve = useMutation({
    mutationFn: () => apiFetch<{ success: boolean }>("/v1/auth/device/approve", token, { method: "POST", body: { userCode } }),
  });
  const deny = useMutation({
    mutationFn: () => apiFetch<{ success: boolean }>("/v1/auth/device/deny", token, { method: "POST", body: { userCode } }),
  });
  const finished = approve.isSuccess || deny.isSuccess;
  const blocked = verify.isLoading || verify.isError || finished || approve.isPending || deny.isPending;

  return (
    <section className="access-layout grant-layout">
      <div className="welcome-panel compact">
        <div className="logo-stage"><img src={logoURL} alt="BoxHaven logo" /></div>
        <div className="terminal-card">
          <div className="terminal-title">
            <span />
            <span />
            <span />
          </div>
          <pre>{`$ bh login
browser grant requested
account: ${user?.email || "signed-in user"}
code: ${formatUserCode(userCode)}`}</pre>
        </div>
      </div>
      <div className="auth-panel grant-panel">
        <div className="grant-icon"><ShieldCheck size={28} /></div>
        <div className="panel-heading">
          <span>CLI access request</span>
          <h1>Allow BoxHaven CLI?</h1>
          <p>Grant this terminal session access as <strong>{user?.email || "this account"}</strong>.</p>
        </div>
        <div className="code-chip">{formatUserCode(userCode)}</div>
        {verify.error ? <p className="error">{(verify.error as Error).message}</p> : null}
        {approve.isSuccess ? <p className="success-text">Access granted. You can return to the terminal.</p> : null}
        {deny.isSuccess ? <p className="error">Request denied. You can return to the terminal.</p> : null}
        <div className="grant-actions">
          {finished ? (
            <button className="primary-button" type="button" onClick={onDone}>
              <Check size={16} />
              Done
            </button>
          ) : (
            <>
              <button className="primary-button" type="button" onClick={() => approve.mutate()} disabled={blocked}>
                <Check size={16} />
                Allow
              </button>
              <button className="danger-button" type="button" onClick={() => deny.mutate()} disabled={blocked}>
                <XCircle size={16} />
                Deny
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
