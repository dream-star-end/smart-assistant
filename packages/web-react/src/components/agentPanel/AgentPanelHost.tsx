/**
 * AgentPanelHost —— 「Agent 电脑」面板的宿主（PRD_MANUS_A F1.1 / F1.4 / F1.5 / F1.6；DESIGN §3、§6–§8）。
 *
 *   useAgentPanelController(messages, sending, opts)  在 App 里持有状态机（跟随 / 固定 / 步骤 /
 *       折叠），并给 ArtifactInspectContext.open 提供 pinMessage 入口（工具卡表头 / 「查看全文」）。
 *   <AgentPanelHost controller …/>                     桌面 md+：第三列 aside（展开）或 48px rail（折叠）；
 *       窄屏：composer 上方 chip（可 portal 到 chipSlot）+ 贴底 Sheet。
 *
 * 焦点（DESIGN §16.2）：自动打开 / 自动跟随不移焦；用户主动打开（点卡 / 点 chip / 点产物预览 /
 * 点 rail 展开）才把焦点移到关闭按钮，aside 卸载时归还。aria-live 只在 follow 目标切换时播报一次。
 */
import { PanelRightOpen } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMdViewport } from "../../hooks/useMdViewport";
import { readAgentPanelCollapsed, writeAgentPanelCollapsed } from "../../lib/agentPanelCollapsed";
import {
  type AgentPanelState,
  agentPanelReduce,
  currentTarget,
  initialAgentPanelState,
  stepInfo,
} from "../../lib/chat/agentPanelFollow";
import type { ChatMessage } from "../../lib/chat/model";
import { cn } from "../../lib/utils";
import { extractLatestTodos } from "../chat/PinnedTaskTracker";
import { type ToolLike, normalizeToolForDisplay } from "../tool/format";
import { resolveToolMeta } from "../tool/meta";
import { resolveToolStatus } from "../tool/status";
import { toneTileClass } from "../tool/tone";
import { Sheet } from "../ui";
import { AgentPanelContent } from "./AgentPanel";
import { AgentPanelChip, STATUS_DOT_CLS } from "./AgentPanelChip";
import { resolveActionKind } from "./actionKind";
import { AGENT_PANEL_STRINGS as S, liveAnnounce, railLabel } from "./strings";

export type AgentPanelController = {
  state: AgentPanelState;
  messages: ChatMessage[];
  sending: boolean;
  /** false = 看板占据 main / demo / gated：面板与 chip 都不渲染，但状态保留（关看板后按当前状态恢复）。 */
  enabled: boolean;
  /** 侧栏当前实际宽度（折叠为 0），自动打开时决定展开还是 rail（★4）。 */
  sidebarWidth: number;
  target: ToolLike | null;
  k: number;
  n: number;
  pinMessage: (message: ToolLike) => void;
  pinIndex: (index: number) => void;
  step: (delta: 1 | -1) => void;
  follow: () => void;
  close: () => void;
  reset: () => void;
};

export function useAgentPanelController(
  messages: ChatMessage[],
  sending: boolean,
  opts: { enabled?: boolean; sidebarWidth?: number } = {},
): AgentPanelController {
  const [state, dispatch] = useReducer(agentPanelReduce, undefined, initialAgentPanelState);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // ChatSocket 就地 mutate 消息对象（running → completed 不改数组长度），每次 render 都同步一次；
  // reducer 对「没变化」返回同一引用，useReducer 直接 bail out，不会循环。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意每次 render 同步
  useEffect(() => {
    dispatch({ type: "sync", messages });
  });

  const pinMessage = useCallback(
    (message: ToolLike) => dispatch({ type: "pinMessage", message, messages: messagesRef.current }),
    [],
  );
  const pinIndex = useCallback((index: number) => dispatch({ type: "pin", index }), []);
  const step = useCallback((delta: 1 | -1) => dispatch({ type: "step", delta, messages: messagesRef.current }), []);
  const follow = useCallback(() => dispatch({ type: "follow", messages: messagesRef.current }), []);
  const close = useCallback(() => dispatch({ type: "close" }), []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  const { k, n } = stepInfo(state, messages);
  const target = currentTarget(state, messages);
  return {
    state,
    messages,
    sending,
    enabled: opts.enabled ?? true,
    sidebarWidth: opts.sidebarWidth ?? 0,
    target,
    k,
    n,
    pinMessage,
    pinIndex,
    step,
    follow,
    close,
    reset,
  };
}

/** ★4：视口宽 − 侧栏宽 − aside 展开宽 ≥ 32rem 才自动展开，否则自动打开为 rail。 */
export function hasRoomForExpandedPanel(sidebarWidth: number, viewportWidth = window.innerWidth): boolean {
  const aside = Math.min(544, Math.max(320, viewportWidth * 0.36));
  return viewportWidth - sidebarWidth - aside >= 512;
}

function isEditableTarget(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

export function AgentPanelHost({
  controller,
  chipSlot,
  onOpenPreview,
  filesTab,
}: {
  controller: AgentPanelController;
  /** 窄屏 chip 的挂点（App 的 composer-safe-b 内）；不传则原地渲染。 */
  chipSlot?: HTMLElement | null;
  onOpenPreview?: (url: string) => void;
  /** M3-3 注入的「文件」页签内容。 */
  filesTab?: ReactNode;
}) {
  const isMd = useMdViewport();
  const { state, messages, sending, enabled, target, k, n } = controller;
  const visible = enabled && state.mode !== "hidden" && target !== null;
  const titleId = useId();
  const asideRef = useRef<HTMLElement>(null);

  // ── 折叠（F1.4）：持久化偏好 + 「空间不足自动 rail」（不写偏好）+ 用户主动打开的临时展开 ──
  const [collapsedPref, setCollapsedPref] = useState(readAgentPanelCollapsed);
  const [autoRail, setAutoRail] = useState(false);
  const [tempExpanded, setTempExpanded] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const collapsed = autoRail || (collapsedPref && !tempExpanded);

  const prevModeRef = useRef(state.mode);
  const prevOpenNonceRef = useRef(state.openNonce);
  useEffect(() => {
    const wasHidden = prevModeRef.current === "hidden";
    const userOpened = state.openNonce !== prevOpenNonceRef.current;
    if (state.mode !== "hidden" && wasHidden && !userOpened) {
      // 自动打开：偏好未折叠但空间不够 → rail（不写偏好）
      setAutoRail(!collapsedPref && !hasRoomForExpandedPanel(controller.sidebarWidth));
    }
    if (userOpened) {
      setAutoRail(false);
      if (collapsedPref) setTempExpanded(true);
    }
    if (state.mode === "hidden") setTempExpanded(false);
    prevModeRef.current = state.mode;
    prevOpenNonceRef.current = state.openNonce;
  }, [state.mode, state.openNonce, collapsedPref, controller.sidebarWidth]);

  const collapse = useCallback(() => {
    setCollapsedPref(true);
    writeAgentPanelCollapsed(true);
    setTempExpanded(false);
    setAutoRail(false);
  }, []);
  const expand = useCallback(() => {
    setCollapsedPref(false);
    writeAgentPanelCollapsed(false);
    setTempExpanded(false);
    setAutoRail(false);
    setFocusNonce((v) => v + 1);
  }, []);

  // ── 焦点：仅用户主动打开 / 换目标（openNonce）或点 rail 展开（focusNonce）时移入；卸载归还 ──
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const movedFocusRef = useRef(false);
  const showAside = visible && isMd && !collapsed;
  useEffect(() => {
    if (!showAside) return;
    if (state.openNonce === 0 && focusNonce === 0) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !asideRef.current?.contains(active)) {
      returnFocusRef.current = active;
    }
    const raf = requestAnimationFrame(() => {
      const el = asideRef.current?.querySelector<HTMLElement>("[data-inspector-close]");
      if (el) {
        el.focus();
        movedFocusRef.current = true;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [state.openNonce, focusNonce, showAside]);
  useEffect(() => {
    if (showAside) return;
    if (!movedFocusRef.current) return;
    movedFocusRef.current = false;
    const el = returnFocusRef.current;
    if (el?.isConnected) el.focus();
  }, [showAside]);

  // ── Escape 关闭（沿用 InspectorPanel 规则：可编辑元素内且不在面板里不抢；Radix 消费过的不抢） ──
  const close = controller.close;
  useEffect(() => {
    if (!showAside) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (isEditableTarget(e.target) && !asideRef.current?.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showAside, close]);

  // ── 派生：目标显示信息、动作类型、状态、任务源 ──
  const display = target ? normalizeToolForDisplay(target) : null;
  const meta = display ? resolveToolMeta(display.name, display.input) : null;
  const kind = display ? resolveActionKind(display.name, display.input) : null;
  const status = display ? resolveToolStatus(display) : null;
  // 任务源就地 mutate（TodoWrite 完成时替换 inputJson），每次 render 直接算：只扫当前 turn，很便宜。
  const todos = extractLatestTodos(messages);

  // ── aria-live：follow 目标切换时播报一次（同一目标不重复） ──
  const [liveText, setLiveText] = useState("");
  const label = meta?.label ?? "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在 followNonce 变化时播报一次
  useEffect(() => {
    if (state.mode !== "follow" || !label) return;
    setLiveText(liveAnnounce(k, n, label));
  }, [state.followNonce]);

  // ── 窄屏 Sheet ──
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    if (!visible) setSheetOpen(false);
  }, [visible]);
  useEffect(() => {
    if (isMd || !visible) return;
    if (state.openNonce !== 0) setSheetOpen(true);
  }, [state.openNonce, isMd, visible]);

  if (!visible || !display || !meta || !kind || !status || !target) return null;

  const targetKey = `${state.turnStart}:${state.targetIndex}:${target === state.externalTarget ? "x" : ""}`;
  const content = (variant: "aside" | "sheet") => (
    <AgentPanelContent
      target={target}
      mode={state.mode === "pinned" ? "pinned" : "follow"}
      turnActive={sending}
      k={k}
      n={n}
      todos={todos}
      onPrev={() => controller.step(-1)}
      onNext={() => controller.step(1)}
      onFollow={controller.follow}
      variant={variant}
      onClose={variant === "aside" ? controller.close : undefined}
      onCollapse={variant === "aside" ? collapse : undefined}
      onOpenPreview={onOpenPreview}
      titleId={variant === "aside" ? titleId : undefined}
      filesTab={filesTab}
      liveText={variant === "aside" ? liveText : undefined}
      onArrowKey={variant === "aside" ? controller.step : undefined}
      targetKey={targetKey}
    />
  );

  if (isMd) {
    if (collapsed) {
      const KindIcon = kind.icon;
      return (
        <aside
          aria-label={`${S.panelName}（已折叠）`}
          data-agent-panel-collapsed="1"
          className="flex w-12 shrink-0 flex-col border-l border-border bg-surface transition-[width] duration-150 ease-standard motion-reduce:transition-none"
        >
          <button
            type="button"
            aria-expanded={false}
            aria-label={railLabel(kind.label, k, n, status.label)}
            title={railLabel(kind.label, k, n, status.label)}
            onClick={expand}
            className="flex min-h-11 w-full flex-1 flex-col items-center gap-2 py-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <PanelRightOpen size={16} className="text-muted" aria-hidden />
            <span className={cn("flex size-7 items-center justify-center rounded-lg", toneTileClass(kind.tone))}>
              <KindIcon size={14} aria-hidden />
            </span>
            <span className={cn("size-2 rounded-full", STATUS_DOT_CLS[status.kind])} aria-hidden />
            {n > 0 && k > 0 && (
              <span className="text-center text-caption leading-tight tabular-nums text-muted" data-agent-panel-step={`${k}/${n}`}>
                {k}
                <br />/{n}
              </span>
            )}
          </button>
        </aside>
      );
    }
    return (
      <aside
        ref={asideRef}
        aria-labelledby={titleId}
        className="flex min-h-0 w-[clamp(20rem,36vw,34rem)] shrink-0 flex-col border-l border-border transition-[width] duration-150 ease-standard motion-reduce:transition-none"
      >
        {content("aside")}
      </aside>
    );
  }

  // 窄屏：chip（turn 进行中才有）+ 贴底 Sheet
  const chip =
    sending && n > 0 ? (
      <AgentPanelChip kind={kind} k={k} n={n} status={status.kind} onClick={() => setSheetOpen(true)} />
    ) : null;
  return (
    <>
      {chip && (chipSlot ? createPortal(chip, chipSlot) : chip)}
      <Sheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        side="bottom"
        srTitle={S.panelName}
        closeButton
        closeLabel={S.close}
        className="md:hidden"
        overlayClassName="md:hidden"
      >
        {sheetOpen && content("sheet")}
      </Sheet>
    </>
  );
}
