import { useMutation } from "@tanstack/react-query";
import { ArrowDown, ArrowUpRight, CheckCircle2, Copy, KeyRound, Play, Send } from "lucide-react";
import { FormEvent, useState } from "react";
import { apiFetch, formatUserCode, LoginResponse } from "./api";
import { GitHubMark, repoURL } from "./shell";

export const installCommand = "curl -fsSL https://raw.githubusercontent.com/finbarr/boxhaven/master/install.sh | sh";

export function AccessPanel({ onToken, deviceUserCode, notice }: {
  onToken: (token: string) => void;
  deviceUserCode?: string;
  notice?: string;
}) {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [forgot, setForgot] = useState(false);
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
  const mutation = useMutation({
    mutationFn: async () => {
      const endpoint = mode === "signup" ? "/v1/auth/sign-up/email" : "/v1/auth/sign-in/email";
      return apiFetch<LoginResponse>(endpoint, "", {
        method: "POST",
        body: {
          email,
          password,
          ...(mode === "signup" ? { name: name || email.split("@")[0] } : {}),
        },
      });
    },
    onSuccess: (data) => onToken(data.token),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <section className="access-layout">
      <LandingIntro />
      {forgot ? (
        <ForgotPasswordForm onBack={() => setForgot(false)} />
      ) : (
        <form id="signup" className="auth-panel signup-panel" onSubmit={submit}>
          <div className="panel-heading">
            <span>{mode === "signup" ? "hosted beta" : "welcome back"}</span>
            <h1>{mode === "signup" ? "Sign up for hosted BoxHaven" : "Open the console"}</h1>
            {mode === "signup" ? <p>Start on the managed control plane now. Self-host the same open-source code whenever you want.</p> : null}
          </div>
          {notice ? <p className="hint">{notice}</p> : null}
          <div className="segmented">
            <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Sign up</button>
            <button type="button" className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")}>Sign in</button>
          </div>
          <button className="github-button" type="button" disabled={github.isPending} onClick={() => github.mutate()}>
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
          <button className="primary-button" type="submit" disabled={mutation.isPending}>
            <Play size={16} />
            {mutation.isPending ? "Working" : mode === "signup" ? "Create account" : "Open console"}
          </button>
          {mutation.error ? <p className="error">{(mutation.error as Error).message}</p> : null}
        </form>
      )}
    </section>
  );
}

function LandingIntro() {
  return (
    <div className="landing-page">
      <section className="landing-hero">
        <div className="landing-kicker">Open-source devbox management</div>
        <h1>Dev boxes that keep working after you disconnect.</h1>
        <p>
          Spin up persistent Linux boxes, sync your projects, and run coding agents in tmux sessions
          you can reconnect to from anywhere. Hosted or self-hosted from the same open-source code.
        </p>
        <div className="landing-actions">
          <a className="primary-button" href="#signup">
            <ArrowDown size={16} />
            Sign up for hosted
          </a>
          <a className="secondary-button" href={repoURL} target="_blank" rel="noreferrer">
            <GitHubMark size={16} />
            View source
          </a>
          <a className="secondary-button" href="https://docs.boxhaven.dev/self-hosting" target="_blank" rel="noreferrer">
            Self-hosting docs
            <ArrowUpRight size={15} />
          </a>
        </div>
      </section>

      <section className="landing-paths" aria-label="Hosted and self-hosted options">
        <div className="landing-path">
          <span>Hosted</span>
          <h2>Create your first box in seconds.</h2>
          <p>We run the control plane and the cloud account. Sign up and start working with no backend to operate.</p>
        </div>
        <div className="landing-path">
          <span>Self-hosted</span>
          <h2>Bring your own infrastructure.</h2>
          <p>Backend, CLI, VM runtime, and deploy scripts are all open source. Plug in your DigitalOcean or Hetzner credentials.</p>
        </div>
      </section>

      <section className="landing-proof">
        <div className="landing-proof-copy">
          <span>Workflow</span>
          <h2>Your agents keep running while you're away.</h2>
          <ul>
            <li><CheckCircle2 size={16} /> Sync a project into a named dev box.</li>
            <li><CheckCircle2 size={16} /> Start Claude, Codex, or a shell in a managed tmux session.</li>
            <li><CheckCircle2 size={16} /> Reconnect later with SSH, tmux history, and GitHub auth ready.</li>
          </ul>
        </div>
        <div className="terminal-card">
          <div className="terminal-title">
            <span />
            <span />
            <span />
          </div>
          <pre>{`$ bh login
$ bh create work
box "work" ready
$ bh run work claude
claude is running in tmux
# disconnect; the agent keeps running
$ bh connect work
attached to "work"`}</pre>
        </div>
      </section>

      <section className="landing-install">
        <CommandBlock label="Install" value={installCommand} />
        <a className="landing-docs" href="https://docs.boxhaven.dev" target="_blank" rel="noreferrer">
          Read the docs
          <ArrowUpRight size={14} />
        </a>
      </section>
    </div>
  );
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
