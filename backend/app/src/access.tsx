import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import { Copy, KeyRound, MailCheck, Play, RotateCw, Send } from "lucide-react";
import { FormEvent, useState } from "react";
import { apiFetch, BoxHavenAPIError, formatUserCode, LoginResponse } from "./api";
import { GitHubMark, isHostedService, privacyURL, termsURL } from "./shell";

export const installCommand = "curl -fsSL https://raw.githubusercontent.com/finbarr/boxhaven/master/install.sh | sh";

export function AccessPanel({ onToken, deviceUserCode, notice }: {
  onToken: (token: string) => void;
  deviceUserCode?: string;
  notice?: string;
}) {
  return (
    <section className="narrow-layout signup-page">
      <AuthFormPanel onToken={onToken} deviceUserCode={deviceUserCode} notice={notice} />
    </section>
  );
}

export function AuthFormPanel({ onToken, deviceUserCode, notice, initialMode }: {
  onToken: (token: string) => void;
  deviceUserCode?: string;
  notice?: string;
  initialMode?: "signin" | "signup";
}) {
  const verified = new URLSearchParams(window.location.search).get("verified") === "true";
  const verificationError = verificationErrorMessage(new URLSearchParams(window.location.search).get("error"));
  const [mode, setMode] = useState<"signin" | "signup">(initialMode ?? (verified || verificationError ? "signin" : "signup"));
  const [forgot, setForgot] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const requiresTerms = isHostedService && mode === "signup";
  const github = useMutation({
    mutationFn: () => apiFetch<{ url?: string }>("/v1/auth/sign-in/social", "", {
      method: "POST",
      body: { provider: "github", callbackURL: `${window.location.origin}/auth/github` },
    }),
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
  });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [verificationEmail, setVerificationEmail] = useState("");
  const resend = useMutation({
    mutationFn: () => apiFetch<{ status: boolean }>("/v1/auth/send-verification-email", "", {
      method: "POST",
      body: { email: verificationEmail, callbackURL: verificationCallbackURL() },
    }),
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const endpoint = mode === "signup" ? "/v1/auth/sign-up/email" : "/v1/auth/sign-in/email";
      return apiFetch<LoginResponse>(endpoint, "", {
        method: "POST",
        body: {
          email,
          password,
          ...(mode === "signup" ? { name: name || email.split("@")[0], callbackURL: verificationCallbackURL() } : {}),
        },
      });
    },
    onSuccess: (data) => {
      if (data.token) onToken(data.token);
      else setVerificationEmail(email);
    },
    onError: (error) => {
      if (error instanceof BoxHavenAPIError && error.code === "EMAIL_NOT_VERIFIED") {
        setVerificationEmail(email);
      }
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (requiresTerms && !acceptedTerms) return;
    mutation.mutate();
  }

  return (
    <>
      {verificationEmail ? (
        <VerificationPending
          email={verificationEmail}
          resend={resend}
          onUseAnother={() => {
            setVerificationEmail("");
            setMode("signin");
            mutation.reset();
            resend.reset();
          }}
        />
      ) : forgot ? (
        <ForgotPasswordForm onBack={() => setForgot(false)} />
      ) : (
        <form id="signup" className="auth-panel signup-panel" onSubmit={submit}>
          <div className="panel-heading">
            <span>{mode === "signup" ? "create account" : "welcome back"}</span>
            <h1>{mode === "signup" ? "Create a BoxHaven account" : "Open the console"}</h1>
          </div>
          {verified ? <p className="success-text">Email verified. Sign in to open the console.</p> : null}
          {verificationError ? <p className="error" role="alert">{verificationError}</p> : null}
          {notice ? <p className="hint">{notice}</p> : null}
          <div className="segmented">
            <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Sign up</button>
            <button type="button" className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")}>Sign in</button>
          </div>
          {requiresTerms ? (
            <label className="legal-consent">
              <input
                type="checkbox"
                checked={acceptedTerms}
                onChange={(event) => setAcceptedTerms(event.target.checked)}
                required
              />
              <span>
                I agree to the <a href={termsURL} target="_blank" rel="noreferrer">Terms of Service</a>, including
                individual arbitration, and acknowledge the <a href={privacyURL} target="_blank" rel="noreferrer">Privacy Policy</a>.
              </span>
            </label>
          ) : null}
          <button className="github-button" type="button" disabled={github.isPending || (requiresTerms && !acceptedTerms)} onClick={() => github.mutate()}>
            <GitHubMark size={16} />
            {github.isPending ? "Redirecting" : "Continue with GitHub"}
          </button>
          {github.error ? <p className="error">{(github.error as Error).message}</p> : null}
          <div className="divider"><span>or with email</span></div>
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
          </label>
          {mode === "signup" ? (
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
            </label>
          ) : null}
          <label>
            Password
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required />
          </label>
          {mode === "signin" ? (
            <button className="link-button forgot-link" type="button" onClick={() => setForgot(true)}>Forgot password?</button>
          ) : null}
          {deviceUserCode ? <p className="hint">Sign in here to approve CLI access for code <code>{formatUserCode(deviceUserCode)}</code>.</p> : null}
          <button className="primary-button" type="submit" disabled={mutation.isPending || (requiresTerms && !acceptedTerms)}>
            <Play size={16} />
            {mutation.isPending ? "Working" : mode === "signup" ? "Create account" : "Open console"}
          </button>
          {mutation.error ? <p className="error">{(mutation.error as Error).message}</p> : null}
        </form>
      )}
    </>
  );
}

function VerificationPending({ email, resend, onUseAnother }: {
  email: string;
  resend: UseMutationResult<{ status: boolean }, Error, void>;
  onUseAnother: () => void;
}) {
  return (
    <section className="auth-panel verification-panel" aria-live="polite">
      <MailCheck size={30} />
      <div className="panel-heading">
        <span>verify your email</span>
        <h1>Check your inbox</h1>
        <p>We sent a verification link to <strong>{email}</strong>. Open it within one hour, then sign in.</p>
      </div>
      {resend.isSuccess ? <p className="success-text">A fresh verification link is on its way.</p> : null}
      {resend.error ? <p className="error" role="alert">{resend.error.message}</p> : null}
      <button className="primary-button" type="button" disabled={resend.isPending} onClick={() => resend.mutate()}>
        <RotateCw size={16} />
        {resend.isPending ? "Sending" : "Resend verification email"}
      </button>
      <button className="link-button" type="button" onClick={onUseAnother}>Use another email</button>
    </section>
  );
}

function verificationCallbackURL(): string {
  const callback = new URL(window.location.href);
  callback.searchParams.delete("error");
  callback.searchParams.set("verified", "true");
  return callback.toString();
}

function verificationErrorMessage(error: string | null): string {
  if (error === "TOKEN_EXPIRED") return "That verification link has expired. Sign in and request a fresh link.";
  if (error) return "That verification link is invalid. Sign in and request a fresh link.";
  return "";
}

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const request = useMutation({
    mutationFn: () => apiFetch<{ status: boolean }>("/v1/auth/request-password-reset", "", {
      method: "POST",
      body: { email, redirectTo: `${window.location.origin}/reset-password` },
    }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    request.mutate();
  }

  return (
    <form className="auth-panel" onSubmit={submit}>
      <div className="panel-heading">
        <span>account recovery</span>
        <h1>Reset your password</h1>
        <p>We will email you a link to choose a new password.</p>
      </div>
      <label>
        Email
        <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
      </label>
      {request.isSuccess ? (
        <p className="success-text">If that email has an account, a reset link is on its way.</p>
      ) : (
        <button className="primary-button" type="submit" disabled={request.isPending}>
          <Send size={16} />
          {request.isPending ? "Sending" : "Send reset link"}
        </button>
      )}
      {request.error ? <p className="error">{(request.error as Error).message}</p> : null}
      <p className="hint">Reset emails only arrive if the operator has configured email delivery on this backend.</p>
      <button className="link-button" type="button" onClick={onBack}>Back to sign in</button>
    </form>
  );
}

export function ResetPasswordPanel({ resetToken, linkError, onDone }: {
  resetToken: string;
  linkError?: string;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const reset = useMutation({
    mutationFn: () => apiFetch<{ status: boolean }>("/v1/auth/reset-password", "", {
      method: "POST",
      body: { newPassword: password, token: resetToken },
    }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    reset.mutate();
  }

  if (!resetToken || linkError) {
    return (
      <section className="narrow-layout">
        <div className="auth-panel">
          <div className="panel-heading">
            <span>account recovery</span>
            <h1>Reset link invalid</h1>
            <p>This password reset link is invalid or has expired. Request a fresh one from the sign-in page.</p>
          </div>
          <button className="primary-button" type="button" onClick={onDone}>
            <Play size={16} />
            Back to sign in
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="narrow-layout">
      <form className="auth-panel" onSubmit={submit}>
        <div className="panel-heading">
          <span>account recovery</span>
          <h1>Choose a new password</h1>
        </div>
        {reset.isSuccess ? (
          <>
            <p className="success-text">Password updated. Sign in with your new password.</p>
            <button className="primary-button" type="button" onClick={onDone}>
              <Play size={16} />
              Go to sign in
            </button>
          </>
        ) : (
          <>
            <label>
              New password
              <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="new-password" required />
            </label>
            <label>
              Confirm password
              <input value={confirm} onChange={(event) => setConfirm(event.target.value)} type="password" autoComplete="new-password" required />
            </label>
            {mismatch ? <p className="error">Passwords do not match.</p> : null}
            {reset.error ? <p className="error">{(reset.error as Error).message}</p> : null}
            <button className="primary-button" type="submit" disabled={reset.isPending}>
              <KeyRound size={16} />
              {reset.isPending ? "Saving" : "Set new password"}
            </button>
          </>
        )}
      </form>
    </section>
  );
}

export function CommandBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command-block">
      <span>{label}</span>
      <code>{value || "-"}</code>
      <button className="icon-button" type="button" title="Copy" aria-label={`Copy ${label}`} onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}>
        <Copy size={15} />
      </button>
      {copied ? <em>copied</em> : null}
    </div>
  );
}
