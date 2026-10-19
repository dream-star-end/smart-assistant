import { lazy } from "react";
import { readLocationRoute } from "../hooks/useAppRoute";
import type { AuthSession } from "../lib/types";
import { BootSplash } from "./BootSplash";
import { LazyBoundary } from "./ChunkErrorBoundary";

const loadDesktopEnrollPage = () => import("./DesktopEnrollPageContent");
const DesktopEnrollPageContent = lazy(() =>
  loadDesktopEnrollPage().then((m) => ({ default: m.DesktopEnrollPage })),
);

// The enrollment link can download its UI while authentication is in progress.
// Other routes leave this chunk unloaded; use the same route parser as App.
if (typeof window !== "undefined" && readLocationRoute(window.location).desktopEnroll) {
  void loadDesktopEnrollPage().catch(() => {});
}

export function DesktopEnrollPage({ auth }: { auth: AuthSession }) {
  return (
    <LazyBoundary fallback={<BootSplash />}>
      <DesktopEnrollPageContent auth={auth} />
    </LazyBoundary>
  );
}
