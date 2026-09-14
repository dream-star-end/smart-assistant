import { createRoot } from "react-dom/client";
import { useMemo, useState } from "react";
import { createMemoryAuthSession } from "../src/lib/authSession";
import { useDelegateFailures } from "../src/hooks/useDelegateFailures";
import { DelegateFailureInbox, knownFailureParentId, sessionFailureDiagnostics } from "../src/components/chat/DelegateFailureInbox";
import { PinnedDelegateTracker } from "../src/components/chat/PinnedDelegateTracker";
import { Button, ToastProvider, TooltipProvider } from "../src/components/ui";

function Harness() {
  const auth = useMemo(() => createMemoryAuthSession(() => {}, "A"), []);
  const [user, setUser] = useState("alice"), [parent, setParent] = useState("");
  const failures = useDelegateFailures(auth, user, true);
  const switchTo = (id: string, token: string) => { auth.commitToken(auth.beginIdentity(), token); setUser(id); };
  const items = [{ jobId: `raw-failed-${user}`, runId: "raw", agentId: "worker", goal: `原始${user}失败诊断`, state: "failed" as const, liveHint: "", updatedAt: 1, parentSessionKey: `agent:main:webchat:dm:session-${user}` }];
  const overlap = new URLSearchParams(location.search).get("diagnosticJob");
  if (overlap && user === "alice") items.push({ ...items[0], jobId: overlap, goal: "已归档失败诊断" });
  const diagnostics = failures.controller ? sessionFailureDiagnostics(items) : [];
  return <main className="mx-auto w-full max-w-3xl p-4">
    <Button onClick={() => switchTo("alice", "A")}>切换 A</Button><Button onClick={() => switchTo("bob", "B")}>切换 B</Button>
    <Button onClick={() => void failures.controller?.refresh()}>刷新后台状态</Button>
    <p data-testid="account">{user}</p><p data-testid="parent">{parent}</p>
    <PinnedDelegateTracker items={items}
      onDismiss={() => { throw Error("failure must never locally ACK"); }} onOpenFailures={() => failures.controller?.setOpen(true)} diagnosticJobIds={diagnostics.map(item => item.jobId)} />
    {failures.controller && <DelegateFailureInbox key={JSON.stringify([user, auth.snapshot().epoch])} state={failures.state} controller={failures.controller} diagnostics={diagnostics}
      onOpenParent={key => { const id = knownFailureParentId(key, [{ id: `session-${user}`, title: "Original", ownerUserId: user, agentId: "main", updatedAt: "", messageCount: 0 }], user);
        if (!id) return false; setParent(id); return true; }} />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<ToastProvider><TooltipProvider><Harness /></TooltipProvider></ToastProvider>);
