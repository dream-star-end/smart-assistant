// Isolated Composer owner-fence harness. No backend, no live user data.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer, moveComposerAttachments, resetComposerAttachmentCache } from "../src/components/Composer";
import {
  accountDraftKey,
  moveDraft,
  NEW_COMPOSER_DRAFT_KEY,
  teardownComposerDrafts,
} from "../src/lib/composerDraft";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
import type { MediaRef } from "../src/lib/chat/frames";

let pendingUpload: ((media: MediaRef) => void) | null = null;

function Harness() {
  const [id, setId] = useState("A");
  const [account, setAccount] = useState("user-a");
  const [sent, setSent] = useState("");
  const [delayUpload, setDelayUpload] = useState(false);
  const draftKey = accountDraftKey(id, account);
  return (
    <TooltipProvider>
      <ToastProvider>
        {["A", "B", "new", "existing-other"].map((key) => (
          <button key={key} onClick={() => setId(key)}>
            session {key}
          </button>
        ))}
        <button
          onClick={() => {
            const from = accountDraftKey(NEW_COMPOSER_DRAFT_KEY, account);
            const to = accountDraftKey("created", account);
            moveDraft(from, to);
            moveComposerAttachments(from, to);
            setId("created");
          }}
        >
          materialize new
        </button>
        <button
          onClick={() => {
            teardownComposerDrafts(account);
            resetComposerAttachmentCache();
            setAccount("user-b");
            setId(NEW_COMPOSER_DRAFT_KEY);
          }}
        >
          switch account
        </button>
        <button onClick={() => setDelayUpload((value) => !value)}>
          {delayUpload ? "delay on" : "delay off"}
        </button>
        <button
          onClick={() => {
            pendingUpload?.({ kind: "file", url: "/stub/late.txt" });
            pendingUpload = null;
          }}
        >
          finish upload
        </button>
        <output data-testid="active">{id}</output>
        <output data-testid="account">{account}</output>
        <output data-testid="sent">{sent}</output>
        <Composer
          draftKey={draftKey}
          onSend={(text, media) => {
            setSent(`${id}:${text}:${(media ?? []).map((m) => m.url).join(",")}`);
          }}
          onUpload={async (file): Promise<MediaRef> => {
            if (delayUpload) {
              return new Promise((resolve) => {
                pendingUpload = resolve;
              });
            }
            return { kind: "file", url: `/stub/${file.name}` };
          }}
        />
      </ToastProvider>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
