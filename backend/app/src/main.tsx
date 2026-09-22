import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { prepareEmailVerificationReturn } from "../../src/browser-session";
import { apiBaseURL, tokenKey } from "./api";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

const queryClient = new QueryClient();

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = createRoot(document.getElementById("root") as HTMLElement);
void prepareEmailVerificationReturn(apiBaseURL, tokenKey).then(() => {
  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}).catch(() => {
  root.render(<main className="narrow-layout"><section className="auth-panel">
    <p role="alert">Could not sign out of the previous account. Try again to finish email verification.</p>
    <button className="primary-button" onClick={() => window.location.reload()}>Try again</button>
  </section></main>);
});
