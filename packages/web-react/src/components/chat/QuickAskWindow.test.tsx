import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  isQuickAskSessionId,
  parseQuickAskSlashCommand,
} from "../../lib/quickAskSession";
import type { PublicModel, Session, User } from "../../lib/types";
import { loadBeforeAll } from "../../test/moduleLoad";
import { Composer } from "../Composer";
import { prefetchMarkdownImpl } from "../Markdown";
import { preloadToolBody } from "../tool/lazyToolBody";
import { ToastProvider } from "../ui";
import { preloadProcessStages } from "./lazyProcessStages";
import { preloadTimelineCards } from "./lazyTimelineCards";
import { resetPermissionAutoOpenMemory } from "./permissionPromptState";
import {
  buildMainlineContextPrefix,
  pickDefaultQuickAskModel,
  QuickAskWindow,
} from "./QuickAskWindow";

loadBeforeAll(prefetchMarkdownImpl);
loadBeforeAll(preloadToolBody);
loadBeforeAll(preloadTimelineCards);
loadBeforeAll(preloadProcessStages);

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
  sessionStorage.clear();
  FakeWS.instances = [];
  resetPermissionAutoOpenMemory();
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
  mainlineSessionId?: string;
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
      mainlineSessionId={props.mainlineSessionId}
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
    expect(isQuickAskSessionId("webqa_abc12345")).toBe(true);
    expect(isQuickAskSessionId("webmain12345")).toBe(false);
    expect(isHiddenQuickAskSession({ id: "webqa_abc12345", title: "[快问] 如何用 WeakMap" })).toBe(true);
    expect(isHiddenQuickAskSession({ id: "webqa_abc12345", title: "新对话" })).toBe(true);
    expect(isHiddenQuickAskSession({ id: "webqa_abc12345", title: "新会话" })).toBe(true);
    expect(isHiddenQuickAskSession({ id: "webqa_abc12345", title: "如何用 WeakMap" })).toBe(false);
    expect(isHiddenQuickAskSession({ id: "webqa_abc12345", title: "[快问] 临时" }, "webqa_abc12345")).toBe(false);
    expect(isHiddenQuickAskSession({ id: "webmain12345", title: "[快问] 误标前缀" })).toBe(false);
  });

  test("cleanQuickAskTitle 剥离前缀并保证非空非新对话", () => {
    expect(cleanQuickAskTitle("[快问]   React 并发渲染  ")).toBe("React 并发渲染");
    expect(cleanQuickAskTitle("[快问] 新对话", "Fallback 问题")).toBe("Fallback 问题");
    expect(cleanQuickAskTitle("[快问] 新会话", "Fallback 新会话")).toBe("Fallback 新会话");
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

  test("pickDefaultQuickAskModel 默认继承主会话健康模型，不静默降级至弱模型，并尊重用户显式选择", () => {
    expect(pickDefaultQuickAskModel(MODELS, "gpt-6-astra")).toBe("gpt-6-astra");
    expect(pickDefaultQuickAskModel(MODELS, "gpt-6-astra", "deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(
      pickDefaultQuickAskModel(
        [
          { id: "gpt-6-astra", degraded: true },
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

    expect(screen.getByTestId("quick-ask-model-trigger")).toHaveTextContent("GPT-6-Astra");

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
    expect(qaFrame.model).toBe("gpt-6-astra");
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

  test("自动关联当前主线摘要并去重注入，不重复叠加且保留原问题展示与临时标题前缀", async () => {
    const { socket, ws } = createConnectedSocket();
    const mainlineMsgs1: ChatMessage[] = [
      { id: "m1", role: "user", text: "如何排查 401", ts: 1 },
      { id: "m2", role: "assistant", text: "检查 token 过期边界", ts: 2 },
    ];

    const { rerender } = render(
      <Harness
        socket={socket}
        mainlineSessionId="webmain-ctx-1"
        mainlineTitle="重构鉴权"
        mainlineGoalObjective="消除重复 refresh"
        mainlineMessages={mainlineMsgs1}
      />,
    );

    expect(screen.queryByRole("switch", { name: "附带主线摘要" })).toBeNull();
    expect(screen.getByTestId("quick-ask-context-hint")).toHaveTextContent("已关联主线：重构鉴权");

    const textarea = screen.getByLabelText("快问输入框");
    fireEvent.change(textarea, { target: { value: "这里会竞态吗？" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      const sent = ws.sent.map((x) => JSON.parse(x) as { type?: string }).filter((x) => x.type === "inbound.message");
      expect(sent).toHaveLength(1);
    });

    const firstFrame = ws.sent
      .map((x) => JSON.parse(x) as { type?: string; peer?: { id?: string }; clientMessageId?: string; content?: { text?: string; displayText?: string } })
      .find((x) => x.type === "inbound.message")!;
    expect(firstFrame.content?.text).toContain("重构鉴权");
    expect(firstFrame.content?.text).toContain("检查 token 过期边界");
    expect(firstFrame.content?.text).toContain("这里会竞态吗？");
    expect(firstFrame.content?.displayText).toBe("这里会竞态吗？");
    expect(screen.getByText("这里会竞态吗？")).toBeInTheDocument();

    // 首条真实发送后，本地会话标题仍保留 [快问] 前缀，不向侧栏/刷新泄漏
    const qaId = firstFrame.peer!.id!;
    const qaSess = socket.sessions.get(qaId)!;
    expect(qaSess.title.startsWith("[快问]")).toBe(true);
    expect(isHiddenQuickAskSession(qaSess)).toBe(true);

    // 结束首轮后，在主线未变化时追问：不应重复拼接同一份主线摘要
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "outbound.message",
          sessionKey: `agent:main:webchat:dm:${qaId}`,
          channel: "webchat",
          peer: { id: qaId, kind: "dm" },
          agentId: "main",
          clientMessageId: firstFrame.clientMessageId,
          frameSeq: 1,
          blocks: [{ kind: "text", text: "会有竞态，需要加锁。" }],
          isFinal: true,
          ts: Date.now(),
        }),
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送快问" })).toBeInTheDocument());

    fireEvent.change(textarea, { target: { value: "怎么加锁？" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      const sent = ws.sent.map((x) => JSON.parse(x) as { type?: string }).filter((x) => x.type === "inbound.message");
      expect(sent).toHaveLength(2);
    });
    const secondFrame = ws.sent
      .map((x) => JSON.parse(x) as { type?: string; clientMessageId?: string; content?: { text?: string; displayText?: string } })
      .filter((x) => x.type === "inbound.message")[1]!;
    expect(secondFrame.content?.text).toBe("怎么加锁？");
    expect(secondFrame.content?.displayText).toBeUndefined();

    // 主线推进后下一轮快问应重新附带更新后的摘要
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "outbound.message",
          sessionKey: `agent:main:webchat:dm:${qaId}`,
          channel: "webchat",
          peer: { id: qaId, kind: "dm" },
          agentId: "main",
          clientMessageId: secondFrame.clientMessageId,
          frameSeq: 2,
          blocks: [{ kind: "text", text: "使用单飞 promise。" }],
          isFinal: true,
          ts: Date.now(),
        }),
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送快问" })).toBeInTheDocument());

    rerender(
      <Harness
        socket={socket}
        mainlineSessionId="webmain-ctx-1"
        mainlineTitle="重构鉴权"
        mainlineGoalObjective="消除重复 refresh"
        mainlineMessages={[
          ...mainlineMsgs1,
          { id: "m3", role: "assistant", text: "已定位到 singleflight 缺失", ts: 3 },
        ]}
      />,
    );
    fireEvent.change(textarea, { target: { value: "还有别的问题吗？" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      const sent = ws.sent.map((x) => JSON.parse(x) as { type?: string }).filter((x) => x.type === "inbound.message");
      expect(sent).toHaveLength(3);
    });
    const thirdFrame = ws.sent
      .map((x) => JSON.parse(x) as { type?: string; content?: { text?: string; displayText?: string } })
      .filter((x) => x.type === "inbound.message")[2]!;
    expect(thirdFrame.content?.text).toContain("已定位到 singleflight 缺失");
    expect(thirdFrame.content?.displayText).toBe("还有别的问题吗？");
  });

  test("复用主界面 ProcessDisclosure 折叠过程步骤并支持 AskUserQuestion 交互提交不卡死", async () => {
    const { socket, ws } = createConnectedSocket();
    const { rerender } = render(<Harness socket={socket} open mainlineSessionId="webmain-ui-1" />);

    const textarea = screen.getByLabelText("快问输入框");
    fireEvent.change(textarea, { target: { value: "帮我查单据并确认方案" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      const sent = ws.sent.map((x) => JSON.parse(x) as { type?: string }).filter((x) => x.type === "inbound.message");
      expect(sent).toHaveLength(1);
    });
    const qaFrame = ws.sent
      .map((x) => JSON.parse(x) as { type?: string; peer?: { id?: string }; clientMessageId?: string })
      .find((x) => x.type === "inbound.message")!;
    const qaId = qaFrame.peer!.id!;

    // 网关先吐出多个 tool 步骤，再发 AskUserQuestion 权限请求
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "outbound.message",
          sessionKey: `agent:main:webchat:dm:${qaId}`,
          channel: "webchat",
          peer: { id: qaId, kind: "dm" },
          agentId: "main",
          clientMessageId: qaFrame.clientMessageId,
          frameSeq: 1,
          blocks: [
            { kind: "tool_use", blockId: "t1", toolName: "Bash", input: { command: "ls" } },
            { kind: "tool_result", blockId: "t1", toolName: "Bash", output: "ok" },
            { kind: "tool_use", blockId: "t2", toolName: "Bash", input: { command: "pwd" } },
            { kind: "tool_result", blockId: "t2", toolName: "Bash", output: "/home" },
          ],
          isFinal: false,
          ts: Date.now(),
        }),
      });
      ws.onmessage?.({
        data: JSON.stringify({
          type: "outbound.permission_request",
          sessionKey: `agent:main:webchat:dm:${qaId}`,
          channel: "webchat",
          peer: { id: qaId, kind: "dm" },
          agentId: "main",
          requestId: "req-qa-ask-1",
          toolName: "AskUserQuestion",
          inputJson: {
            questions: [
              {
                question: "要按哪个方案继续？",
                header: "方案选择",
                multiSelect: false,
                options: [
                  { label: "方案 A", description: "快速修" },
                  { label: "方案 B", description: "彻底改" },
                ],
              },
            ],
          },
          ts: Date.now(),
        }),
      });
    });

    // 交互弹窗应立即出现且流程折叠生效（不再平铺两行裸 Bash）
    await waitFor(() => {
      const dialog = screen.getByRole("dialog", { name: "用户问答" });
      expect(within(dialog).getByText("要按哪个方案继续？")).toBeInTheDocument();
    });
    expect(screen.getByTestId("process-toggle")).toBeInTheDocument();

    // 选择方案 A 并提交回答 → WS 上应发出绑定 qaId 的 permission_response
    const askDialog = screen.getByRole("dialog", { name: "用户问答" });
    fireEvent.click(within(askDialog).getByRole("radio", { name: /方案 A/ }));
    fireEvent.click(within(askDialog).getByRole("button", { name: "提交" }));

    await waitFor(() => {
      const resp = ws.sent
        .map((x) => JSON.parse(x) as { type?: string; peer?: { id?: string }; requestId?: string; behavior?: string; updatedInput?: { answers?: Record<string, string> } })
        .find((x) => x.type === "inbound.permission_response");
      expect(resp).toBeTruthy();
      expect(resp!.peer?.id).toBe(qaId);
      expect(resp!.requestId).toBe("req-qa-ask-1");
      expect(resp!.behavior).toBe("allow");
      expect(resp!.updatedInput?.answers?.["要按哪个方案继续？"]).toBe("方案 A");
    });

    // 收起小窗后即使有新的未决 AskUserQuestion，也不得在隐藏态弹出阻塞主界面的弹窗
    rerender(<Harness socket={socket} open={false} mainlineSessionId="webmain-ui-1" />);
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "outbound.permission_request",
          sessionKey: `agent:main:webchat:dm:${qaId}`,
          channel: "webchat",
          peer: { id: qaId, kind: "dm" },
          agentId: "main",
          requestId: "req-qa-ask-collapsed",
          toolName: "AskUserQuestion",
          inputJson: {
            questions: [
              {
                question: "折叠态不应弹出此题",
                header: "隔离",
                multiSelect: false,
                options: [{ label: "是", description: "确认" }],
              },
            ],
          },
          ts: Date.now(),
        }),
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("折叠态不应弹出此题")).toBeNull();
  });

  test("不同主会话的快问车道相互隔离，切换主会话保留各自消息与草稿", async () => {
    const { socket, ws } = createConnectedSocket();
    const { rerender } = render(
      <Harness socket={socket} mainlineSessionId="webmain-A" mainlineTitle="会话 A" />,
    );

    const textarea = screen.getByLabelText("快问输入框") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "会话 A 的快问" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("会话 A 的快问")).toBeInTheDocument());
    const sessA = ws.sent
      .map((x) => JSON.parse(x) as { type?: string; peer?: { id?: string } })
      .find((x) => x.type === "inbound.message")!.peer!.id!;

    // 切换到主会话 B：A 的快问消息消失、拥有独立的新车道与草稿
    rerender(<Harness socket={socket} mainlineSessionId="webmain-B" mainlineTitle="会话 B" />);
    expect(screen.queryByText("会话 A 的快问")).toBeNull();
    expect(textarea.value).toBe("");

    fireEvent.change(textarea, { target: { value: "会话 B 的快问" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("会话 B 的快问")).toBeInTheDocument());
    const sessB = ws.sent
      .map((x) => JSON.parse(x) as { type?: string; peer?: { id?: string } })
      .filter((x) => x.type === "inbound.message")[1]!.peer!.id!;
    expect(sessB).not.toBe(sessA);

    // 切回主会话 A：恢复会话 A 的快问记录
    rerender(<Harness socket={socket} mainlineSessionId="webmain-A" mainlineTitle="会话 A" />);
    expect(screen.getByText("会话 A 的快问")).toBeInTheDocument();
    expect(screen.queryByText("会话 B 的快问")).toBeNull();
  });

  test("生成中「清空重问」先发 stop 并等终态再删会话，避免丢失取消控制", async () => {
    const deleteSpy = vi.spyOn(api, "deleteSession").mockResolvedValue({ ok: true } as never);
    const { socket, ws } = createConnectedSocket();
    render(<Harness socket={socket} mainlineSessionId="webmain-clear-1" />);

    const textarea = screen.getByLabelText("快问输入框");
    fireEvent.change(textarea, { target: { value: "正在跑的问题" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(screen.getByRole("button", { name: "停止快问" })).toBeInTheDocument());
    const qaFrame = ws.sent
      .map((x) => JSON.parse(x) as { type?: string; peer?: { id?: string }; clientMessageId?: string })
      .find((x) => x.type === "inbound.message")!;
    const qaId = qaFrame.peer!.id!;

    fireEvent.click(screen.getByRole("button", { name: "清空重问" }));
    // 立即切换到新车道，但旧会话仍等 stop 终态到达后再删
    expect(screen.queryByText("正在跑的问题")).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(socket.sessions.has(qaId)).toBe(true);

    const stopFrame = ws.sent
      .map((x) => JSON.parse(x) as { type?: string; peer?: { id?: string } })
      .find((x) => x.type === "inbound.control.stop");
    expect(stopFrame?.peer?.id).toBe(qaId);

    // 服务端回传 aborted 终态帧后完成清理删除
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "outbound.message",
          sessionKey: `agent:main:webchat:dm:${qaId}`,
          channel: "webchat",
          peer: { id: qaId, kind: "dm" },
          agentId: "main",
          clientMessageId: qaFrame.clientMessageId,
          blocks: [],
          meta: { aborted: true },
          isFinal: true,
          ts: Date.now(),
        }),
      });
    });

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith(expect.anything(), qaId);
    });
    expect(socket.sessions.has(qaId)).toBe(false);
  });

  test("「转为正式对话」去除临时前缀并回传正式会话；「清空重问」销毁临时会话", async () => {
    const ensureSpy = vi.fn(async () => true);
    const patchTitleSpy = vi.spyOn(api, "patchSessionTitle").mockResolvedValue({ ok: true, updatedAt: 100 });
    const deleteSpy = vi.spyOn(api, "deleteSession").mockResolvedValue({ ok: true } as never);
    const { socket, ws } = createConnectedSocket(ensureSpy);
    const onPromote = vi.fn();

    render(<Harness socket={socket} onPromoteSession={onPromote} />);

    const textarea = screen.getByLabelText("快问输入框");
    fireEvent.change(textarea, { target: { value: "TypeScript satisfies 用法" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      const sent = ws.sent.map((x) => JSON.parse(x) as { type?: string }).filter((x) => x.type === "inbound.message");
      expect(sent).toHaveLength(1);
    });
    const f1 = ws.sent
      .map((x) => JSON.parse(x) as { type?: string; peer?: { id?: string }; clientMessageId?: string })
      .find((x) => x.type === "inbound.message")!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "outbound.message",
          sessionKey: `agent:main:webchat:dm:${f1.peer!.id}`,
          channel: "webchat",
          peer: { id: f1.peer!.id, kind: "dm" },
          agentId: "main",
          clientMessageId: f1.clientMessageId,
          frameSeq: 1,
          blocks: [{ kind: "text", text: "satisfies 可校验类型并保留字面量推理。" }],
          isFinal: true,
          ts: Date.now(),
        }),
      });
    });

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

    // 再问一句结束并点清空重问：旧临时会话被清除并调 deleteSession
    fireEvent.change(textarea, { target: { value: "第二个临时问题" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByText("第二个临时问题")).toBeInTheDocument();
    });
    const f2 = ws.sent
      .map((x) => JSON.parse(x) as { type?: string; peer?: { id?: string }; clientMessageId?: string })
      .filter((x) => x.type === "inbound.message")[1]!;
    const tempQaId = f2.peer!.id!;
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "outbound.message",
          sessionKey: `agent:main:webchat:dm:${tempQaId}`,
          channel: "webchat",
          peer: { id: tempQaId, kind: "dm" },
          agentId: "main",
          clientMessageId: f2.clientMessageId,
          frameSeq: 1,
          blocks: [{ kind: "text", text: "好的" }],
          isFinal: true,
          ts: Date.now(),
        }),
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送快问" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "清空重问" }));
    expect(socket.sessions.has(tempQaId)).toBe(false);
    expect(deleteSpy).toHaveBeenCalledWith(expect.anything(), tempQaId);
  });

  test("Composer 在主线 busy=true 时拦截 /btw 指令直达快问小窗且不入主线队列，带附件时提示阻断", async () => {
    const onMainSend = vi.fn();
    const onQuickAskCommand = vi.fn();

    render(
      <ToastProvider>
        <Composer
          busy
          onSend={onMainSend}
          onUpload={async () => ({ kind: "file", url: "/tmp/a.txt", filename: "a.txt" })}
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

    // 带附件输入 /btw 应提示暂不支持附件且不发进主线
    onQuickAskCommand.mockClear();
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText("a.txt")).toBeInTheDocument());
    fireEvent.change(input, { target: { value: "/btw 携带附件测试" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onQuickAskCommand).not.toHaveBeenCalled();
    expect(onMainSend).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText(/快问小窗暂不支持携带附件/)).toBeInTheDocument();
    });
  });

  test("模型下拉清洗 (Antigravity) 冗余后缀并附家族图标，关联主线收敛为可展开单行胶囊(OCV5-838)", () => {
    const { socket } = createConnectedSocket();
    const auth = createMemoryAuthSession(() => {}, "tok");
    const chat = (() => {
      let bound!: UseChatSocket;
      function Probe() {
        bound = useBoundChatSocket(socket);
        return (
          <QuickAskWindow
            open
            onClose={vi.fn()}
            seed={null}
            chat={bound}
            authRef={{ current: auth }}
            user={USER}
            demo={false}
            agent={MAIN_AGENT}
            models={[
              { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6 (Antigravity)" },
              { id: "gemini-3-pro", display_name: "Gemini 3 Pro (Antigravity)" },
            ]}
            mainlineSessionId="webmain-polish-1"
            mainlineModelId="claude-sonnet-4-6"
            mainlineTitle="重构鉴权"
            mainlineGoalObjective="消除重复 refresh"
            mainlineMessages={[{ id: "u1", role: "user", text: "如何排查 401", ts: 1 }]}
            onPromoteSession={vi.fn()}
          />
        );
      }
      return Probe;
    })();
    const Probe = chat;
    render(<Probe />);

    // 触发钮清洗掉 (Antigravity) 且带模型家族图标
    const trigger = screen.getByTestId("quick-ask-model-trigger");
    expect(trigger).toHaveTextContent("Claude Sonnet 4.6");
    expect(trigger).not.toHaveTextContent("Antigravity");
    expect(trigger.querySelector("svg")).not.toBeNull();

    // 关联主线摘要默认收起成单行胶囊，点击展开钮才展示预览行
    expect(screen.getByTestId("quick-ask-context-hint")).toHaveTextContent("已关联主线：重构鉴权");
    expect(screen.queryByTestId("quick-ask-context-preview")).toBeNull();
    fireEvent.click(screen.getByTestId("quick-ask-context-expand"));
    expect(screen.getByTestId("quick-ask-context-preview")).toHaveTextContent("目标：消除重复 refresh");
  });
});
