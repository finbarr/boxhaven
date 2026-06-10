import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useConsole } from "../../console-context";
import { ImagesView } from "../../images";

export const Route = createFileRoute("/_console/images")({
  head: () => ({ meta: [{ title: "Images | BoxHaven" }] }),
  component: ImagesRoute,
});

function ImagesRoute() {
  const { token, isAdmin } = useConsole();
  if (!isAdmin) {
    return (
      <section className="narrow-layout">
        <div className="auth-panel grant-panel">
          <div className="grant-icon"><ShieldAlert size={28} /></div>
          <div className="panel-heading">
            <span>images</span>
            <h1>Admin access required</h1>
            <p>Golden images are managed by backend admins. Ask the operator of this backend if you need a snapshot taken.</p>
          </div>
          <Link className="primary-button" to="/">Back to boxes</Link>
        </div>
      </section>
    );
  }
  return <ImagesView token={token} />;
}
