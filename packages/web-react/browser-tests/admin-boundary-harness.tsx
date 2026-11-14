// INC-20261009-ADMIN-BOUNDARY-STICKY harness: the real AdminShell with its real registry and hash
// router. The admin API answers 503 for everything (pages show their own error state). The test
// bundles one page module as a component that throws during render (the recorded failure).
import { createRoot } from "react-dom/client";
import { AdminShell } from "../src/admin/AdminShell";
import { adminSession } from "../src/admin/auth";
import { ToastProvider, TooltipProvider } from "../src/components/ui";

const epoch = adminSession.beginIdentity();
if (!adminSession.commitToken(epoch, "synthetic-admin-token")) throw new Error("fixture identity rejected");
window.fetch = async () => new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "fixture" } }),
  { status: 503, headers: { "content-type": "application/json" } });
createRoot(document.getElementById("root")!).render(
  <ToastProvider><TooltipProvider><AdminShell user={null} onLogout={() => {}} /></TooltipProvider></ToastProvider>);
