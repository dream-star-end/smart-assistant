import type { ChatMessage } from "../../lib/chat/model";
import type { ToolLike } from "../tool/format";

export type PaneTab = "outputs" | "steps" | "plan" | "browser";

/**
 * 从面板外打开 / 定位面板的请求(工具卡入口、过程摘要上的「改动 N 个文件」、顶栏开关)。
 * nonce 每次请求都换:同一条消息连点两次也会重新定位并把焦点移进面板。
 * tab 缺省 = 只开面板(停在上次的分区)。
 */
export type PaneRequest = {
  /** "changes" 是 r1 的改动页:改动并进了产出页,旧入口 / 旧记忆按产出处理。 */
  tab?: PaneTab | "changes";
  /** steps / browser:要打开的那一步;outputs:这一轮里的任意一行(定位到它所在的那一轮)。 */
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

