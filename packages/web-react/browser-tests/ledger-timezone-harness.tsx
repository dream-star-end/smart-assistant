import { createRoot } from "react-dom/client";
import { AccountTab } from "../src/components/settings/AccountTab";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
import { createMemoryAuthSession } from "../src/lib/authSession";
import type { User } from "../src/lib/types";

// #1237: only auth/user are synthetic; AccountTab, labels.ts, api.ts and browser fetch are real.
const auth = createMemoryAuthSession(() => {
  throw new Error("Unexpected fixture auth expiration");
}, "ledger-tz-browser-fixture-token");
const user = { id: "1620", email: "fixture@example.invalid", credits: "198267" } as unknown as User;

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <TooltipProvider>
      <AccountTab auth={auth} user={user} onManageSub={() => {}} reloadKey={0} />
    </TooltipProvider>
  </ToastProvider>,
);
