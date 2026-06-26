import { useCallback, useEffect, useRef, useState } from "react";
import { AgentPicker } from "./components/AgentPicker";
import { AuthGate } from "./components/AuthGate";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { type ChatError, ErrorBanner } from "./components/ErrorBanner";
import { Landing } from "./components/Landing";
import { AssistantMessage, UserMessage } from "./components/Message";
import { SettingsCenter } from "./components/SettingsCenter";
import { Sidebar } from "./components/Sidebar";
import { Sheet } from "./components/ui";
import { useTheme } from "./hooks/useTheme";
import { DEFAULT_AGENT } from "./lib/agents";
import { api } from "./lib/api";
import { DEMO_MESSAGES, DEMO_SESSIONS, DEMO_USER, demoReply } from "./lib/demo";
import type { AuthSession, Message, Session, ToolCard, User } from "./lib/types";

/**
 * P2 占位：v5 对话传输（WS user-chat-bridge）在 P4 接入。在此之前，登录后的工作区
 * 是真实 app shell（侧栏 / 顶栏 / 智能体选择 / 设置），但会话与消息仅为**本地脚手架**
 * （不落后端、刷新即失）。发送消息回一条明确标注的占位助手消息，绝不假装真在对话。
 */
const P4_PLACEHOLDER_REPLY =
  "对话传输将在后续版本接入（P4：WebSocket user-chat-bridge）。\n\n" +
  "当前你看到的是 **v5 商业版前端骨架**：登录鉴权、品牌、主题、布局均已就位，" +
  "真实的流式对话、会话历史与九类卡片会在后续阶段陆续上线。";

function makeLocalSession(title: string, ownerUserId: string): Session {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: title || "新对话",
    ownerUserId,
    updatedAt: new Date().toISOString(),
    messageCount: 0,
  };
}

export function App() {
  const params = new URLSearchParams(location.search);
  const demo = params.get("demo") === "1";
  // access token 仅存内存，刷新即丢失，所以启动一律落到首页/登录（无自动登录）。
  const [view, setView] = useState<"home" | "app">("home");
  // 主题的唯一权威源：useTheme 是「挂载读 localStorage」的单实例，经 props 下传给顶栏快捷开关
  // 与设置中心「偏好·外观」分区，二者共享同一状态——杜绝多个 useTheme 实例各自镜像、互不同步。
  const { theme, setTheme, cycle } = useTheme();

  // access token 仅存内存：放在 ref 里作为唯一权威源，AuthSession.getToken/setToken 读写它，
  // 静默刷新成功后 api 层直接回写 ref，下一次鉴权请求即拿到新 token（无 stale 闭包）。
  const tokenRef = useRef<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [user, setUser] = useState<User | null>(demo ? DEMO_USER : null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<Session[]>(demo ? DEMO_SESSIONS : []);
  const [activeId, setActiveId] = useState<string | undefined>(demo ? DEMO_SESSIONS[0].id : undefined);
  const [messages, setMessages] = useState<Message[]>(demo ? DEMO_MESSAGES : []);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [toolCards] = useState<ToolCard[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [agent, setAgent] = useState(DEFAULT_AGENT);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chatError, setChatError] = useState<ChatError | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef(false);

  // 本地会话消息存储（脚手架）：activeId → 消息数组。P4 接入 WS 会话历史后替换。
  const localStore = useRef<Map<string, Message[]>>(new Map());

  // 清空全部鉴权 + 会话状态，回到登录/首页（静默刷新失败或主动登出都走这里）。
  const clearAuth = useCallback(() => {
    tokenRef.current = null;
    localStore.current.clear();
    setAuthed(false);
    setUser(null);
    setSessions([]);
    setMessages([]);
    setActiveId(undefined);
    setChatError(null);
    setSettingsOpen(false);
    setView("home");
  }, []);

  // AuthSession：access token 的唯一权威源（仅存内存）。整个生命周期复用同一引用，
  // 传给 api.* 的鉴权请求；命中 401 时 api 内部透明刷新并 setToken 回写本 ref。
  // onExpired 在刷新失败时触发 → clearAuth 把用户带回登录页（绝不循环重试）。
  const authRef = useRef<AuthSession>({
    getToken: () => tokenRef.current ?? "",
    setToken: (t) => {
      tokenRef.current = t;
    },
    onExpired: () => clearAuth(),
  });
  // clearAuth 每次渲染可能是新引用；让 session.onExpired 始终指向最新版本。
  authRef.current.onExpired = clearAuth;
  // 仅当已认证时把 session 暴露给业务逻辑；未认证时为 null。P3/P4 的 REST/WS 调用消费它。
  const auth = authed ? authRef.current : null;

  const interrupt = useCallback(() => {
    stopRef.current = true;
    setBusy(false);
    setStreamText("");
    setChatError(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      // 登录拿到内存态 accessToken + 用户信息；token 只写进 tokenRef（内存），绝不落地。
      // refresh token 由后端通过 HttpOnly cookie 下发（api.login credentials:'include'）。
      const { accessToken, user: me } = await api.login(email, password);
      tokenRef.current = accessToken;
      setAuthed(true);
      setUser(me);
      // P2 占位：v5 会话历史走 WS（P4），REST 不再提供 chat session 列表。
      // 这里不预载会话，侧栏初始为空，用户可新建本地会话预览骨架。
      setSessions([]);
      setActiveId(undefined);
      setMessages([]);
    } catch (e) {
      setAuthError((e as Error).message || "登录失败");
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const selectSession = useCallback(
    (id: string) => {
      if (id === activeId) return;
      setChatError(null);
      setActiveId(id);
      if (demo) {
        setMessages(id === DEMO_SESSIONS[0].id ? DEMO_MESSAGES : []);
        return;
      }
      setMessages(localStore.current.get(id) ?? []);
    },
    [activeId, demo],
  );

  const newSession = useCallback(() => {
    interrupt();
    setMessages([]);
    setChatError(null);
    if (demo) {
      const s = makeLocalSession("新对话", "demo");
      setSessions((c) => [s, ...c]);
      setActiveId(s.id);
      return;
    }
    if (!user) return;
    const s = makeLocalSession("新对话", user.id);
    localStore.current.set(s.id, []);
    setSessions((c) => [s, ...c]);
    setActiveId(s.id);
  }, [demo, user, interrupt]);

  const send = useCallback(
    async (text: string) => {
      setChatError(null);
      const userMsg: Message = {
        id: `tmp-${Date.now()}`,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      };

      // demo：本地流式回放（无网络），仅用于离线预览设计。
      if (demo) {
        setMessages((m) => [...m, userMsg]);
        setBusy(true);
        setStreamText("");
        stopRef.current = false;
        const full = demoReply(text);
        for (let i = 0; i < full.length && !stopRef.current; i += 3) {
          setStreamText(full.slice(0, i + 3));
          await new Promise((r) => setTimeout(r, 12));
        }
        setMessages((m) => [
          ...m,
          { id: `a-${Date.now()}`, role: "assistant", content: full, createdAt: new Date().toISOString() },
        ]);
        setStreamText("");
        setBusy(false);
        return;
      }

      if (!user) return;
      // 确保有一个（本地）会话承载本轮消息。
      let sessionId = activeId;
      let createdSession: Session | null = null;
      if (!sessionId) {
        createdSession = makeLocalSession(text.slice(0, 24), user.id);
        sessionId = createdSession.id;
        localStore.current.set(sessionId, []);
        setSessions((c) => [createdSession!, ...c]);
        setActiveId(sessionId);
      }

      // P4 占位：不接 WS，立即回一条明确标注的占位助手消息，绝不假装在与后端对话。
      const assistantMsg: Message = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: P4_PLACEHOLDER_REPLY,
        createdAt: new Date().toISOString(),
      };
      const prev = localStore.current.get(sessionId) ?? [];
      const nextMsgs = [...prev, userMsg, assistantMsg];
      localStore.current.set(sessionId, nextMsgs);
      setMessages(nextMsgs);
      // 把会话提到顶部并更新计数/标题（纯本地）。
      setSessions((c) => {
        const sid = sessionId!;
        const found = c.find((s) => s.id === sid);
        const updated: Session = {
          ...(found ?? createdSession ?? makeLocalSession(text.slice(0, 24), user.id)),
          id: sid,
          title: found?.title && found.messageCount > 0 ? found.title : text.slice(0, 24) || "新对话",
          updatedAt: new Date().toISOString(),
          messageCount: nextMsgs.length,
        };
        return [updated, ...c.filter((s) => s.id !== sid)];
      });
    },
    [activeId, demo, user],
  );

  const regenerate = useCallback(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        send(messages[i].content);
        return;
      }
    }
  }, [messages, send]);

  const logout = useCallback(() => {
    // 先请求后端吊销 refresh cookie（错误已在 api 层吞掉），再清空内存态回到首页。
    if (!demo) void api.logout();
    clearAuth();
  }, [demo, clearAuth]);

  // autoscroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamText]);

  // 键盘快捷键：⌘/Ctrl+K 新会话；Esc 停止当前（demo）流式。仅在进入工作区后生效。
  const inWorkspace = demo || (view === "app" && !!auth && !!user);
  useEffect(() => {
    if (!inWorkspace) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        newSession();
      } else if (e.key === "Escape" && busy) {
        e.preventDefault();
        interrupt();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inWorkspace, busy, newSession, interrupt]);

  if (!demo && view === "home") {
    return (
      <Landing
        onStart={() => setView("app")}
        onLogin={() => setView("app")}
        theme={theme}
        onCycleTheme={cycle}
      />
    );
  }
  if (!demo && (!auth || !user)) {
    return (
      <AuthGate
        onLogin={login}
        loading={authLoading}
        error={authError}
        onBack={() => setView("home")}
        theme={theme}
        onCycleTheme={cycle}
      />
    );
  }

  const showEmpty = messages.length === 0 && !busy;

  // 侧栏公共 props：桌面内联与移动抽屉两处复用。余额（balanceCents）本期不展示（P3.5 计费中心）。
  const renameSessionPrompt = (s: Session) => {
    const t = prompt("重命名会话", s.title);
    if (t) setSessions((c) => c.map((x) => (x.id === s.id ? { ...x, title: t } : x)));
  };
  const deleteSessionConfirm = (s: Session) => {
    if (!confirm("删除该会话？")) return;
    localStore.current.delete(s.id);
    setSessions((c) => c.filter((x) => x.id !== s.id));
    if (s.id === activeId) {
      setActiveId(undefined);
      setMessages([]);
      setChatError(null);
    }
  };
  const sidebarProps = {
    sessions,
    activeId,
    user,
    balanceCents: null,
    onOpenAccount: demo ? undefined : () => setSettingsOpen(true),
    onNew: newSession,
    onRename: renameSessionPrompt,
    onDelete: deleteSessionConfirm,
    onLogout: demo ? undefined : logout,
  };

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-fg">
      {/* 桌面：内联侧栏（可折叠）。窄屏隐藏，改用抽屉。 */}
      {!collapsed && (
        <div className="hidden md:contents">
          <Sidebar {...sidebarProps} onSelect={selectSession} onCollapse={() => setCollapsed(true)} />
        </div>
      )}

      {/* 移动：侧栏抽屉。Sheet 原语提供遮罩/Escape/焦点陷阱。 */}
      <Sheet
        open={mobileNavOpen}
        onOpenChange={setMobileNavOpen}
        side="left"
        srTitle="会话导航"
        className="w-[268px] max-w-[82vw] md:hidden"
        overlayClassName="md:hidden"
      >
        <Sidebar
          {...sidebarProps}
          onSelect={(id) => {
            selectSession(id);
            setMobileNavOpen(false);
          }}
          onNew={() => {
            newSession();
            setMobileNavOpen(false);
          }}
          onCollapse={() => setMobileNavOpen(false)}
        />
      </Sheet>

      <main className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          agent={agent}
          onAgentClick={() => setPickerOpen(true)}
          sidebarCollapsed={collapsed}
          onExpandSidebar={() => setCollapsed(false)}
          onNew={newSession}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          theme={theme}
          onCycleTheme={cycle}
        />

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {showEmpty ? (
            <EmptyState agent={agent} onPick={send} onChangeAgent={() => setPickerOpen(true)} />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-7 px-5 py-8">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <UserMessage key={m.id} content={m.content} />
                ) : (
                  <AssistantMessage
                    key={m.id}
                    message={m}
                    toolCards={[]}
                    onRegenerate={i === messages.length - 1 && !busy ? regenerate : undefined}
                  />
                ),
              )}
              {busy && (
                <AssistantMessage
                  message={{
                    id: "streaming",
                    role: "assistant",
                    content: streamText,
                    createdAt: new Date().toISOString(),
                  }}
                  streaming
                  toolCards={toolCards}
                />
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 pb-3">
          {chatError && (
            <ErrorBanner
              error={chatError}
              onRetry={() => {
                const t = chatError.retryText;
                setChatError(null);
                send(t);
              }}
              onDismiss={() => setChatError(null)}
            />
          )}
          <Composer
            onSend={send}
            busy={busy}
            onStop={demo ? () => (stopRef.current = true) : interrupt}
            model={agent.name}
            placeholder={`和「${agent.name}」对话…`}
          />
        </div>
      </main>

      <AgentPicker
        open={pickerOpen}
        current={agent}
        onClose={() => setPickerOpen(false)}
        onPick={(a) => {
          setAgent(a);
          setPickerOpen(false);
          setChatError(null);
        }}
      />

      <SettingsCenter
        open={settingsOpen}
        billing={null}
        user={user}
        theme={theme}
        onClose={() => setSettingsOpen(false)}
        onSetTheme={setTheme}
        onReauth={clearAuth}
      />
    </div>
  );
}
