import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { UseChatSocket } from "../../hooks/useChatSocket";
import { MAIN_AGENT } from "../../lib/agents";
import { api } from "../../lib/api";
import { createMemoryAuthSession } from "../../lib/authSession";
import type { ChatMessage } from "../../lib/chat/model";
import { ChatSocket } from "../../lib/chat/socket";
import {
  cleanQuickAskTitle,
  genQuickAskSessionId,
  isHiddenQuickAskSession,
  parseQuickAskSlashCommand,
} from "../../lib/quickAskSession";
import type { PublicModel, Session, User } from "../../lib/types";
import { Composer } from "../Composer";
import { ToastProvider } from "../ui";
import {
  buildMainlineContextPrefix,
  pickDefaultQuickAskModel,
  QuickAskWindow,
} from "./QuickAskWindow";

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeWS.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "sys.relay_ready" }) });
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function useBoundChatSocket(socket: ChatSocket): UseChatSocket {
  const snap = useSyncExternalStore(
    (cb) => socket.subscribe(cb),
    () => socket.getSnapshot(),
    () => socket.getSnapshot(),
  );
  return {
    status: snap.status,
    provisioning: snap.provisioning,
    browserOnline: true,
    version: snap.version,
    getMessages: (id) => (id ? (snap.sessions.get(id)?.messages ?? []) : []),
    getSession: (id) => (id ? snap.sessions.get(id) : undefined),
    isSending: (id) => !!(id && socket.isSessionBusy(id)),
    dispatchStatus: (id) => (id ? socket.getDispatchStatus(id) : null),
    ensureSession: (id, agentId, title) => {
      socket.ensureSession(id, agentId, title);
    },
    ensureServerSession: (id, agentId, title) => socket.ensureServerSession(id, agentId, title),
    removeSession: (id) => socket.removeSession(id),
    renameSession: (id, title) => socket.renameSession(id, title),
    setSessionModel: (id, modelId, modelSwitchId) =>
      socket.setSessionModel(id, modelId, modelSwitchId),
    prepareModelSwitch: (id, src, dst) => socket.prepareModelSwitch(id, src, dst),
    cancelPendingModelSwitches: (id) => socket.cancelPendingModelSwitches(id),
    switchAgent: (id, agentId) => socket.switchAgent(id, agentId),
    send: (p) => socket.sendMessage(p),
    stop: (id, cmid) => socket.stopTurn(id, cmid),
    retryMessage: (p) => socket.retryMessage(p),
    continueInterruptedTurn: (p) => socket.continueInterruptedTurn(p),
    editQueuedMessage: (id, msgId) => socket.editQueuedMessage(id, msgId),
    discardQueuedMessage: (id, msgId) => socket.discardQueuedMessage(id, msgId),
    sendQueuedNow: (id, msgId) => socket.sendQueuedNow(id, msgId),
    setActiveSession: (id) => socket.setActiveSession(id),
    setGoalState: (id, goal) => socket.setGoalState(id, goal),
    getTransientNotice: (id) => (id ? socket.getTransientNotice(id) : null),
    respondPermission: (p) => socket.respondPermission(p),
    mergeServerHistory: () => {},
    applyDurableLiveFrames: () => {},
    runDurableLiveFrameHydration: async () => {},
    hydrateDurableLiveFrameJournal: async () => {},
    retryLiveJournalHydration: async () => {},
    storedMaxSeq: () => 0,
    storedHistoryRevision: () => undefined,
    loadOlderHistory: async () => ({ ok: true, loaded: 0, hasMore: false }),
    loadOlderLiveUnits: async () => ({ ok: true, loaded: 0, hasMore: false }),
    fetchTapeRecordPayload: async () => null,
    peekTapeRecordPayload: () => null,
    fetchUserMessagePayload: async () => null,
    peekUserMessagePayload: () => null,
    removePersisted: () => {},
    wipePersistence: async () => {},
    sendRepoBind: () => {},
    sendRepoUnbind: () => {},
    retryConnectNow: () => false,
  };
}

const MODELS: PublicModel[] = [
  { id: "gpt-6-astra", display_name: "GPT-6-Astra" },
  { id: "deepseek-v4-flash", display_name: "DeepSeek Flash" },
  { id: "gpt-6-luna", display_name: "GPT-6-Luna" },
];

const USER: User = { id: "u1", displayName: "Tester", roles: ["user"] };

beforeEach(() => {
  localStorage.clear();
  FakeWS.instances = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createConnectedSocket(ensureServerSession = vi.fn(async () => true)) {
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
  const socket = new ChatSocket({
    getToken: () => "tok",
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: "transient", epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: "main",
    ensureServerSession,
  });
  socket.setGateReady(true);
  const ws = FakeWS.instances.at(-1)!;
  ws.open();
  return { socket, ws, ensureServerSession };
}

function Harness(props: {
  socket: ChatSocket;
  open?: boolean;
  onClose?: () => void;
  onSendingChange?: (v: boolean) => void;
  seed?: { text: string; nonce: number } | null;
  mainlineTitle?: string;
  mainlineGoalObjective?: string;
  mainlineMessages?: ChatMessage[];
  onPromoteSession?: (sess: Session) => void;
}) {
  const chat = useBoundChatSocket(props.socket);
  const auth = createMemoryAuthSession(() => {}, "tok");
  const authRef = { current: auth };
  return (
    <QuickAskWindow
      open={props.open ?? true}
      onClose={props.onClose ?? vi.fn()}
      onSendingChange={props.onSendingChange}
      seed={props.seed ?? null}
      chat={chat}
      authRef={authRef}
      user={USER}
      demo={false}
      agent={MAIN_AGENT}
      models={MODELS}
      mainlineModelId="gpt-6-astra"
      mainlineTitle={props.mainlineTitle}
      mainlineGoalObjective={props.mainlineGoalObjective}
      mainlineMessages={props.mainlineMessages ?? []}
      onPromoteSession={(s) => props.onPromoteSession?.(s)}
    />
  );
}

describe("quickAskSession helpers", () => {
  test("genQuickAskSessionId 匹配后端 peer.id 正则且以 webqa_ 开头", () => {
    const id = genQuickAskSessionId();
    expect(id).toMatch(/^webqa_[A-Za-z0-9_-]{8,40}$/);
  });

  test("isHiddenQuickAskSession 隐藏临时快问会话，放行已转为正式对话的会话", () => {
    expect(isHiddenQuickAskSession({ id: "webqa_abc12345", title: "[快问] 如何用 WeakMap" })).toBe(true);
    expect(isHiddenQuickAskSession({ id: "webqa_abc12345", title: "新对话" })).toBe(true);
    expect(isHiddenQuickAskSession({ id: "webqa_abc12345", title: "如何用 WeakMap" })).toBe(false);
    expect(isHiddenQuickAskSession({ id: "webqa_abc12345", title: "[快问] 临时" }, "webqa_abc12345")).toBe(false);
    expect(isHiddenQuickAskSession({ id: "webmain12345", title: "[快问] 误标前缀" })).toBe(false);
  });

  test("cleanQuickAskTitle 剥离前缀并保证非空非新对话", () => {
    expect(cleanQuickAskTitle("[快问]   React 并发渲染  ")).toBe("React 并发渲染");
    expect(cleanQuickAskTitle("[快问] 新对话", "Fallback 问题")).toBe("Fallback 问题");
    expect(cleanQuickAskTitle("", "")).toBe("快问对话");
  });

  test("parseQuickAskSlashCommand 识别 /btw 与 /ask，不误伤其他文本", () => {
    expect(parseQuickAskSlashCommand("/btw 什么是 WeakRef?")).toEqual({
      matched: true,
      question: "什么是 WeakRef?",
    });
    expect(parseQuickAskSlashCommand("  /ASK\n解释下 TSX ")).toEqual({
      matched: true,
      question: "解释下 TSX",
    });
    expect(parseQuickAskSlashCommand("/btw")).toEqual({ matched: true, question: "" });
    expect(parseQuickAskSlashCommand("/btw-other test")).toEqual({ matched: false });
    expect(parseQuickAskSlashCommand("普通提问 /btw 不在行首")).toEqual({ matched: false });
  });

  test("pickDefaultQuickAskModel 跳过降级模型并优先选用快模型", () => {
    expect(pickDefaultQuickAskModel(MODELS, "gpt-6-astra")).toBe("deepseek-v4-flash");
    expect(
      pickDefaultQuickAskModel(
        [
          { id: "gpt-6-astra" },
          { id: "deepseek-v4-flash", degraded: true },
          { id: "gpt-6-luna" },
        ],
        "gpt-6-astra",
      ),
    ).toBe("gpt-6-luna");
  });

  test("buildMainlineContextPrefix 生成有界只读摘要且空会话返回空串", () => {
    expect(buildMainlineContextPrefix({ title: "新对话", messages: [] })).toBe("");
    const prefix = buildMainlineContextPrefix({
      title: "修复 WS 重连",
      goalObjective: "消除断连循环",
      messages: [
        { id: "u1", role: "user", text: "为什么会不断重连", ts: 1 },
        { id: "a1", role: "assistant", text: "因为 onopen 清零了退避计数", ts: 2 },
      ],
    });
    expect(prefix).toContain("修复 WS 重连");
    expect(prefix).toContain("消除断连循环");
    expect(prefix).toContain("因为 onopen 清零了退避计数");
    expect(prefix.length).toBeLessThanOrEqual(1200);
  });
});

describe("QuickAskWindow 并行问答与隔离行为", () => {
  test("主线正在流式执行时，快问通过独立 webqa_* 会话与快模型并行发送并接收回答，主线不受打断", async () => {
    const { socket, ws } = createConnectedSocket();

    await act(async () => {
      await socket.sendMessage({
        sessId: "webmain001",
        agentId: "main",
        text: "主线长任务",
        model: "gpt-6-astra",
      });
    });
    expect(socket.isSessionBusy("webmain001")).toBe(true);
    const mainMsgCountBefore = socket.sessions.get("webmain001")?.messages.length ?? 0;

    const onSendingChange = vi.fn();
    render(<Harness socket={socket} onSendingChange={onSendingChange} />);

    expect(screen.getByTestId("quick-ask-model-trigger")).toHaveTextContent("DeepSeek Flash");

    const textarea = screen.getByLabelText("快问输入框");
    fireEvent.change(textarea, { target: { value: "WeakMap 和 Map 区别？" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      const inboundFrames = ws.sent
        .map((raw) => JSON.parse(raw) as { type?: string; peer?: { id?: string }; model?: string; content?: { text?: string } })
        .filter((f) => f.type === "inbound.message");
      expect(inboundFrames).toHaveLength(2);
    });

    const inboundFrames = ws.sent
      .map((raw) => JSON.parse(raw) as { type?: string; peer?: { id?: string }; model?: string; content?: { text?: string }; clientMessageId?: string })
      .filter((f) => f.type === "inbound.message");
    const qaFrame = inboundFrames[1]!;
    expect(qaFrame.peer?.id).toMatch(/^webqa_/);
    expect(qaFrame.peer?.id).not.toBe("webmain001");
    expect(qaFrame.model).toBe("deepseek-v4-flash");
    expect(qaFrame.content?.text).toBe("WeakMap 和 Map 区别？");

    // 主线仍在发送中且消息未受污染
    expect(socket.isSessionBusy("webmain001")).toBe(true);
    expect(socket.sessions.get("webmain001")?.messages ?? []).toHaveLength(mainMsgCountBefore);

    // 模拟网关只对快问会话回传流式与终态帧
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "outbound.message",
          sessionKey: `agent:main:webchat:dm:${qaFrame.peer!.id}`,
          channel: "webchat",
          peer: { id: qaFrame.peer!.id, kind: "dm" },
          agentId: "main",
          clientMessageId: qaFrame.clientMessageId,
          frameSeq: 1,
          blocks: [{ kind: "text", text: "WeakMap 的键必须是对象且为弱引用。" }],
          isFinal: true,
          ts: Date.now(),
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/WeakMap 的键必须是对象且为弱引用/)).toBeInTheDocument();
    });
    expect(socket.isSessionBusy("webmain001")).toBe(true);
    expect(onSendingChange).toHaveBeenCalledWith(true);
    expect(onSendingChange).toHaveBeenLastCalledWith(false);
  });

  test("小窗内 Esc 与停止只作用于快问，绝不向 window 泄漏触发主线停止", async () => {
    const { socket, ws } = createConnectedSocket();
    await act(async () => {
      await socket.sendMessage({
        sessId: "webmain002",
        agentId: "main",
        text: "主线任务",
        model: "gpt-6-astra",
      });
    });
    const stopSpy = vi.spyOn(socket, "stopTurn");
    const winKeySpy = vi.fn();
    window.addEventListener("keydown", winKeySpy);
    const onClose = vi.fn();

    try {
      render(<Harness socket={socket} onClose={onClose} />);
      const textarea = screen.getByLabelText("快问输入框");
      fireEvent.change(textarea, { target: { value: "并行小问题" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "停止快问" })).toBeInTheDocument();
      });
      winKeySpy.mockClear();

      // 生成中按 Esc：只停快问、不收起、不冒泡到 window
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(stopSpy.mock.calls[0]?.[0]).toMatch(/^webqa_/);
      expect(stopSpy.mock.calls[0]?.[0]).not.toBe("webmain002");
      expect(winKeySpy).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(socket.isSessionBusy("webmain002")).toBe(true);

      // 服务端下发快问终态帧回 idle 后再按 Esc：收起快问小窗且不冒泡到 window
      const qaId = stopSpy.mock.calls[0]![0];
      const qaCmid = socket.sessions.get(qaId)?.messages.find((m) => m.role === "user")?.id;
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "outbound.message",
            sessionKey: `agent:main:webchat:dm:${qaId}`,
            channel: "webchat",
            peer: { id: qaId, kind: "dm" },
            agentId: "main",
            clientMessageId: qaCmid,
            blocks: [],
            meta: { aborted: true },
            isFinal: true,
            ts: Date.now(),
          }),
        });
      });
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "发送快问" })).toBeInTheDocument();
      });
      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(winKeySpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", winKeySpy);
    }
  });

  test("开启「附带主线只读摘要」时，发送携带只读背景而气泡仅显示原问题", async () => {
    const { socket, ws } = createConnectedSocket();

    render(
      <Harness
        socket={socket}
        mainlineTitle="重构鉴权"
        mainlineGoalObjective="消除重复 refresh"
        mainlineMessages={[
          { id: "m1", role: "user", text: "如何排查 401", ts: 1 },
          { id: "m2", role: "assistant", text: "检查 token 过期边界", ts: 2 },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "附带主线摘要" }));
    const textarea = screen.getByLabelText("快问输入框");
    fireEvent.change(textarea, { target: { value: "这里会竞态吗？" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      const sent = ws.sent.map((x) => JSON.parse(x) as { type?: string }).filter((x) => x.type === "inbound.message");
      expect(sent).toHaveLength(1);
    });

    const frame = ws.sent
      .map((x) => JSON.parse(x) as { type?: string; content?: { text?: string; displayText?: string } })
      .find((x) => x.type === "inbound.message")!;
    expect(frame.content?.text).toContain("重构鉴权");
    expect(frame.content?.text).toContain("检查 token 过期边界");
    expect(frame.content?.text).toContain("这里会竞态吗？");
    expect(frame.content?.displayText).toBe("这里会竞态吗？");
    expect(screen.getByText("这里会竞态吗？")).toBeInTheDocument();
  });

  test("「转为正式对话」去除临时前缀并回传正式会话；「清空重问」销毁临时会话", async () => {
    const ensureSpy = vi.fn(async () => true);
    const patchTitleSpy = vi.spyOn(api, "patchSessionTitle").mockResolvedValue({ ok: true, updatedAt: 100 });
    const deleteSpy = vi.spyOn(api, "deleteSession").mockResolvedValue({ ok: true } as never);
    const { socket } = createConnectedSocket(ensureSpy);
    const onPromote = vi.fn();

    render(<Harness socket={socket} onPromoteSession={onPromote} />);

    const textarea = screen.getByLabelText("快问输入框");
    fireEvent.change(textarea, { target: { value: "TypeScript satisfies 用法" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "转为正式对话" })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "转为正式对话" }));
    expect(onPromote).toHaveBeenCalledTimes(1);
    const promoted = onPromote.mock.calls[0]![0] as Session;
    expect(promoted.id).toMatch(/^webqa_/);
    expect(promoted.title).toBe("TypeScript satisfies 用法");
    expect(isHiddenQuickAskSession(promoted)).toBe(false);

    await waitFor(() => {
      expect(ensureSpy).toHaveBeenCalled();
      expect(patchTitleSpy).toHaveBeenCalledWith(expect.anything(), promoted.id, "TypeScript satisfies 用法");
    });

    // 再问一句后点清空重问：旧临时会话被清除并调 deleteSession
    fireEvent.change(textarea, { target: { value: "第二个临时问题" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByText("第二个临时问题")).toBeInTheDocument();
    });
    const tempQaId = [...socket.sessions.keys()].find((id) => id !== promoted.id && id.startsWith("webqa_"))!;
    fireEvent.click(screen.getByRole("button", { name: "清空重问" }));
    expect(socket.sessions.has(tempQaId)).toBe(false);
    expect(deleteSpy).toHaveBeenCalledWith(expect.anything(), tempQaId);
  });

  test("Composer 在主线 busy=true 时拦截 /btw 指令直达快问小窗且不入主线队列", () => {
    const onMainSend = vi.fn();
    const onQuickAskCommand = vi.fn();

    render(
      <ToastProvider>
        <Composer
          busy
          onSend={onMainSend}
          onQuickAskCommand={onQuickAskCommand}
        />
      </ToastProvider>,
    );

    const input = screen.getByLabelText("消息输入框") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/btw useSyncExternalStore 会同步重渲吗？" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onQuickAskCommand).toHaveBeenCalledWith("useSyncExternalStore 会同步重渲吗？");
    expect(onMainSend).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    expect(screen.queryByText(/已加入队列/)).toBeNull();
  });
});
