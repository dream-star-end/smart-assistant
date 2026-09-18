import { createRoot } from "react-dom/client";
import { ApiKeysSection } from "../src/components/settings/ApiKeysSection";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
import { createMemoryAuthSession } from "../src/lib/authSession";

// Only authentication data is synthetic; component, api.ts and browser fetch are real.
const auth = createMemoryAuthSession(() => {
  throw new Error("Unexpected fixture auth expiration");
}, "ocv5-180-browser-fixture-token");

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <TooltipProvider>
      <ApiKeysSection auth={auth} />
    </TooltipProvider>
  </ToastProvider>,
);
