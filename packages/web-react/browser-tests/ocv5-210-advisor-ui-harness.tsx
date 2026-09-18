import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MAIN_AGENT } from "../src/lib/agents";
import { AgentPicker } from "../src/components/AgentPicker";
import { ChatHeader } from "../src/components/ChatHeader";
import {
  type CollabMode,
  type CollabUiState,
  EMPTY_COLLAB_UI,
  isStaleCollabEpoch,
  sendCollabFields,
} from "../src/lib/collaborationConfig";
import type { PublicModel } from "../src/lib/types";

const MODELS: PublicModel[] = [
  { id: "glm-5.2", display_name: "GLM-5.2" },
  { id: "gpt-6-astra", display_name: "GPT-6-Astra" },
];

function Harness() {
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState("sess-a");
  const [collab, setCollab] = useState<CollabUiState>({
    ...EMPTY_COLLAB_UI,
    mode: "solo",
  });
  const epochRef = useRef(0);
  const [lastSend, setLastSend] = useState("none");
  const [blocked, setBlocked] = useState("");
  const [mainModel, setMainModel] = useState("glm-5.2");
  const [agentId, setAgentId] = useState("main");

  async function loadSession(id: string) {
    const started = ++epochRef.current;
    document.documentElement.dataset.collabEpoch = String(started);
    setSessionId(id);
    const res = await fetch(`/api/collaboration-config?sessionId=${encodeURIComponent(id)}`);
    const doc = await res.json();
    if (isStaleCollabEpoch(started, epochRef.current)) {
      return;
    }
    setCollab({
      rev: doc.rev,
      mode: doc.session.mode,
      advisorModel: doc.session.advisorModel,
      configVersion: doc.session.configVersion,
      source: doc.session.source,
      advisorModels: doc.advisorModels ?? [],
      advisorUnavailableReason: doc.advisorUnavailableReason,
    });
  }

  async function choose(mode: CollabMode) {
    const started = ++epochRef.current;
    document.documentElement.dataset.collabEpoch = String(started);
    setCollab((cur) => ({ ...cur, mode }));
    const res = await fetch("/api/collaboration-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, mode, expectedRev: collab.rev }),
    });
    if (res.status === 409) {
      const fresh = await fetch(`/api/collaboration-config?sessionId=${encodeURIComponent(sessionId)}`).then((r) =>
        r.json(),
      );
      setBlocked("配置已被更新，请确认后再选一次");
      setCollab({
        rev: fresh.rev,
        mode: fresh.session.mode,
        advisorModel: fresh.session.advisorModel,
        configVersion: fresh.session.configVersion,
        source: fresh.session.source,
        advisorModels: fresh.advisorModels ?? [],
      });
      return;
    }
    const doc = await res.json();
    if (isStaleCollabEpoch(started, epochRef.current)) return;
    setCollab({
      rev: doc.rev,
      mode: doc.session.mode,
      advisorModel: doc.session.advisorModel,
      configVersion: doc.session.configVersion,
      source: doc.session.source,
      advisorModels: doc.advisorModels ?? [],
      advisorUnavailableReason: doc.advisorUnavailableReason,
    });
    setBlocked("");
  }

  function send() {
    const fields = sendCollabFields({
      agentId,
      mode: collab.mode,
      advisorModel: collab.advisorModel,
      configVersion: collab.configVersion,
      advisorUnavailableReason: collab.advisorUnavailableReason,
    });
    if (fields.blockedReason) {
      setBlocked(fields.blockedReason);
      setLastSend("blocked");
      return;
    }
    setLastSend(JSON.stringify(fields));
  }

  useEffect(() => {
    void loadSession("sess-a");
  }, []);

  return (
    <div>
      <ChatHeader
        agent={{ ...MAIN_AGENT, id: agentId }}
        onAgentClick={() => setOpen(true)}
        models={MODELS}
        selectedModelId={mainModel}
        onSelectModel={setMainModel}
        advisorModeActive={collab.mode === "advisor" && agentId === "main"}
        advisorModelLabel={collab.advisorModel}
        teamModeActive={collab.mode === "team" && agentId === "main"}
      />
      <button type="button" data-testid="open-picker" onClick={() => setOpen(true)}>
        打开智能体选择器
      </button>
      <button type="button" data-testid="switch-b" onClick={() => void loadSession("sess-b")}>
        切到会话B
      </button>
      <button type="button" data-testid="send" onClick={send}>
        发送
      </button>
      <button type="button" data-testid="as-coding" onClick={() => setAgentId("coding-assistant")}>
        换成编程助手
      </button>
      <button type="button" data-testid="reload" onClick={() => void loadSession(sessionId)}>
        刷新配置
      </button>
      <pre data-testid="last-send">{lastSend}</pre>
      <pre data-testid="blocked">{blocked}</pre>
      <pre data-testid="main-model">{mainModel}</pre>
      <pre data-testid="collab-mode">{collab.mode}</pre>
      <pre data-testid="config-version">{collab.configVersion}</pre>
      <pre data-testid="as-default">{String(false)}</pre>
      <AgentPicker
        open={open}
        current={MAIN_AGENT}
        auth={null}
        collabMode={collab.mode}
        advisorModels={collab.advisorModels}
        advisorModel={collab.advisorModel}
        advisorUnavailableReason={collab.advisorUnavailableReason}
        onClose={() => setOpen(false)}
        onPick={() => setOpen(false)}
        onCollabModeChange={(mode) => {
          void choose(mode);
          setOpen(false);
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
