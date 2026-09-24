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
  // Auth callbacks must not replay stale verification or error markers.
  destination.searchParams.delete("verified");
  destination.searchParams.delete("error");
  destination.searchParams.delete("mode");
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

// Better Auth creates a session cookie on the API origin after verification.
// Replace any stale console bearer token with that cookie's session before
// mounting either console, so a previously open account cannot win the race.
export async function prepareEmailVerificationReturn(baseURL: string, tokenKey: string): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  if (query.get("verified") !== "true") return;
  localStorage.removeItem(tokenKey);
  if (query.has("error")) return;
  const result = await apiRequest<{ session?: { token?: string } } | null>(baseURL, "/v1/auth/get-session", "", {
    credentials: "include",
  });
  const token = result?.session?.token;
  if (!token) throw new Error("Email verification did not produce a sign-in session");
  localStorage.setItem(tokenKey, token);
  clearEmailVerificationResult();
}

// Refreshing the destination must keep the session without repeating the callback.
export function clearEmailVerificationResult(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("verified");
  url.searchParams.delete("error");
  window.history.replaceState(window.history.state, "", url);
}
