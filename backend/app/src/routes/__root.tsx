import { useQuery } from "@tanstack/react-query";
import { createRootRoute, HeadContent, Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { ArrowUpRight, Compass } from "lucide-react";
import { apiFetch, VersionResponse } from "../api";
import { docsURL, GitHubMark, isHostedService, privacyURL, repoURL, termsURL, TopBar } from "../shell";

// App shell only: backdrop + topbar slot. Auth lives in the _console layout.
export const Route = createRootRoute({
  head: () => ({
    meta: [{ title: "BoxHaven Console" }],
  }),
  component: RootShell,
  notFoundComponent: NotFound,
});

function RootShell() {
  const matchRoute = useMatchRoute();
  const onDevice = Boolean(matchRoute({ to: "/device" }));
  const version = useQuery({
    queryKey: ["boxhaven-version"],
    enabled: !isHostedService && !onDevice,
    retry: false,
    staleTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    queryFn: () => apiFetch<VersionResponse>("/v1/version"),
  });
  const update = version.data?.update_available && version.data.latest_version
    ? {
        version: version.data.latest_version,
        url: version.data.release_url || `${repoURL}/releases`,
      }
    : undefined;

  return (
    <>
      <HeadContent />
      <main className="console">
        <div className="backdrop" />
        <div className="console-body">
          {update ? <UpdateBanner version={update.version} url={update.url} /> : null}
          <Outlet />
        </div>
        {onDevice ? null : (
          <footer className="site-footer">
            <span>© 2026 BoxHaven</span>
            <nav>
              {isHostedService ? <a href={termsURL}>Terms</a> : null}
              {isHostedService ? <a href={privacyURL}>Privacy</a> : null}
              <a href={docsURL} target="_blank" rel="noreferrer">Docs</a>
              <a href={repoURL} target="_blank" rel="noreferrer"><GitHubMark size={13} /> GitHub</a>
              <a href={`${repoURL}/blob/master/LICENSE`} target="_blank" rel="noreferrer">AGPL-3.0</a>
              <a href={`${repoURL}/blob/master/CHANGELOG.md`} target="_blank" rel="noreferrer">Changelog</a>
              <a href={`${repoURL}/blob/master/SECURITY.md`} target="_blank" rel="noreferrer">Security</a>
            </nav>
          </footer>
        )}
      </main>
    </>
  );
}

function UpdateBanner({ version, url }: { version: string; url: string }) {
  return (
    <aside className="update-banner" role="status" aria-label="BoxHaven update available">
      <span><strong>BoxHaven {version}</strong> is available.</span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`View the BoxHaven ${version} release in a new tab`}
      >
        View release
        <ArrowUpRight size={15} aria-hidden="true" />
      </a>
    </aside>
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
            <p>The page you are looking for does not exist in this console.</p>
          </div>
          <Link className="primary-button" to="/">Back to the console</Link>
        </div>
      </section>
    </>
  );
}
