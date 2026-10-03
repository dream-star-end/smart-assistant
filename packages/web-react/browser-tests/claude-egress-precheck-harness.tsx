import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountFormModal } from "../src/admin/pages/accounts/AccountFormModal";
import { adminSession } from "../src/admin/auth";
import { ToastProvider, TooltipProvider } from "../src/components/ui";

// Test DB identity only; real adminApi sends this JWT through the real middleware.
const token = (window as unknown as { __fixtureJwt: string }).__fixtureJwt;
const epoch = adminSession.beginIdentity();
if (!adminSession.commitToken(epoch, token)) throw new Error("fixture identity rejected");
function Harness() {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState(0);
  return <ToastProvider><TooltipProvider>
    <AccountFormModal open={open} onOpenChange={setOpen} mode="create" onSaved={() => setSaved((n) => n + 1)} />
    <output data-testid="account-saved">{saved}</output>
  </TooltipProvider></ToastProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
