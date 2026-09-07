// Real Composer; only session selection and sending are stubbed. No backend/user data.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { moveDraft, NEW_COMPOSER_DRAFT_KEY } from "../src/lib/composerDraft";
import { ToastProvider, TooltipProvider } from "../src/components/ui";

function Harness() {
  const [id, setId] = useState("A");
  const [mounted, setMounted] = useState(true);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>();
  const [sent, setSent] = useState("");
  return (
    <TooltipProvider>
      <ToastProvider>
        {["A", "B", "new"].map((key) => (
          <button key={key} onClick={() => setId(key)}>session {key}</button>
        ))}
        <button onClick={() => setMounted((value) => !value)}>toggle composer</button>
        <button onClick={() => {
          moveDraft(NEW_COMPOSER_DRAFT_KEY, "created");
          setId("created");
        }}>materialize new</button>
        <button onClick={() => {
          setId("B");
          setPrefill((old) => ({ text: "explicit B prefill", nonce: (old?.nonce ?? 0) + 1 }));
        }}>prefill B</button>
        <output data-testid="active">{id}</output>
        <output data-testid="sent">{sent}</output>
        {mounted && <Composer
          draftKey={id}
          prefill={prefill}
          lastUserText="previous user message"
          onSend={(text) => {
            setSent(`${id}:${text}`);
            if (id === "new") setId("created");
          }}
        />}
      </ToastProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
