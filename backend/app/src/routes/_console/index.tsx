import { createFileRoute, redirect } from "@tanstack/react-router";
import { Dashboard } from "../../dashboard";

// Boxes dashboard with nothing selected. Also absorbs two legacy URL shapes
// the backend still emits: /?section=... (Stripe checkout/portal return URLs)
// and /?user_code=... (defensive device-grant deep links).
export const Route = createFileRoute("/_console/")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.section === "string" ? { section: search.section } : {}),
    ...(typeof search.user_code === "string" ? { user_code: search.user_code } : {}),
    ...(typeof search.code === "string" ? { code: search.code } : {}),
  }),
  beforeLoad: ({ search }) => {
    const userCode = (search.user_code || search.code || "").trim();
    if (userCode) throw redirect({ to: "/device", search: { user_code: userCode } });
    if (search.section === "billing") throw redirect({ to: "/billing" });
    if (search.section === "team") throw redirect({ to: "/team" });
    if (search.section === "images") throw redirect({ to: "/images" });
  },
  head: () => ({ meta: [{ title: "Boxes | BoxHaven" }] }),
  component: () => <Dashboard />,
});
