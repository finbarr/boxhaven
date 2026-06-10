import { useMutation } from "@tanstack/react-query";
import { Copy, Play } from "lucide-react";
import { FormEvent, useState } from "react";
import { apiFetch, formatUserCode, LoginResponse } from "./api";
import logoURL from "./assets/boxhaven-logo.png";

export function AccessPanel({ onToken, deviceUserCode, notice }: {
  onToken: (token: string) => void;
  deviceUserCode?: string;
  notice?: string;
}) {
  const [mode, setMode] = useState<"signin" | "signup">("signup");
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
      <div className="welcome-panel">
        <div className="logo-stage"><img src={logoURL} alt="BoxHaven logo" /></div>
        <div className="terminal-card">
          <div className="terminal-title">
            <span />
            <span />
            <span />
          </div>
          <pre>{`$ bh list
NAME      SIZE              STATUS
porch     s-2vcpu-4gb-amd  ready
attic     s-4vcpu-8gb-amd  running`}</pre>
        </div>
      </div>
      <form className="auth-panel" onSubmit={submit}>
        <div className="panel-heading">
          <span>{mode === "signup" ? "new account" : "welcome back"}</span>
          <h1>{mode === "signup" ? "Bring a box home" : "Open the haven"}</h1>
        </div>
        {notice ? <p className="hint">{notice}</p> : null}
        <div className="segmented">
          <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Sign up</button>
          <button type="button" className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")}>Sign in</button>
        </div>
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
        {deviceUserCode ? <p className="hint">Sign in here to approve CLI access for code <code>{formatUserCode(deviceUserCode)}</code>.</p> : null}
        <button className="primary-button" type="submit" disabled={mutation.isPending}>
          <Play size={16} />
          {mutation.isPending ? "Working" : mode === "signup" ? "Create account" : "Open console"}
        </button>
        {mutation.error ? <p className="error">{(mutation.error as Error).message}</p> : null}
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
