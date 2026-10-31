// OCV5-695: real Composer; only the parent's send pipeline is stubbed. onSend stays pending for
// SEND_DELAY_MS (fee check / session setup / network in the real App), then the turn starts.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { ToastProvider, TooltipProvider } from "../src/components/ui";

const SEND_DELAY_MS = 1500;
const log = ((window as unknown as { __log: string[] }).__log = []);

function Harness() {
  const [busy, setBusy] = useState(new URLSearchParams(location.search).has("busy"));
  return (
    <TooltipProvider>
      <ToastProvider>
        <Composer
          busy={busy}
          onStop={() => { log.push("stop"); setBusy(false); }}
          onSend={(text) => {
            log.push(`send:${text}`);
            return new Promise<boolean>((done) => setTimeout(() => { setBusy(true); done(true); }, SEND_DELAY_MS));
          }}
        />
      </ToastProvider>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
