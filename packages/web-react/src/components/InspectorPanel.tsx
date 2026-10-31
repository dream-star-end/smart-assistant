/**
 * InspectorPanel —— 详情面板(右侧第三栏,OCV5-370 改版)。
 *
 * 一个面板三个分区,数据全部来自会话自己的消息(不打后端):
 *   - 产出:会话里全部轮次的产出文件、媒体、预览链接与网页来源(按轮分组,当前轮在上);
 *   - 步骤:会话里每一次工具调用,按轮分组(最近一轮在上),点一步进入全文详情;
 *   - 计划:会话里最近一份 TodoWrite / plan(只读;没有计划时不出这个分区)。
 *
 * 各分区正文(OutputsView / BrowserView / InspectorStepsPlanView)均按需懒加载,移出首屏静态闭包。
 */
import { X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  lazy,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatMessage } from "../lib/chat/model";
import { cn } from "../lib/utils";
import { extractLatestTodos } from "./chat/PinnedTaskTracker";
import { collectPaneSteps } from "./chat/workPane";
import { collectWorkTurns, turnIndexOf } from "./chat/workTurns";
import { isBrowserStepMessage } from "./tool/browserDetect";
import type { ToolLike } from "./tool/format";
import { IconButton, Skeleton, Spinner, Tabs } from "./ui";

// 产出 / 浏览器 / 步骤与计划视图均按需懒加载,不进首屏(first-screen-budget)。
const OutputsView = lazy(() => import("./chat/OutputsView").then((m) => ({ default: m.OutputsView })));
const BrowserView = lazy(() => import("./chat/BrowserView").then((m) => ({ default: m.BrowserView })));

type StepsPlanModule = typeof import("./chat/InspectorStepsPlanView");
let loadedStepsPlan: StepsPlanModule | null = null;
let pendingStepsPlan: Promise<StepsPlanModule> | null = null;

export function preloadInspectorStepsPlan(): Promise<StepsPlanModule> {
  pendingStepsPlan ??= import("./chat/InspectorStepsPlanView").then(
    (module) => {
      loadedStepsPlan = module;
      return module;
    },
    (error: unknown) => {
      pendingStepsPlan = null;
      throw error;
    },
  );
  return pendingStepsPlan;
}

const LazyStepsPlanView = lazy(() => {
  const ready = loadedStepsPlan;
  if (ready) {
    const sync = {
      // biome-ignore lint/suspicious/noThenProperty: 模块已就绪时给 React.lazy 的同步 thenable(同 lazyToolBody),当场解析不挂起。
      then(resolve: (value: { default: StepsPlanModule["InspectorStepsPlanView"] }) => void) {
        resolve({ default: ready.InspectorStepsPlanView });
      },
    };
    return sync as unknown as Promise<{ default: StepsPlanModule["InspectorStepsPlanView"] }>;
  }
  return preloadInspectorStepsPlan().then((module) => ({ default: module.InspectorStepsPlanView }));
});

if (typeof window !== "undefined") {
  const prefetch = () => {
    preloadInspectorStepsPlan().catch(() => {});
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (idle) idle(prefetch);
  else window.setTimeout(prefetch, 1500);
}

function isEditableTarget(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

export type PaneTab = "outputs" | "steps" | "plan" | "browser";

/**
 * 从面板外打开 / 定位面板的请求(工具卡入口、过程摘要上的「改动 N 个文件」、顶栏开关、文件卡片预览)。
 * nonce 每次请求都换:同一条消息连点两次也会重新定位并把焦点移进面板。
 * tab 缺省 = 只开面板(停在上次的分区)。
 */
export type PaneRequest = {
  /** "changes" 是 r1 的改动页:改动并进了产出页,旧入口 / 旧记忆按产出处理。 */
  tab?: PaneTab | "changes";
  /** steps / browser:要打开的那一步;outputs:这一轮里的任意一行或 _output_file 文件定位。 */
  message?: ToolLike | null;
  nonce: number;
  /** 发起请求时的会话;App 只把属于当前会话的请求交给面板(切会话后旧请求作废)。 */
  sessionId?: string | null;
};

/**
 * 大记录(>1 MiB)在历史里只是定位桩(`_payloadDeferred`),正文按需取。面板复用聊天区同一套
 * 取数(App 的 cardCallbacks:页面内缓存 + 校验),不另起请求通道。
 */
export type DeferredPayloadLoader = {
  peek?: (
    tapeId: string,
    recordOrdinal: number,
    expected: { recordId: string; role: string; contentSha256?: string },
  ) => ChatMessage[] | null;
  fetch?: (
    tapeId: string,
    recordOrdinal: number,
    expected: { recordId: string; role: string; contentSha256?: string },
    signal?: AbortSignal,
  ) => Promise<ChatMessage[] | null>;
};

/** 只把属于当前会话的请求交给面板:请求在切会话前发出、面板在切会话后挂载时,旧请求作废。 */
export function paneRequestForSession(request: PaneRequest | null, sessionId: string | null | undefined): PaneRequest | null {
  return request && (request.sessionId ?? null) === (sessionId ?? null) ? request : null;
}

function idOf(message: ToolLike | null | undefined): string | undefined {
  const id = (message as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id ? id : undefined;
}

function sameMessage(a: ToolLike | null | undefined, b: ToolLike | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ia = idOf(a);
  return ia !== undefined && ia === idOf(b);
}

function pickRecord(records: ChatMessage[] | null, locator: ChatMessage): ChatMessage | null {
  if (!records || records.length === 0) return null;
  return records.find((r) => r.id === locator.id) ?? records.find((r) => r.role === "tool") ?? null;
}

function peekRecord(m: ChatMessage, loader?: DeferredPayloadLoader): ChatMessage | null {
  const tapeId = m._turnTapeId;
  const ordinal = m._recordOrdinal;
  if (!m.id || !loader?.peek || typeof tapeId !== "string" || typeof ordinal !== "number") return null;
  return pickRecord(loader.peek(tapeId, ordinal, expectedOf(m)), m);
}

function expectedOf(m: ChatMessage) {
  return { recordId: m.id, role: m.role, ...(m._payloadSha256 ? { contentSha256: m._payloadSha256 } : {}) };
}

/** 可按需取正文的 tool 定位桩的身份键(tape + 序号 + id);取不了的返回 null。 */
function toolLocatorKey(m: ChatMessage): string | null {
  if (m._payloadDeferred !== true || m.role !== "tool" || !m.id) return null;
  if (typeof m._turnTapeId !== "string" || typeof m._recordOrdinal !== "number") return null;
  return `${m._turnTapeId}:${m._recordOrdinal}:${m.id}`;
}

export const PANE_TAB_STORAGE_KEY = "oc_v5_detail_pane_tab";
export const PANE_OPEN_STORAGE_KEY = "oc_v5_detail_pane_open";

/** 宽屏内联面板的宽度范围与记忆键(useResizableWidth;把手在面板左缘)。 */
export const DETAIL_PANE_WIDTH = {
  storageKey: "oc_v5_detail_pane_width",
  defaultWidth: 440,
  min: 320,
  max: 720,
  edge: "left",
} as const;

/** 宽屏面板是否展开(用户偏好,跨会话、跨刷新)。读不到存储 → 收起(与改版前一致)。 */
export function readDetailPaneOpen(): boolean {
  try {
    return localStorage.getItem(PANE_OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDetailPaneOpen(open: boolean): void {
  try {
    localStorage.setItem(PANE_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
}

function requestTab(tab: PaneTab | "changes"): PaneTab {
  return tab === "changes" ? "outputs" : tab;
}

function readStoredTab(): PaneTab {
  try {
    const v = localStorage.getItem(PANE_TAB_STORAGE_KEY);
    if (v === "steps" || v === "plan" || v === "outputs" || v === "browser") return v;
  } catch {
    /* private mode */
  }
  // 没记过 / r1 记的「改动」:产出页(改动已并进去)。
  return "outputs";
}

function writeStoredTab(tab: PaneTab): void {
  try {
    localStorage.setItem(PANE_TAB_STORAGE_KEY, tab);
  } catch {
    /* private mode / quota */
  }
}

function OutputsFallback() {
  return (
    <div className="space-y-3 px-4 py-4" data-testid="outputs-loading">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-48 w-full rounded-xl" />
    </div>
  );
}

/** 面板内容(分区 + 当前视图)。桌面 aside 与窄屏 Sheet 共用。`titleId` 供外层容器 aria-labelledby。 */
export function InspectorPanelContent({
  messages,
  version,
  running = false,
  request,
  deferredLoader,
  onClose,
  onActiveChange,
  titleId,
}: {
  messages: readonly ChatMessage[];
  /** 会话消息就地 mutate 的版本号;只用来让改动汇总随流式内容重算。 */
  version?: number;
  /** 本会话这一轮是否仍在进行(决定「跟随中」)。 */
  running?: boolean;
  request?: PaneRequest | null;
  /** 大记录定位桩的正文取数(聊天区同一套缓存);不传则定位桩显示「没能加载」。 */
  deferredLoader?: DeferredPayloadLoader;
  onClose: () => void;
  /** 当前在详情里查看的那一步 → 源卡片选中态(T-18)。 */
  onActiveChange?: (message: ToolLike | null) => void;
  titleId?: string;
}) {
  // 浏览器卡点进来:那一步不在顶层轮里(团队子任务等)就退回步骤详情,不落到一个没有它的「浏览器」页。
  const resolveTab = (req: PaneRequest): PaneTab | null => {
    if (!req.tab) return null;
    if (req.tab === "browser" && req.message && turnIndexOf(collectWorkTurns(messages), req.message as { id?: string }) < 0) {
      return "steps";
    }
    return requestTab(req.tab);
  };
  const [tab, setTabState] = useState<PaneTab>(() => (request ? resolveTab(request) : null) ?? readStoredTab());
  const [selected, setSelected] = useState<ToolLike | null>(() =>
    request && resolveTab(request) === "steps" ? (request.message ?? null) : null,
  );
  const fallbackTitleId = useId();
  const headingId = titleId ?? fallbackTitleId;
  const idBase = useId();

  const setTab = (next: PaneTab) => {
    setTabState(next);
    writeStoredTab(next);
  };

  const { turns, steps } = collectPaneSteps(messages);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 是就地 mutate 消息的变更信号
  const workTurns = useMemo(() => collectWorkTurns(messages), [messages, version]);
  const todos = extractLatestTodos(messages, 0);
  const lastTurn = workTurns.length - 1;
  // 产出页定位的那一轮:null = 最新一轮;从旧轮摘要点进来时记它的 key。
  const turnKeyFor = (message: ToolLike | null | undefined): string | null => {
    const i = turnIndexOf(workTurns, message as { id?: string } | null | undefined);
    return i < 0 || i === lastTurn ? null : (workTurns[i]?.key ?? null);
  };
  const turnScoped = (t: PaneRequest["tab"]) => t !== undefined && (requestTab(t) === "outputs" || t === "browser");
  const [turnKey, setTurnKey] = useState<string | null>(() =>
    request && turnScoped(request.tab) ? turnKeyFor(request.message) : null,
  );
  const keyedTurn = turnKey === null ? -1 : workTurns.findIndex((t) => t.key === turnKey);
  const outputsIndex = keyedTurn >= 0 ? keyedTurn : lastTurn;
  const extractOutputFile = (m: ToolLike | null | undefined): string | null => {
    if (!m || m.toolName !== "_output_file" || !m.inputJson || typeof m.inputJson !== "object") return null;
    const p = (m.inputJson as { file_path?: unknown }).file_path;
    return typeof p === "string" && p ? p : null;
  };
  const [outputFocus, setOutputFocus] = useState<{ path: string; nonce: number } | null>(() => {
    const p = request ? extractOutputFile(request.message) : null;
    return p && request ? { path: p, nonce: request.nonce } : null;
  });
  // 「浏览器」页看的那一步(从浏览器卡点进来时);null = 默认(最新一张截图)。
  const [browserFocus, setBrowserFocus] = useState<string | null>(() =>
    request?.tab === "browser" ? (idOf(request.message) ?? null) : null,
  );
  const latest = steps.at(-1)?.message ?? null;
  // 首次挂载带着请求(面板 / 底部抽屉刚打开)时和后续请求一样:运行中点开最新那张卡就跟随。
  const [follow, setFollow] = useState(
    () => !!request && resolveTab(request) === "steps" && !!request.message && running && sameMessage(request.message, latest),
  );
  // 选中按消息 id 记:历史重载 / 同步会用同 id 的新对象替换旧行,按引用记会停在旧正文上。
  // 不在顶层步骤里的消息(团队子任务 / demo)按原对象显示。
  const resolveSelected = (m: ToolLike | null): ToolLike | null => {
    if (!m) return null;
    const id = idOf(m);
    return (id ? steps.find((s) => s.message.id === id)?.message : undefined) ?? m;
  };
  // 「步骤」页只覆盖 plan / browser 的回退,tab === "steps" 时 view 必是 steps。
  const stepShown: ToolLike | null = tab === "steps" ? (follow ? latest : resolveSelected(selected)) : null;

  // 大记录定位桩没有命令和输出,认不出是浏览器步:换成请求带来的完整消息,或页面缓存里已取到的正文。
  const clicked = request?.message as ChatMessage | undefined;
  const clickedFull = (m: ChatMessage) => (clicked?._payloadDeferred !== true && sameMessage(clicked, m) ? clicked : null);
  const loaderRef = useRef(deferredLoader);
  loaderRef.current = deferredLoader;
  const probeRef = useRef<{ controller: AbortController; started: Set<string>; records: Map<string, ChatMessage | null> } | null>(null);
  const [probeVersion, setProbeVersion] = useState(0);
  const probedRecord = (m: ChatMessage): ChatMessage | null => {
    const key = toolLocatorKey(m);
    return (key && probeRef.current?.records.get(key)) || null;
  };
  const stepShownId = idOf(stepShown);
  const probeTargets = (workTurns[outputsIndex]?.steps ?? []).filter((m) => {
    const key = toolLocatorKey(m);
    if (!key || m.id === stepShownId || clickedFull(m)) return false;
    if (probeRef.current?.records.has(key)) return false;
    return !peekRecord(m, deferredLoader);
  });
  const probeKey = probeTargets.map((m) => toolLocatorKey(m)).join("|");
  const browserProbing = probeTargets.length > 0 && !!deferredLoader?.fetch;
  // biome-ignore lint/correctness/useExhaustiveDependencies: probeKey 已覆盖目标集合;loader 经 ref 读,避免每次渲染新对象触发重取
  useEffect(() => {
    const fetchRecord = loaderRef.current?.fetch;
    if (!fetchRecord || probeTargets.length === 0) return;
    probeRef.current ??= { controller: new AbortController(), started: new Set(), records: new Map() };
    const probe = probeRef.current;
    for (const m of probeTargets) {
      const key = toolLocatorKey(m);
      if (!key || probe.started.has(key)) continue;
      probe.started.add(key);
      fetchRecord(m._turnTapeId as string, m._recordOrdinal as number, expectedOf(m), probe.controller.signal)
        .then(
          (records) => pickRecord(records, m),
          () => null,
        )
        .then((record) => {
          if (probe.controller.signal.aborted) return;
          probe.records.set(key, record);
          setProbeVersion((n) => n + 1);
        });
    }
  }, [probeKey]);
  useEffect(
    () => () => {
      probeRef.current?.controller.abort();
      probeRef.current = null;
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: probeVersion 是补取正文到达的信号(正文在 ref 里)
  const browserTurns = useMemo(
    () =>
      workTurns.map((t) => ({
        ...t,
        steps: t.steps.map((m) =>
          m._payloadDeferred === true ? (clickedFull(m) ?? peekRecord(m, deferredLoader) ?? probedRecord(m) ?? m) : m,
        ),
      })),
    [workTurns, clicked, deferredLoader, probeVersion],
  );
  const viewedTurn = browserTurns[outputsIndex];
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 是就地 mutate 消息的变更信号
  const browserCount = useMemo(
    () => (viewedTurn ? viewedTurn.steps.filter((m) => isBrowserStepMessage(m)).length : 0),
    [viewedTurn, version],
  );
  const browserPending = tab === "browser" && browserCount === 0 && browserProbing;

  const view: PaneTab =
    (tab === "plan" && todos.length === 0) || (tab === "browser" && browserCount === 0 && !browserPending)
      ? "outputs"
      : tab;
  const shown: ToolLike | null = view === "steps" ? stepShown : null;
  const index = shown ? steps.findIndex((s) => sameMessage(s.message, shown)) : -1;
  const following = follow && running && !!latest;

  const handledNonce = useRef(request?.nonce);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只响应新请求(nonce);latest / running 取请求到来那一刻
  useEffect(() => {
    if (!request || request.nonce === handledNonce.current) return;
    handledNonce.current = request.nonce;
    const next = resolveTab(request);
    if (!next) return;
    setTabState(next);
    if (next === "outputs" || next === "browser") setTurnKey(turnKeyFor(request.message));
    if (next === "outputs") {
      const p = extractOutputFile(request.message);
      setOutputFocus(p ? { path: p, nonce: request.nonce } : null);
    }
    if (next === "browser") setBrowserFocus(idOf(request.message) ?? null);
    if (next === "steps") {
      setSelected(request.message ?? null);
      setFollow(!!request.message && running && sameMessage(request.message, latest));
    }
  }, [request]);

  useEffect(() => {
    onActiveChange?.(shown);
  }, [shown, onActiveChange]);
  useEffect(() => () => onActiveChange?.(null), [onActiveChange]);

  const pick = (message: ToolLike) => {
    setSelected(message);
    setFollow(running && sameMessage(message, latest));
  };
  const goTo = (i: number) => {
    const target = steps[i]?.message;
    if (target) pick(target);
  };
  const openStep = (message: ToolLike) => {
    setTab("steps");
    setSelected(message);
    setFollow(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (view !== "steps" || !shown || index < 0) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    if (isEditableTarget(e.target)) return;
    const el = e.target instanceof HTMLElement ? e.target : null;
    if (el?.closest('[role="tablist"],[role="separator"]')) return;
    const key = e.key.toLowerCase();
    if ((key === "arrowleft" || key === "k") && index > 0) {
      e.preventDefault();
      goTo(index - 1);
    } else if ((key === "arrowright" || key === "j") && index < steps.length - 1) {
      e.preventDefault();
      goTo(index + 1);
    }
  };

  const count = (n: number) => (n > 0 ? <span className="ml-1 tabular-nums text-faint">{n}</span> : null);
  const tabItems = [
    { value: "outputs", label: <span>产出</span> },
    ...(browserCount > 0 || browserPending ? [{ value: "browser", label: <span>浏览器{count(browserCount)}</span> }] : []),
    { value: "steps", label: <span>步骤{count(steps.length)}</span> },
    ...(todos.length > 0 ? [{ value: "plan", label: <span>计划</span> }] : []),
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface" onKeyDown={onKeyDown} data-testid="detail-pane">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 header-safe-t">
        <h2 id={headingId} className="sr-only">
          详情面板
        </h2>
        <div className="min-w-0 flex-1">
          <Tabs
            value={view}
            onValueChange={(v) => setTab(v as PaneTab)}
            items={tabItems}
            idBase={idBase}
            aria-label="详情面板分区"
          />
        </div>
        <IconButton aria-label="关闭详情面板" size="sm" shape="square" data-inspector-close="" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </header>
      <div
        id={`${idBase}-panel-${view}`}
        role="tabpanel"
        aria-labelledby={`${idBase}-tab-${view}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {view === "steps" ? (
          <Suspense fallback={<OutputsFallback />}>
            <LazyStepsPlanView
              mode="steps"
              shown={shown}
              loader={deferredLoader}
              index={index}
              total={steps.length}
              following={following}
              showLatest={!!latest && !sameMessage(shown, latest)}
              onBack={() => {
                setSelected(null);
                setFollow(false);
              }}
              onPrev={() => goTo(index - 1)}
              onNext={() => goTo(index + 1)}
              onLatest={() => setFollow(true)}
              turns={turns}
              active={selected}
              onPick={pick}
            />
          </Suspense>
        ) : view === "browser" && browserPending ? (
          <div className="flex items-center gap-2 px-4 py-4 text-meta text-muted" data-testid="browser-hydrating">
            <Spinner size={13} className="text-accent" />
            正在读取这一轮的浏览器记录…
          </div>
        ) : view === "browser" ? (
          <Suspense fallback={<OutputsFallback />}>
            <BrowserView
              turns={browserTurns}
              index={outputsIndex}
              running={running && outputsIndex === lastTurn}
              focusId={browserFocus}
              onSelectTurn={(i) => {
                const t = workTurns[i];
                if (t) setTurnKey(i === lastTurn ? null : t.key);
                setBrowserFocus(null);
              }}
              onOpenSteps={() => {
                setTab("steps");
                setSelected(null);
                setFollow(false);
              }}
              onOpenStep={openStep}
            />
          </Suspense>
        ) : view === "outputs" ? (
          <Suspense fallback={<OutputsFallback />}>
            <OutputsView
              messages={messages}
              turns={workTurns}
              focusTurnKey={turnKey}
              focusFile={outputFocus}
              running={running}
              onOpenSteps={() => {
                setTab("steps");
                setSelected(null);
                setFollow(false);
              }}
              onOpenStep={openStep}
            />
          </Suspense>
        ) : (
          <Suspense fallback={<OutputsFallback />}>
            <LazyStepsPlanView mode="plan" todos={todos} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

/**
 * 宽屏第三列:内联 aside(与 Sidebar/main 并列),左缘拖宽把手(键盘 ← → / Home / End,双击复位)。
 * 焦点管理(T-24):从外面点开(focusNonce 变化)时焦点进面板(关闭按钮),卸载时归还到打开它的那个入口;
 * 页面加载时按记忆直接展开的面板不抢焦点。Escape 只在焦点在面板里时关闭面板 —— 面板现在可以常开,
 * 在别处按 Esc(取消输入法、关弹层、停止生成)不该顺手把它关掉。
 */
export function InspectorPanel({
  width,
  resizing = false,
  widthMin,
  widthMax,
  onResizeStart,
  onResizeKeyDown,
  focusNonce,
  onClose,
  ...content
}: Omit<Parameters<typeof InspectorPanelContent>[0], "titleId"> & {
  width?: number;
  resizing?: boolean;
  widthMin?: number;
  widthMax?: number;
  onResizeStart?: (e: ReactPointerEvent) => void;
  onResizeKeyDown?: (e: ReactKeyboardEvent) => void;
  focusNonce?: number;
}) {
  const asideRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Radix 弹层(Dialog/Sheet/Popover)处理过的 Escape 会 preventDefault,不抢。
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (!(e.target instanceof Node) || !asideRef.current?.contains(e.target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 每次从外面点开(换了一步 / 点了顶栏开关)都记下当时的焦点元素并把焦点移进面板;
  // 面板整体卸载时把焦点还给最后那个入口。
  useEffect(() => {
    if (focusNonce === undefined) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      !asideRef.current?.contains(active)
    ) {
      returnFocusRef.current = active;
    }
    const raf = requestAnimationFrame(() => {
      asideRef.current?.querySelector<HTMLElement>("[data-inspector-close]")?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusNonce]);

  useEffect(
    () => () => {
      const el = returnFocusRef.current;
      if (el?.isConnected) el.focus();
    },
    [],
  );

  return (
    <aside
      ref={asideRef}
      aria-labelledby={titleId}
      style={width !== undefined ? { width } : undefined}
      className={cn(
        "relative flex min-h-0 max-w-[45vw] shrink-0 flex-col border-l border-border",
        width === undefined && "w-[clamp(20rem,36vw,34rem)]",
        resizing && "select-none",
      )}
    >
      {onResizeStart && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整详情面板宽度"
          aria-valuenow={width}
          aria-valuemin={widthMin}
          aria-valuemax={widthMax}
          title="拖动调整宽度，双击复位默认宽度"
          tabIndex={onResizeKeyDown ? 0 : undefined}
          onKeyDown={onResizeKeyDown}
          onPointerDown={onResizeStart}
          data-testid="pane-resize-handle"
          className={cn(
            "absolute inset-y-0 left-0 z-10 w-1 -translate-x-1/2 cursor-col-resize touch-none outline-none hover:bg-accent/40 focus-visible:bg-accent/60",
            resizing && "bg-accent/40",
          )}
        />
      )}
      <InspectorPanelContent {...content} onClose={onClose} titleId={titleId} />
    </aside>
  );
}
