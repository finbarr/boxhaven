import { useMutation } from "@tanstack/react-query";
import { KeyRound, ShieldCheck } from "lucide-react";
import { FormEvent, useState } from "react";
import { apiFetch } from "./api";
import { WorkspaceHead } from "./shell";

type ChangePasswordResponse = {
  token?: string | null;
};

export function SecurityView({ token, replaceToken }: { token: string; replaceToken: (token: string) => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);
  const [validationError, setValidationError] = useState("");
  const change = useMutation({
    mutationFn: () => apiFetch<ChangePasswordResponse>("/v1/auth/change-password", token, {
      method: "POST",
      body: { currentPassword, newPassword, revokeOtherSessions },
    }),
    onSuccess: ({ token: replacementToken }) => {
      if (replacementToken) replaceToken(replacementToken);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setValidationError("New passwords do not match.");
      return;
    }
    setValidationError("");
    change.reset();
    change.mutate();
  }

  return (
    <>
      <WorkspaceHead eyebrow="account" title="Security" />
      <section className="workspace-body security-workspace">
        <div className="panel security-panel">
          <div className="security-intro">
            <span className="security-icon"><KeyRound size={22} /></span>
            <div>
              <h2>Change password</h2>
              <p>Update the password used for email sign-in.</p>
            </div>
          </div>
          <form className="security-form" onSubmit={submit}>
            <label>
              Current password
              <input value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} type="password" autoComplete="current-password" required />
            </label>
            <label>
              New password
              <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
            </label>
            <label>
              Confirm new password
              <input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
            </label>
            <label className="security-session-option">
              <input type="checkbox" checked={revokeOtherSessions} onChange={(event) => setRevokeOtherSessions(event.target.checked)} />
              <span>Sign out other devices and browsers</span>
            </label>
            {validationError ? <p className="error">{validationError}</p> : null}
            {change.error ? <p className="error">{(change.error as Error).message}</p> : null}
            {change.isSuccess ? <p className="security-success"><ShieldCheck size={16} /> Password updated.</p> : null}
            <button className="primary-button security-submit" type="submit" disabled={change.isPending}>
              <KeyRound size={16} />
              {change.isPending ? "Updating" : "Update password"}
            </button>
          </form>
          <p className="security-footnote">GitHub-only accounts can set an email password through the password-reset flow on the sign-in page.</p>
        </div>
      </section>
    </>
  );
}
