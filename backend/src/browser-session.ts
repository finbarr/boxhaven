import { apiRequest } from "./client.js";

export function githubCallbackURL(currentURL: string): string {
  const current = new URL(currentURL);
  const callback = new URL("/auth/github", current.origin);
  callback.searchParams.set("returnTo", localAuthDestination(current, current.origin));
  return callback.href;
}

export function githubReturnPath(callbackURL: string): string {
  const callback = new URL(callbackURL);
  try {
    return localAuthDestination(new URL(callback.searchParams.get("returnTo") || "/", callback.origin), callback.origin);
  } catch {
    return "/";
  }
}

function localAuthDestination(destination: URL, origin: string): string {
  if (destination.origin !== origin || ["/auth/github", "/signup", "/reset-password"].includes(destination.pathname.replace(/\/+$/, ""))) return "/";
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

// Verification proves email ownership; it does not sign the user in. Finish
// signing out before either console can restore a different browser account.
export async function prepareEmailVerificationReturn(baseURL: string, tokenKey: string): Promise<void> {
  if (new URLSearchParams(window.location.search).get("verified") !== "true") return;
  await apiRequest(baseURL, "/v1/auth/sign-out", localStorage.getItem(tokenKey) || "", {
    method: "POST",
    body: {},
    credentials: "include",
  });
  localStorage.removeItem(tokenKey);
}

// Once the user signs in, refreshing this page must not sign them out again.
export function clearEmailVerificationResult(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("verified");
  url.searchParams.delete("error");
  window.history.replaceState(window.history.state, "", url);
}
