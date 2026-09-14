import { createRoot } from "react-dom/client";
import { useMemo, useState } from "react";
import { createMemoryAuthSession } from "../src/lib/authSession";
import { useDelegateFailures } from "../src/hooks/useDelegateFailures";
import { DelegateFailureInbox, knownFailureParentId } from "../src/components/chat/DelegateFailureInbox";
import { PinnedDelegateTracker } from "../src/components/chat/PinnedDelegateTracker";
import { Button, ToastProvider, TooltipProvider } from "../src/components/ui";

function Harness() {
  const auth = useMemo(() => createMemoryAuthSession(() => {}, "A"), []);
  const [user, setUser] = useState("alice"), [parent, setParent] = useState("");
  const failures = useDelegateFailures(auth, user, true);
  const switchTo = (id: string, token: string) => { auth.commitToken(auth.beginIdentity(), token); setUser(id); };
  return <main className="mx-auto w-full max-w-3xl p-4">
    <Button onClick={() => switchTo("alice", "A")}>切换 A</Button><Button onClick={() => switchTo("bob", "B")}>切换 B</Button>
    <p data-testid="account">{user}</p><p data-testid="parent">{parent}</p>
    <PinnedDelegateTracker items={[{ jobId: "raw-failed", runId: "raw", agentId: "worker", goal: "原始失败诊断", state: "failed", liveHint: "", updatedAt: 1, parentSessionKey: "agent:main:webchat:dm:session-alice" }]}
      onDismiss={() => { throw Error("failure must never locally ACK"); }} onOpenFailures={() => failures.controller?.setOpen(true)} failuresInInbox={failures.state.summary !== null} />
    {failures.controller && <DelegateFailureInbox key={JSON.stringify([user, auth.snapshot().epoch])} state={failures.state} controller={failures.controller}
      onOpenParent={key => { const id = knownFailureParentId(key, [{ id: `session-${user}`, title: "Original", ownerUserId: user, agentId: "main", updatedAt: "", messageCount: 0 }], user);
        if (!id) return false; setParent(id); return true; }} />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<ToastProvider><TooltipProvider><Harness /></TooltipProvider></ToastProvider>);
