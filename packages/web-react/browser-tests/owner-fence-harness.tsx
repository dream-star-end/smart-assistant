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
import { TicketListView } from "../src/components/taskboard/TicketListView";
import type { MediaRef } from "../src/lib/chat/frames";

const pendingUploads: Array<{ name: string; resolve: (media: MediaRef) => void }> = [];
let promotions = 0;

function Harness() {
  const [id, setId] = useState("A");
  const [account, setAccount] = useState("user-a");
  const [sent, setSent] = useState("");
  const [delayUpload, setDelayUpload] = useState(false);
  const draftKey = accountDraftKey(id, account);
  return (
    <TooltipProvider>
      <ToastProvider>
        {["A", "B", "new", "existing-other", "created", "created-2"].map((key) => (
          <button key={key} onClick={() => setId(key)}>
            session {key}
          </button>
        ))}
        <button
          onClick={() => {
            const from = accountDraftKey(NEW_COMPOSER_DRAFT_KEY, account);
            const promoted = ++promotions === 1 ? "created" : `created-${promotions}`;
            const to = accountDraftKey(promoted, account);
            moveDraft(from, to);
            moveComposerAttachments(from, to);
            setId(promoted);
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
            const pending = pendingUploads.shift();
            pending?.resolve({ kind: "file", url: `/stub/${pending.name}` });
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
                pendingUploads.push({ name: file.name, resolve });
              });
            }
            return { kind: "file", url: `/stub/${file.name}` };
          }}
        />
      </ToastProvider>
    </TooltipProvider>
  );
}

function FilteredPageHarness() {
  const [loaded, setLoaded] = useState(200);
  return <TooltipProvider><output data-testid="loaded-raw">{loaded}</output>
    <TicketListView tickets={[]} query={{ type: 'bug' }} onQueryChange={() => {}}
      total={201} loadedCount={loaded} onLoadMore={() => setLoaded(201)} hideFilters />
  </TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).has('pagination') ? <FilteredPageHarness /> : <Harness />,
);
