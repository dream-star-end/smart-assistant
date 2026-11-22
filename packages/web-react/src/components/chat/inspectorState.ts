import { createContext, useContext } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import type { ToolLike } from "../tool/format";

/** 右栏顶栏主分区（OCV5-844:「过程」降级为按需下钻的单步全文视图，不再作为顶栏常驻 Tab）。 */
export type PrimaryPaneTab = "outputs" | "plan" | "browser";

export type PaneTab = PrimaryPaneTab | "steps";

export type TargetOutputRequest = {
  path?: string;
  title?: string;
  manifestSrc?: string;
  previewUrl?: string;
  nonce: number;
};

/**
 * 从聊天流里的 `browser_handoff` 卡片一键打开实时云端浏览器并接管的意图参数。
 */
export type LiveBrowserHandoffRequest = {
  takeover?: boolean;
  expand?: boolean;
  url?: string;
  continuePrompt?: string;
  handoffId?: string;
};

/**
 * 从面板外打开 / 定位面板的请求(工具卡入口、过程摘要上的「改动 N 个文件」、顶栏开关、
 * 对话文件卡/科研报告「工作台预览」)。
 * nonce 每次请求都换:同一条消息连点两次也会重新定位并把焦点移进面板。
 * tab 缺省 = 只开面板(停在上次的分区)。
 */
export type PaneRequest = {
  /**
   * "changes" 是 r1 的改动页:改动并进了产出页,旧入口 / 旧记忆按产出处理。
   * "steps" 仅配合具体 message 触发按需单步全文下钻；无 message 时回落到产出页。
   */
  tab?: PaneTab | "changes";
  /** steps / browser:要打开的那一步;outputs:这一轮里的任意一行(定位到它所在的那一轮)。 */
  message?: ToolLike | null;
  /** browser_handoff 卡片发起的实时接管/放大意图。 */
  liveBrowser?: LiveBrowserHandoffRequest;
  nonce: number;
  /** 发起请求时的会话;App 只把属于当前会话的请求交给面板(切会话后旧请求作废)。 */
  sessionId?: string | null;
  /** 定位打开的具体交付物路径(与 src/lib/workbenchOpen.ts 对齐)。 */
  targetPath?: string;
  /** 目标交付物的展示标题兜底。 */
  targetTitle?: string;
  /** 科研报告的引用接地 EvidenceManifest sidecar 路径/URL。 */
  manifestSrc?: string;
  /** 兜底预览 URL（如签名预览链接）。 */
  previewUrl?: string;
};

/** 供 LiveBrowserStage 在不修改 BrowserView 签名的情况下读取 InspectorPanel 透传的停回合回调。 */
export const InspectorStopTurnContext = createContext<(() => void) | undefined>(undefined);

export function useInspectorStopTurn(): (() => void) | undefined {
  return useContext(InspectorStopTurnContext);
}

/** 会话级云端浏览器人工接管完成事件（严格按 sessionId + handoffId 精准同步对话内 BrowserHandoffBlock 卡片）。 */
export interface LiveBrowserHandbackEvent {
  sessionId: string | null;
  handoffId: string;
  agentId?: string;
  autoSent?: boolean;
  ts: number;
}

const liveBrowserHandbacks = new Map<string, LiveBrowserHandbackEvent>();
let liveBrowserHandbackVersion = 0;
const liveBrowserHandbackListeners = new Set<() => void>();

function handbackScopeKey(sessionId: string | null | undefined, handoffId: string): string {
  return `${sessionId ?? ""}::${handoffId}`;
}

export function notifyLiveBrowserHandback(
  evt: Omit<LiveBrowserHandbackEvent, "ts" | "sessionId" | "handoffId"> & {
    sessionId?: string | null;
    handoffId?: string | null;
  },
): void {
  if (!evt.handoffId) return;
  const sessionId = evt.sessionId ?? null;
  liveBrowserHandbacks.set(handbackScopeKey(sessionId, evt.handoffId), {
    sessionId,
    handoffId: evt.handoffId,
    agentId: evt.agentId,
    autoSent: evt.autoSent,
    ts: Date.now(),
  });
  liveBrowserHandbackVersion += 1;
  for (const listener of liveBrowserHandbackListeners) {
    listener();
  }
}

export function subscribeLiveBrowserHandback(listener: () => void): () => void {
  liveBrowserHandbackListeners.add(listener);
  return () => {
    liveBrowserHandbackListeners.delete(listener);
  };
}

export function getLiveBrowserHandbackVersion(): number {
  return liveBrowserHandbackVersion;
}

export function getLiveBrowserHandbackFor(
  sessionId: string | null | undefined,
  handoffId: string | null | undefined,
): LiveBrowserHandbackEvent | null {
  if (!handoffId) return null;
  return liveBrowserHandbacks.get(handbackScopeKey(sessionId, handoffId)) ?? null;
}

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

export const PANE_TAB_STORAGE_KEY = "oc_v5_detail_pane_tab";
export const PANE_OPEN_STORAGE_KEY = "oc_v5_detail_pane_open";

/** 宽屏内联面板的宽度范围与记忆键(useResizableWidth;把手在面板左缘)。 */
export const DETAIL_PANE_WIDTH = {
  storageKey: "oc_v5_detail_pane_width",
  defaultWidth: 440,
  min: 320,
  max: 1120,
  edge: "left",
} as const;

const MIN_MAIN_CHAT_WIDTH = 420;
const DEFAULT_SIDEBAR_WIDTH = 268;
const MAX_VIEWPORT_RATIO = 0.62;

/**
 * 按当前视口与侧栏宽度动态计算右侧 Workbench 最大允许宽度：
 *  - 大屏（1920px+）可放宽至 62vw（最高 DETAIL_PANE_WIDTH.max = 1120px），方便看宽表 / PDF / Diff；
 *  - 1100–1280px 窄宽屏严格为中间主对话保底 420px，防止三栏互相挤压。
 */
export function computeDynamicPaneMaxWidth(
  viewportWidth: number,
  sidebarWidth = DEFAULT_SIDEBAR_WIDTH,
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 720;
  const ratioCap = Math.floor(viewportWidth * MAX_VIEWPORT_RATIO);
  const remainCap = Math.floor(viewportWidth - Math.max(0, sidebarWidth) - MIN_MAIN_CHAT_WIDTH);
  return Math.max(DETAIL_PANE_WIDTH.min, Math.min(DETAIL_PANE_WIDTH.max, ratioCap, remainCap));
}

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
