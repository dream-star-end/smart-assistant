/**
 * 详情面板(右侧第三栏)的开合、定位请求与「产出 N」计数(UI-2a,从 App.tsx 抽出)。
 *
 * - 默认收起。这一轮有产出时顶栏出「产出 N」(手机进「⋯」),点开才展开;用户手动开 / 关记在本机,
 *   打开过的保持打开(宽屏 ≥1100px 内联第三列)。更窄的视口用贴底 Sheet,不硬挤三列。
 * - 「N」与产出页同源:最新一轮的 collectTurnOutputs → outputCount(文件 + 图片媒体 + 本机预览)。
 * - 面板本体(InspectorPanel)和产出提取(workbench)都懒加载,不进首屏(first-screen-budget);
 *   这里只留开合状态和小常量。
 * 面板里看哪一步是纯 UI 态,不进 ChatSocket。
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeferredPayloadLoader, PaneRequest, PaneTab } from "../components/InspectorPanel";
import type { ToolLike } from "../components/tool/format";
import { Sheet } from "../components/ui";
import type { ChatMessage } from "../lib/chat/model";
import { useWideViewport } from "./useMdViewport";
import { useResizableWidth } from "./useResizableWidth";

const InspectorPanel = lazy(() => import("../components/InspectorPanel").then((m) => ({ default: m.InspectorPanel })));
const InspectorPanelContent = lazy(() =>
  import("../components/InspectorPanel").then((m) => ({ default: m.InspectorPanelContent })),
);

export const PANE_OPEN_STORAGE_KEY = "oc_v5_detail_pane_open";

/** 宽屏内联面板的宽度范围与记忆键(useResizableWidth;把手在面板左缘)。 */
export const DETAIL_PANE_WIDTH = {
  storageKey: "oc_v5_detail_pane_width",
  defaultWidth: 440,
  min: 320,
  max: 720,
  edge: "left",
} as const;

/** 用户是否手动打开过(跨会话、跨刷新)。没记过 / 读不到存储 → 收起。 */
function readOpen(): boolean {
  try {
    return localStorage.getItem(PANE_OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(PANE_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
}

/** 只把属于当前会话的请求交给面板:请求在切会话前发出、面板在切会话后挂载时,旧请求作废。 */
export function paneRequestForSession(request: PaneRequest | null, sessionId: string | null | undefined): PaneRequest | null {
  return request && (request.sessionId ?? null) === (sessionId ?? null) ? request : null;
}

export function useDetailPane({
  activeId,
  inChat,
  demo,
  messages,
  version,
}: {
  activeId: string | null | undefined;
  /** 对话视图(不是任务看板 / 项目主页)。 */
  inChat: boolean;
  demo: boolean;
  messages: readonly ChatMessage[];
  /** 会话消息就地 mutate 的版本号。 */
  version: number;
}) {
  const isWide = useWideViewport();
  const [open, setOpenState] = useState(readOpen);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [request, setRequest] = useState<PaneRequest | null>(null);
  const [active, setActive] = useState<ToolLike | null>(null);
  const width = useResizableWidth(DETAIL_PANE_WIDTH);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    writeOpen(next);
  }, []);
  // 请求记下发起时的会话(openPane 引用稳定,不随会话变):切会话后旧请求不再交给新面板。
  const live = useRef({ activeId, isWide });
  live.current = { activeId, isWide };
  /** 从面板外打开 / 定位面板:宽屏展开内联列,窄屏弹出贴底面板。 */
  const openPane = useCallback(
    (tab?: PaneTab, message?: ToolLike | null) => {
      setRequest({ tab, message, nonce: Date.now(), sessionId: live.current.activeId ?? null });
      if (live.current.isWide) setOpen(true);
      else setSheetOpen(true);
    },
    [setOpen],
  );
  // 切会话 / 进出任务看板、项目主页时清掉面板里的定位:消息对象引用属于旧会话上下文。
  // 宽屏面板的开合是用户偏好,保留;窄屏抽屉收起。
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId / inChat 是「换了上下文」的触发信号
  useEffect(() => {
    setRequest(null);
    setActive(null);
    setSheetOpen(false);
  }, [activeId, inChat]);

  // 可用 = 对话视图里有会话内容;demo 只在点了某张工具卡时出现。
  const available = inChat && (demo ? !!request?.message : !!activeId && messages.length > 0);
  const inline = available && isWide && open;
  const shown = inline || (available && !isWide && sheetOpen);
  const [outputs, setOutputs] = useState(0);
  // 产出提取在 workbench(与产出页共用的懒块)里,按需加载后再数;模块缓存后每次只是一个微任务。
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 是就地 mutate 消息的变更信号
  useEffect(() => {
    if (!available) {
      setOutputs(0);
      return;
    }
    let live = true;
    void import("../components/chat/workbench").then((m) => {
      if (live) setOutputs(m.latestTurnOutputCount(messages));
    });
    return () => {
      live = false;
    };
  }, [available, messages, version]);
  const toggle = (tab?: PaneTab) => {
    if (!shown) return openPane(tab);
    if (isWide) setOpen(false);
    else setSheetOpen(false);
  };
  const toggleRef = useRef<(() => void) | null>(null);
  toggleRef.current = available && !demo ? () => toggle() : null;

  return {
    openPane,
    /** 顶栏开关:收起时点「产出 N」打开产出页,展开时收起。demo / 不可用时 undefined。 */
    toggle: available && !demo ? () => toggle("outputs") : undefined,
    /** 全局快捷键(⌘/Ctrl+\)用:停在上次的分区。 */
    toggleRef,
    shown,
    outputs,
    /** 面板当前查看的那一步(源卡片选中态);面板没展开时为 null。 */
    activeTool: shown ? active : null,
    host: {
      inline,
      sheet: available && sheetOpen && !isWide,
      sheetMounted: sheetOpen,
      request: paneRequestForSession(request, activeId),
      width,
      setActive,
      close: () => setOpen(false),
      closeSheet: () => setSheetOpen(false),
    },
  };
}

/** 详情面板的挂载点:宽屏内联 aside,更窄时贴底 Sheet(共用 InspectorPanelContent)。 */
export function DetailPane({
  pane,
  sessionKey,
  messages,
  version,
  running,
  peek,
  fetch,
}: {
  pane: ReturnType<typeof useDetailPane>;
  sessionKey: string;
  messages: readonly ChatMessage[];
  version: number;
  running: boolean;
  peek?: DeferredPayloadLoader["peek"];
  fetch?: DeferredPayloadLoader["fetch"];
}) {
  const { host } = pane;
  // 详情面板里点开大记录(>1 MiB 定位桩)时,与聊天区共用同一套正文取数与页面缓存。
  const deferredLoader = useMemo<DeferredPayloadLoader>(() => ({ peek, fetch }), [peek, fetch]);
  const content = { messages, version, running, request: host.request, deferredLoader, onActiveChange: host.setActive };
  return (
    <>
      {host.inline && (
        <Suspense fallback={<div style={{ width: host.width.width }} className="max-w-[45vw] shrink-0 border-l border-border" />}>
          <InspectorPanel
            key={sessionKey}
            {...content}
            focusNonce={host.request?.nonce}
            onClose={host.close}
            width={host.width.width}
            resizing={host.width.resizing}
            widthMin={DETAIL_PANE_WIDTH.min}
            widthMax={DETAIL_PANE_WIDTH.max}
            onResizeStart={host.width.onResizeStart}
            onResizeKeyDown={host.width.onResizeKeyDown}
          />
        </Suspense>
      )}
      <Sheet open={host.sheet} onOpenChange={(o) => !o && host.closeSheet()} side="bottom" srTitle="详情面板">
        {host.sheetMounted && (
          <div className="flex h-[80dvh] min-h-0 flex-col">
            <Suspense fallback={null}>
              <InspectorPanelContent key={sessionKey} {...content} onClose={host.closeSheet} />
            </Suspense>
          </div>
        )}
      </Sheet>
    </>
  );
}
