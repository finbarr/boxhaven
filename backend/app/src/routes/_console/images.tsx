import { createFileRoute } from "@tanstack/react-router";
import { useConsole } from "../../console-context";
import { ImagesView } from "../../images";

export const Route = createFileRoute("/_console/images")({
  head: () => ({ meta: [{ title: "Images | BoxHaven" }] }),
  component: ImagesRoute,
});

function ImagesRoute() {
  const { token } = useConsole();
  return <ImagesView token={token} />;
}
