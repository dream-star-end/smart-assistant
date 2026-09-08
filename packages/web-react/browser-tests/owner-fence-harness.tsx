// Isolated Composer owner-fence harness. No backend, no live user data.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import {
  accountDraftKey,
  NEW_COMPOSER_DRAFT_KEY,
  teardownComposerDrafts,
} from "../src/lib/composerDraft";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
import type { MediaRef } from "../src/lib/chat/frames";

function Harness() {
  const [id, setId] = useState("A");
  const [account, setAccount] = useState("user-a");
  const [sent, setSent] = useState("");
  const draftKey = accountDraftKey(id, account);
  return (
    <TooltipProvider>
      <ToastProvider>
        {["A", "B"].map((key) => (
          <button key={key} onClick={() => setId(key)}>
            session {key}
          </button>
        ))}
        <button
          onClick={() => {
            teardownComposerDrafts(account);
            setAccount("user-b");
            setId(NEW_COMPOSER_DRAFT_KEY);
          }}
        >
          switch account
        </button>
        <output data-testid="active">{id}</output>
        <output data-testid="account">{account}</output>
        <output data-testid="sent">{sent}</output>
        <Composer
          draftKey={draftKey}
          onSend={(text, media) => {
            setSent(`${id}:${text}:${(media ?? []).map((m) => m.url).join(",")}`);
          }}
          onUpload={async (file): Promise<MediaRef> => ({
            kind: "file",
            url: `/stub/${file.name}`,
          })}
        />
      </ToastProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
