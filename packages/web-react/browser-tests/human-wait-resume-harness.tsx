// Real question UI. The browser binding substitutes transport only; it calls
// the actual CCB adapter and idle watchdog in the Node-side fixture.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PermissionCard, type PermissionRespond } from "../src/components/chat/PermissionCard";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
import type { ChatMessage } from "../src/lib/chat/model";

declare global {
  interface Window {
    humanWaitMessage: ChatMessage;
    answerHumanWait: (response: Parameters<PermissionRespond>[0]) => Promise<{
      accepted: boolean; trips: boolean; activity: number;
    }>;
  }
}

function Harness() {
  const [result, setResult] = useState("等待作答");
  return <TooltipProvider><ToastProvider>
    <PermissionCard msg={window.humanWaitMessage} livePrompt onRespond={async (response) => {
      try {
        const reply = await window.answerHumanWait(response);
        setResult(reply.accepted && !reply.trips && reply.activity === 1 ? "继续执行" : "超时中断");
      } catch { setResult("投递失败"); }
    }} />
    <output data-testid="human-wait-result">{result}</output>
  </ToastProvider></TooltipProvider>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
