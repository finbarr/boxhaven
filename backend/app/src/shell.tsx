import { Link } from "@tanstack/react-router";
import { CreditCard, Layers, LogOut, Server, Users } from "lucide-react";
import { ReactNode } from "react";
import logoURL from "./assets/boxhaven-logo.png";

export const repoURL = "https://github.com/finbarr/boxhaven";

export type ConsoleSection = "boxes" | "team" | "images" | "billing";

// Authed console frame: a persistent left nav sidebar plus the workspace where
// each section renders its full-width tables. activeSection drives the
// highlighted nav item (so /boxes/$name keeps "Boxes" lit).
export function ConsoleShell({ activeSection, isAdmin, email, onLogout, children }: {
  activeSection: ConsoleSection;
  isAdmin: boolean;
  email?: string;
  onLogout: () => void;
  children: ReactNode;
}) {
  return (
    <div className="console-shell">
      <aside className="side-nav">
        <Link className="brand side-brand" to="/" aria-label="BoxHaven home">
          <div className="brand-mark"><img src={logoURL} alt="" /></div>
          <strong>BoxHaven</strong>
        </Link>
        <nav className="side-links">
          <Link to="/" className={activeSection === "boxes" ? "active" : undefined}>
            <Server size={17} />
            Boxes
          </Link>
          <Link to="/team" className={activeSection === "team" ? "active" : undefined}>
            <Users size={17} />
            Team
          </Link>
          {isAdmin ? (
            <Link to="/images" className={activeSection === "images" ? "active" : undefined}>
              <Layers size={17} />
              Images
            </Link>
          ) : null}
          <Link to="/billing" className={activeSection === "billing" ? "active" : undefined}>
            <CreditCard size={17} />
            Billing
          </Link>
        </nav>
        <div className="side-foot">
          <div className="side-account">
            <span>signed in</span>
            <strong>{email || "account"}</strong>
          </div>
          <button className="side-logout" type="button" onClick={onLogout}>
            <LogOut size={16} />
            Log out
          </button>
          <a className="side-repo" href={repoURL} target="_blank" rel="noreferrer">
            <GitHubMark size={14} />
            GitHub
          </a>
        </div>
      </aside>
      <div className="workspace">{children}</div>
    </div>
  );
}

// Standard header for a workspace section: eyebrow + title on the left,
// action buttons (refresh, "+ Add") on the right.
export function WorkspaceHead({ eyebrow, title, actions }: {
  eyebrow: string;
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="workspace-head">
      <div className="workspace-title">
        <span>{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {actions ? <div className="workspace-actions">{actions}</div> : null}
    </div>
  );
}

// lucide dropped brand icons; this is the standard GitHub mark.
export function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

// Shared topbar slot rendered inside the root shell. Routes fill in their own
// subtitle, section nav, and actions (e.g. the console's tabs + logout).
export function TopBar({ subtitle, nav, actions }: {
  subtitle: string;
  nav?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="topbar">
      <Link className="brand" to="/" aria-label="BoxHaven home">
        <div className="brand-mark"><img src={logoURL} alt="" /></div>
        <div>
          <strong>BoxHaven</strong>
          <span>{subtitle}</span>
        </div>
      </Link>
      {nav}
      <div className="topbar-actions">
        <a className="icon-button" href={repoURL} target="_blank" rel="noreferrer" title="BoxHaven on GitHub" aria-label="BoxHaven on GitHub">
          <GitHubMark size={16} />
        </a>
        {actions}
      </div>
    </header>
  );
}
