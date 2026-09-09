import { createRoot } from "react-dom/client";
import AccountsPage from "../src/admin/pages/accounts";
import { adminSession } from "../src/admin/auth";
import { ToastProvider, TooltipProvider } from "../src/components/ui";

// Local browser fixture only. No production session or account credentials.
adminSession.commitToken(adminSession.snapshot().epoch, "synthetic-sand-browser");
createRoot(document.getElementById("root")!).render(
  <ToastProvider><TooltipProvider><AccountsPage /></TooltipProvider></ToastProvider>,
);
