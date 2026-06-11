import { createRootRoute, HeadContent, Link, Outlet } from "@tanstack/react-router";
import { Compass } from "lucide-react";
import { GitHubMark, repoURL, TopBar } from "../shell";

// App shell only: backdrop + topbar slot. Auth lives in the _console layout.
export const Route = createRootRoute({
  head: () => ({
    meta: [{ title: "BoxHaven — Remote dev boxes for AI coding agents" }],
  }),
  component: RootShell,
  notFoundComponent: NotFound,
});

function RootShell() {
  return (
    <>
      <HeadContent />
      <main className="console">
        <div className="backdrop" />
        <div className="console-body">
          <Outlet />
        </div>
        <footer className="site-footer">
          <span>© 2026 BoxHaven</span>
          <nav>
            <a href="https://docs.boxhaven.dev" target="_blank" rel="noreferrer">Docs</a>
            <a href={repoURL} target="_blank" rel="noreferrer"><GitHubMark size={13} /> GitHub</a>
            <a href={`${repoURL}/blob/master/CHANGELOG.md`} target="_blank" rel="noreferrer">Changelog</a>
            <a href={`${repoURL}/blob/master/SECURITY.md`} target="_blank" rel="noreferrer">Security</a>
          </nav>
        </footer>
      </main>
    </>
  );
}

function NotFound() {
  return (
    <>
      <TopBar subtitle="remote dev boxes" />
      <section className="narrow-layout">
        <div className="auth-panel grant-panel">
          <div className="grant-icon"><Compass size={28} /></div>
          <div className="panel-heading">
            <span>404</span>
            <h1>No such room</h1>
            <p>The page you are looking for does not exist in this haven.</p>
          </div>
          <Link className="primary-button" to="/">Back to the console</Link>
        </div>
      </section>
    </>
  );
}
