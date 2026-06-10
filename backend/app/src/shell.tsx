import { Activity } from "lucide-react";
import { ReactNode } from "react";
import logoURL from "./assets/boxhaven-logo.png";

// Shared topbar slot rendered inside the root shell. Routes fill in their own
// subtitle, section nav, and actions (e.g. the console's tabs + logout).
export function TopBar({ subtitle, nav, actions }: {
  subtitle: string;
  nav?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><img src={logoURL} alt="" /></div>
        <div>
          <strong>BoxHaven</strong>
          <span>{subtitle}</span>
        </div>
      </div>
      {nav}
      <div className="topbar-actions">
        <span className="pulse"><Activity size={14} /> API</span>
        {actions}
      </div>
    </header>
  );
}
