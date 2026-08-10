import { Link } from "@tanstack/react-router";
import { Building2, Check, ChevronDown, CreditCard, KeyRound, Layers, LogOut, Plus, Server, Users } from "lucide-react";
import { KeyboardEvent as ReactKeyboardEvent, ReactNode, useEffect, useId, useRef, useState } from "react";
import { TeamInfo } from "./api";
import logoURL from "./assets/boxhaven-logo.png";

export const repoURL = "https://github.com/finbarr/boxhaven";
export const docsURL = (import.meta.env.VITE_BOXHAVEN_DOCS_URL || "https://docs.boxhaven.dev").replace(/\/+$/, "");
export const termsURL = "https://boxhaven.dev/terms/";
export const privacyURL = "https://boxhaven.dev/privacy/";
export const isHostedService = typeof window !== "undefined" && window.location.hostname === "app.boxhaven.dev";

export type ConsoleSection = "boxes" | "team" | "teams" | "images" | "account" | "security";

// Authed console frame: a persistent left nav sidebar plus the workspace where
// each section renders its full-width tables. activeSection drives the
// highlighted nav item (so /boxes/$name keeps "Boxes" lit).
export function ConsoleShell({ activeSection, email, teams = [], activeTeam, teamSwitching = false, teamSwitchError = "", account, onTeamSwitch, onNewTeam, onLogout, children }: {
  activeSection: ConsoleSection;
  email?: string;
  teams?: TeamInfo[];
  activeTeam?: TeamInfo;
  teamSwitching?: boolean;
  teamSwitchError?: string;
  account?: { label: string };
  onTeamSwitch?: (teamId: string) => void;
  onNewTeam?: () => void;
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
        {teams.length ? (
          <TeamSwitcher
            teams={teams}
            activeTeam={activeTeam}
            switching={teamSwitching}
            error={teamSwitchError}
            onSwitch={onTeamSwitch}
            onNewTeam={onNewTeam}
          />
        ) : null}
        <nav className="side-links" aria-label="Team">
          <span className="side-section-label">Team</span>
          <Link to="/" className={activeSection === "boxes" ? "active" : undefined}>
            <Server size={17} />
            Boxes
          </Link>
          <Link to="/team" className={activeSection === "team" ? "active" : undefined}>
            <Users size={17} />
            Members
          </Link>
          <Link to="/images" className={activeSection === "images" ? "active" : undefined}>
            <Layers size={17} />
            Images
          </Link>
        </nav>
        <nav className="side-links" aria-label="Global">
          <span className="side-section-label">Global</span>
          <Link to="/teams" className={activeSection === "teams" ? "active" : undefined}>
            <Building2 size={17} />
            Teams
          </Link>
          <Link to="/security" className={activeSection === "security" ? "active" : undefined}>
            <KeyRound size={17} />
            Security
          </Link>
          {account ? (
            <Link to="/account" className={activeSection === "account" ? "active" : undefined}>
              <CreditCard size={17} />
              {account.label}
            </Link>
          ) : null}
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
        </div>
      </aside>
      <div className="workspace">{children}</div>
    </div>
  );
}

function TeamSwitcher({ teams, activeTeam, switching, error, onSwitch, onNewTeam }: {
  teams: TeamInfo[];
  activeTeam?: TeamInfo;
  switching: boolean;
  error: string;
  onSwitch?: (teamId: string) => void;
  onNewTeam?: () => void;
}) {
  const selected = activeTeam?.id || teams[0]?.id || "";
  const selectedTeam = teams.find((team) => team.id === selected) || teams[0];
  const selectedIndex = Math.max(0, teams.findIndex((team) => team.id === selected));
  const [open, setOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusWhenOpen = useRef(selectedIndex);
  const menuID = useId();
  const labelID = useId();
  const teamNameID = useId();

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      menuItemRefs.current[focusWhenOpen.current]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!switcherRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (switching) setOpen(false);
  }, [switching]);

  function openMenu(itemIndex = selectedIndex) {
    focusWhenOpen.current = itemIndex;
    setOpen(true);
  }

  function closeMenu(returnFocus = false) {
    setOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = menuItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  return (
    <div className="side-team">
      <div
        className="side-team-switcher"
        ref={switcherRef}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <span className="side-team-label" id={labelID}>Active team</span>
        <button
          className="side-team-trigger"
          type="button"
          ref={triggerRef}
          disabled={switching}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuID}
          aria-labelledby={`${labelID} ${teamNameID}`}
          onClick={() => {
            if (open) closeMenu();
            else openMenu();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              openMenu(selectedIndex);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              openMenu(teams.length);
            }
          }}
        >
          <span className="side-team-trigger-name" id={teamNameID}>{selectedTeam?.name || "Team"}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        {open ? (
          <div className="side-team-menu" id={menuID} role="menu" aria-label="Teams" onKeyDown={handleMenuKeyDown}>
            <div className="side-team-menu-list" role="none">
              {teams.map((team, index) => {
                const active = team.id === selected;
                return (
                  <button
                    className={active ? "side-team-menu-item active" : "side-team-menu-item"}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    tabIndex={-1}
                    key={team.id}
                    ref={(item) => { menuItemRefs.current[index] = item; }}
                    onClick={() => {
                      closeMenu(true);
                      onSwitch?.(team.id);
                    }}
                  >
                    <span>{team.name}</span>
                    {active ? <Check size={16} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
            <div className="side-team-menu-separator" role="separator" />
            <div className="side-team-menu-action" role="none">
              <button
                className="side-team-menu-item"
                type="button"
                role="menuitem"
                tabIndex={-1}
                ref={(item) => { menuItemRefs.current[teams.length] = item; }}
                onClick={() => {
                  closeMenu();
                  onNewTeam?.();
                }}
              >
                <Plus size={16} aria-hidden="true" />
                <span>New team</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {error ? <p className="error side-team-error" role="alert">{error}</p> : null}
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
