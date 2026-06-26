import { useCallback, useEffect, useRef, useState } from "react";
import { AuthGate } from "./components/AuthGate";
import { ChatHeader } from "./components/ChatHeader";
import { Composer } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { ErrorBanner, type ChatError } from "./components/ErrorBanner";
import { Landing } from "./components/Landing";
import { AssistantMessage, UserMessage } from "./components/Message";
import { Sidebar } from "./components/Sidebar";
import { AgentPicker } from "./components/AgentPicker";
import { SettingsCenter } from "./components/SettingsCenter";
import { Sheet } from "./components/ui";
import { useTheme } from "./hooks/useTheme";
import { DEFAULT_AGENT } from "./lib/agents";
import { api } from "./lib/api";
import { DEMO_MESSAGES, DEMO_SESSIONS, DEMO_USER, demoReply } from "./lib/demo";
import type { AuthSession, Billing, Message, Session, ToolCard, User } from "./lib/types";

export function App() {
  const params = new URLSearchParams(location.search);
  const demo = params.get("demo") === "1";
  // P2a：access token 仅存于内存，刷新即丢失，所以启动一律落到首页/登录（无自动登录）。
  const [view, setView] = useState<"home" | "app">("home");
  // 主题的唯一权威源：useTheme 是「挂载读 localStorage」的单实例，经 props 下传给顶栏快捷开关
  // 与设置中心「偏好·外观」分区，二者共享同一状态——杜绝多个 useTheme 实例各自镜像、互不同步。
  const { theme, setTheme, cycle } = useTheme();

  // access token 仅存内存：放在 ref 里作为唯一权威源，AuthSession.getToken/setToken 读写它，
  // 静默刷新成功后 api 层直接回写 ref，下一次鉴权请求即拿到新 token（无 stale 闭包）。
  // `authed` 仅作渲染门控（是否进入工作区），不持有 token 本体。
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
  const [toolCards, setToolCards] = useState<ToolCard[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [agent, setAgent] = useState(DEFAULT_AGENT);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chatError, setChatError] = useState<ChatError | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  // 鉴权世代：登出/换号即自增。loadBilling 等 fire-and-forget 请求捕获发起时的世代，
  // 回写前校验世代未变，杜绝旧账户的在途响应在登出/换号后串号写入新状态（计费/隐私一致性）。
  const authEpochRef = useRef(0);

  // 清空全部鉴权 + 会话状态，回到登录/首页（静默刷新失败或主动登出都走这里）。
  const clearAuth = useCallback(() => {
    authEpochRef.current += 1; // 作废旧账户所有在途 fire-and-forget 请求的回写。
    tokenRef.current = null;
    setAuthed(false);
    setUser(null);
    setSessions([]);
    setMessages([]);
    setActiveId(undefined);
    setChatError(null);
    setBilling(null);
    setSettingsOpen(false);
    setView("home");
  }, []);

  // 刷新余额/账单：登录后与每条消息计费后调用，让用户实时看到余额变化。demo 不计费。
  // 捕获发起时的鉴权世代，回写前校验未变——旧账户的迟到响应不会串号写入新状态。
  const loadBilling = useCallback(() => {
    if (demo || !tokenRef.current) return;
    const epoch = authEpochRef.current;
    void api.billing(authRef.current).then((b) => {
      if (b && authEpochRef.current === epoch) setBilling(b);
    });
  }, [demo]);

  // AuthSession：access token 的唯一权威源（仅存内存）。整个生命周期复用同一引用，
  // 传给 api.* 的所有鉴权请求；命中 401 时 api 内部透明刷新并 setToken 回写本 ref。
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
  // 仅当已认证时把 session 暴露给业务逻辑；未认证时为 null，沿用既有 `if (!auth) return` 守卫。
  const auth = authed ? authRef.current : null;

  // Cancel any in-flight stream and reset transient streaming state. Bumping
  // seqRef invalidates stale stream callbacks so they can't bleed into a new
  // session view.
  const interrupt = useCallback(() => {
    stopRef.current = true;
    abortRef.current?.abort();
    abortRef.current = null;
    seqRef.current += 1;
    setBusy(false);
    setStreamText("");
    setToolCards([]);
    setChatError(null);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    authEpochRef.current += 1; // 新身份会话边界：作废上一身份的在途回写（防御换号）。
    setAuthLoading(true);
    setAuthError(null);
    try {
      // 登录拿到内存态 accessToken + 用户信息；token 只写进 tokenRef（内存），绝不落地。
      const { accessToken, user: me } = await api.login(email, password);
      tokenRef.current = accessToken;
      const a = authRef.current;
      const ss = await api.listSessions(a);
      setAuthed(true);
      setUser(me);
      setSessions(ss.sort((x, y) => +new Date(y.updatedAt) - +new Date(x.updatedAt)));
      if (ss[0]) {
        setActiveId(ss[0].id);
        const m = await api.getMessages(a, ss[0].id);
        setMessages(m.messages);
      }
      loadBilling();
    } catch (e) {
      setAuthError((e as Error).message || "登录失败");
    } finally {
      setAuthLoading(false);
    }
  }, [loadBilling]);

  const selectSession = useCallback(
    async (id: string) => {
      if (id === activeId) return;
      if (busy) interrupt();
      setChatError(null);
      setActiveId(id);
      if (demo) {
        setMessages(id === DEMO_SESSIONS[0].id ? DEMO_MESSAGES : []);
        return;
      }
      if (!auth) return;
      try {
        const m = await api.getMessages(auth, id);
        setMessages(m.messages);
      } catch {
        setMessages([]);
      }
    },
    [activeId, auth, busy, demo],
  );

  const newSession = useCallback(async () => {
    interrupt();
    setMessages([]);
    if (demo) {
      const s: Session = {
        id: "demo-" + Date.now(),
        title: "新对话",
        ownerUserId: "demo",
        updatedAt: new Date().toISOString(),
        messageCount: 0,
      };
      setSessions((c) => [s, ...c]);
      setActiveId(s.id);
      return;
    }
    if (!auth) return;
    try {
      const s = await api.createSession(auth);
      setSessions((c) => [s, ...c]);
      setActiveId(s.id);
    } catch {
      /* ignore */
    }
  }, [auth, demo]);

  const send = useCallback(
    async (text: string) => {
      setChatError(null);
      let sessionId = activeId;
      const userMsg: Message = {
        id: "tmp-" + Date.now(),
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
      };

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
          { id: "a-" + Date.now(), role: "assistant", content: full, createdAt: new Date().toISOString() },
        ]);
        setStreamText("");
        setBusy(false);
        return;
      }

      if (!auth) return;
      if (!sessionId) {
        try {
          const s = await api.createSession(auth, text.slice(0, 24));
          setSessions((c) => [s, ...c]);
          setActiveId(s.id);
          sessionId = s.id;
        } catch {
          return;
        }
      }
      const seq = ++seqRef.current;
      const current = () => seqRef.current === seq;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setMessages((m) => [...m, userMsg]);
      setBusy(true);
      setStreamText("");
      setToolCards([]);
      let acc = "";
      let doneFired = false;
      try {
        await api.stream(
          auth,
          sessionId!,
          text,
          {
            onDelta: (t) => {
              if (!current()) return;
              acc += t;
              setStreamText((c) => c + t);
            },
            // 按 id upsert：流式工具卡同一 id 多帧（pending→running→ok）应更新同一张卡，而非追加多张。
            onToolCard: (c) =>
              current() &&
              setToolCards((cur) => {
                const i = cur.findIndex((x) => x.id === c.id);
                if (i === -1) return [...cur, c];
                const next = [...cur];
                next[i] = c;
                return next;
              }),
            onError: (err) =>
              current() && setChatError({ message: err.message, requestId: err.requestId, retryText: text }),
            onDone: ({ session, messages: msgs }) => {
              if (!current()) return;
              doneFired = true;
              setMessages(msgs);
              setSessions((cur) => [session, ...cur.filter((s) => s.id !== session.id)]);
              loadBilling(); // 计费后刷新余额，让用户实时看到扣费。
            },
          },
          ctrl.signal,
          agent.id,
        );
        // Network/proxy cut the stream before `done` — keep what we streamed.
        if (current() && !doneFired && acc.trim()) {
          setMessages((m) => [
            ...m,
            { id: "a-" + Date.now(), role: "assistant", content: acc, createdAt: new Date().toISOString() },
          ]);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError" || !current()) return;
        // 已流出的部分保留为一条 assistant 消息；并用错误卡片(含追踪号)+重试呈现失败。
        if (acc.trim()) {
          setMessages((m) => [
            ...m,
            { id: "a-" + Date.now(), role: "assistant", content: acc, createdAt: new Date().toISOString() },
          ]);
        }
        // HTTP 错误信息已由 api 层附带「（追踪号 …）」，此处直接展示（如余额不足 402 文案）。
        setChatError({ message: (e as Error).message || "发送失败，请重试", retryText: text });
        loadBilling(); // 失败（含余额不足）后刷新余额，便于用户核对。
      } finally {
        if (current()) {
          setBusy(false);
          setStreamText("");
          setToolCards([]);
          abortRef.current = null;
        }
      }
    },
    [activeId, auth, demo, agent, loadBilling],
  );

  // 重新生成：重发上一条用户消息（走标准 send；服务端 done 帧会用权威历史覆盖）。
  const regenerate = useCallback(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        send(messages[i].content);
        return;
      }
    }
  }, [messages, send]);

  const logout = useCallback(() => {
    // 先请求后端吊销刷新 cookie（错误已在 api 层吞掉），再清空内存态回到首页。
    if (!demo) void api.logout();
    clearAuth();
  }, [demo, clearAuth]);

  // autoscroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamText]);

  // 键盘快捷键（易用性）：⌘/Ctrl+K 新会话；Esc 停止当前流式。仅在进入工作区后生效。
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

  // 侧栏公共 props：桌面内联与移动抽屉两处复用（移动端 onSelect/onNew 额外关抽屉）。
  const renameSessionPrompt = (s: Session) => {
    const t = prompt("重命名会话", s.title);
    if (t && auth && !demo) api.renameSession(auth, s.id, t).then((ns) => setSessions((c) => c.map((x) => (x.id === ns.id ? ns : x))));
    else if (t) setSessions((c) => c.map((x) => (x.id === s.id ? { ...x, title: t } : x)));
  };
  const deleteSessionConfirm = (s: Session) => {
    if (!confirm("删除该会话？")) return;
    if (auth && !demo) api.deleteSession(auth, s.id).catch(() => {});
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
    balanceCents: billing?.balanceCents,
    onOpenAccount: demo ? undefined : () => setSettingsOpen(true),
    onNew: newSession,
    onRename: renameSessionPrompt,
    onDelete: deleteSessionConfirm,
    onLogout: demo ? undefined : logout,
  };

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-fg">
      {/* 桌面：内联侧栏（可折叠）。md:contents 让 wrapper 在桌面透明，aside 直接参与父 flex；窄屏隐藏。 */}
      {!collapsed && (
        <div className="hidden md:contents">
          <Sidebar {...sidebarProps} onSelect={selectSession} onCollapse={() => setCollapsed(true)} />
        </div>
      )}

      {/* 移动：侧栏抽屉（窄屏由 header 汉堡打开）。Sheet 原语提供遮罩/Escape/焦点陷阱。 */}
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
          // 切 agent 即换了重试上下文：清掉旧错误横幅，避免用错 agent 重发。
          setChatError(null);
        }}
      />

      <SettingsCenter
        open={settingsOpen}
        billing={billing}
        user={user}
        theme={theme}
        onClose={() => setSettingsOpen(false)}
        onSetTheme={setTheme}
        onChangePassword={(cur, next) => api.changePassword(authRef.current, cur, next).then(() => undefined)}
        onReauth={clearAuth}
      />
    </div>
  );
}
