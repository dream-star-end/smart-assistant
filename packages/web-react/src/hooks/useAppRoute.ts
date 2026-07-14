import { useEffect, useRef } from "react";
import {
  PRODUCT_CAPABILITIES,
  isProductFeatureId,
  type ProductFeatureId,
} from "../lib/productCapabilities";
import type { Session } from "../lib/types";

/**
 * P7 —— 最小路由（无路由库，自写）：URL 是 App 状态的单向镜像 + popstate 反灌。
 * 历史栈语义（boss 定夺 2026-07-02）：**后退 = 上一个会话**（ChatGPT 式）——
 * 用户主动的会话导航（切会话/新建）pushState 压栈；以下四种情形 replace 不压栈：
 *   1. draft 首发（`/` → `/s/<id>`，同一逻辑位置只是 URL 形态毕业）；
 *   2. 首次选中（boot 自动选中最近会话/深链恢复，启动噪音不进栈）；
 *   3. 删除当前会话回 `/`（死条目不留在栈里）；
 *   4. popstate 反灌（URL 本就是权威，镜像 effect 天然 no-op）。
 *
 * 规则：
 * - 选中会话 → `/s/<id>`；无选中 / 新建的空会话（尚无消息的 draft，链接无分享意义）/
 *   删除当前会话 → `/`。
 * - 启动深链 `/s/<id>`：进工作区后等会话出现在侧栏（IndexedDB 注水或 listSessions 到达）
 *   再 selectSession；listSessions 落定仍不存在 → 放弃并回 `/`（随后"自动选中上次会话"
 *   恢复正常判定）。恢复未决期间 URL 深链优先于最近会话（holdAutoSelect）。
 * - popstate：按 URL 切会话（/s/<id> 且会话存在 → selectSession；已删除的死条目 →
 *   清选中 + replaceState 修正 URL；/ → 清选中回空会话态）。
 * - 面板深链 `?panel=settings|market|manage|org|help`：boot 由 App 在 useState 初始化时读取
 *   （parsePanelParam）；教程另带稳定 `topic`。打开/关闭经本 hook replaceState 同步回 query
 *   （面板不压栈，且保留其他无关 query）。
 * - demo / reset-password 特判不启用（enabled=false，URL 原样保留）。
 */
export type PanelParam = "settings" | "market" | "manage" | "org" | "help";

/** `/s/<id>` → 会话 id（形态对齐后端 peer.id 约束 `[A-Za-z0-9_-]`；不匹配返回 null）。 */
export function parseSessionPath(pathname: string): string | null {
  const m = /^\/s\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
  return m ? m[1] : null;
}

/** `?panel=` → 面板名（未知值一律当没有，防深链打开不存在的面板）。 */
export function parsePanelParam(sp: URLSearchParams): PanelParam | null {
  const v = sp.get("panel");
  return v === "settings" || v === "market" || v === "manage" || v === "org" || v === "help"
    ? v
    : null;
}

/** `?panel=help&topic=` → 稳定教程 id；非 help / 未知 id 返回 null。 */
export function parseTutorialTopic(sp: URLSearchParams): ProductFeatureId | null {
  if (parsePanelParam(sp) !== "help") return null;
  const topic = sp.get("topic");
  return isProductFeatureId(topic) ? topic : null;
}

/** 保留其他 query；非 help 时清 topic，help 的空/未知 topic 规范化为默认教程。 */
export function withPanelParams(
  input: URLSearchParams,
  panel: PanelParam | null,
  topic?: ProductFeatureId | null,
): URLSearchParams {
  const next = new URLSearchParams(input);
  if (panel) next.set("panel", panel);
  else next.delete("panel");
  if (panel === "help") next.set("topic", topic ?? PRODUCT_CAPABILITIES.chatBasics.id);
  else next.delete("topic");
  return next;
}

export type UseAppRouteOptions = {
  /** 非 demo 且非 reset-password 时启用。 */
  enabled: boolean;
  /** 已进入工作区（auth+user 就绪）：深链恢复与 popstate 只在工作区内生效。 */
  inWorkspace: boolean;
  activeId: string | undefined;
  sessions: Session[];
  /** listSessions 已落定（useSessionList）：判定深链会话"确实不存在"的依据。 */
  serverListSettled: boolean;
  /** 启动深链 `/s/<id>` 的未决恢复目标（App 持有该 state 以同步暂停自动选中）。 */
  pendingSessionId: string | null;
  clearPendingSession: () => void;
  selectSession: (id: string) => void;
  /** popstate 回到 `/`：清除选中（回空会话态）。 */
  onPopToRoot: () => void;
  /** 当前打开的面板（App 派生；顶层中心互斥并按单一优先级镜像）。 */
  activePanel: PanelParam | null;
  /** help 打开时的当前教程；其他面板忽略。 */
  activeTopic?: ProductFeatureId | null;
  /** popstate 反灌面板/query（外部 help 深链恢复时使用）。 */
  onPopPanel?: (panel: PanelParam | null, topic: ProductFeatureId | null) => void;
};

export function useAppRoute(opts: UseAppRouteOptions): void {
  const { enabled, inWorkspace, activeId, sessions, serverListSettled, pendingSessionId } = opts;
  const { activePanel, activeTopic } = opts;
  // 回调/最新值经 ref 镜像（App 每渲染传新闭包；popstate 监听只挂一次仍读最新）。
  const cbRef = useRef(opts);
  cbRef.current = opts;

  // popstate：浏览器后退/前进 → URL 为权威反灌状态。仅工作区内响应（登录页/首页的
  // 历史导航不该操作会话态）。
  useEffect(() => {
    if (!enabled) return;
    const onPop = () => {
      if (!cbRef.current.inWorkspace) return;
      const query = new URLSearchParams(location.search);
      cbRef.current.onPopPanel?.(parsePanelParam(query), parseTutorialTopic(query));
      const id = parseSessionPath(location.pathname);
      if (id) {
        if (cbRef.current.sessions.some((s) => s.id === id)) {
          cbRef.current.selectSession(id);
        } else {
          // 历史栈里的已删除会话:回空态并 replace 修正 URL(不再制造新条目)。
          cbRef.current.onPopToRoot();
          history.replaceState({}, "", "/" + location.search + location.hash);
        }
      } else if (location.pathname === "/") {
        cbRef.current.onPopToRoot();
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [enabled]);

  // 启动深链恢复：等目标会话出现（IndexedDB 注水或 listSessions 到达）再选中；
  // listSessions 落定仍不存在 → 放弃（URL 由下方镜像 effect 回写 `/`，自动选中随之解锁）。
  useEffect(() => {
    if (!enabled || !inWorkspace || !pendingSessionId) return;
    if (sessions.some((s) => s.id === pendingSessionId)) {
      cbRef.current.clearPendingSession();
      cbRef.current.selectSession(pendingSessionId);
    } else if (serverListSettled) {
      cbRef.current.clearPendingSession();
    }
  }, [enabled, inWorkspace, pendingSessionId, sessions, serverListSettled]);

  // activeId → URL 路径镜像。空会话 draft（列表里 messageCount=0，典型为「新建会话」
  // 尚未首发）不占 URL —— 首次发送后计数>0 自然落 /s/<id>；popstate 到侧栏没有的 id 时
  // 列表查不到 → 不视作 draft，URL 保持用户所到之处。
  // push/replace 取舍见文件头「历史栈语义」:会话间导航 push,其余 replace。
  const activeEntry = activeId ? sessions.find((s) => s.id === activeId) : undefined;
  const isEmptyDraft = activeEntry !== undefined && activeEntry.messageCount === 0;
  const wantPath = activeId && !isEmptyDraft ? `/s/${activeId}` : "/";
  const prevIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    // 深链恢复未决：不回写（否则把 URL 里的 /s/<id> 冲成当前空态的 /）。
    if (pendingSessionId) return;
    const prevId = prevIdRef.current;
    prevIdRef.current = activeId;
    if (location.pathname === wantPath) return; // popstate 反灌/深链恢复:URL 已是权威
    const suffix = location.search + location.hash;
    // 同一会话的 URL 形态毕业(draft 首发 / → /s/<id>):同一逻辑位置,replace;
    // 首次选中(prevId 空:boot 自动选中最近会话,或落地后的第一次点击):启动噪音不压栈。
    if ((activeId !== undefined && activeId === prevId) || prevId === undefined) {
      history.replaceState({}, "", wantPath + suffix);
      return;
    }
    // 回 / 且来源会话已不在列表(删除当前会话):死条目不进历史栈,replace。
    if (
      wantPath === "/" &&
      activeId === undefined &&
      !cbRef.current.sessions.some((s) => s.id === prevId)
    ) {
      history.replaceState({}, "", wantPath + suffix);
      return;
    }
    // 用户会话导航(切会话/新建):pushState —— 后退=上一个会话。
    history.pushState({}, "", wantPath + suffix);
  }, [enabled, pendingSessionId, wantPath, activeId]);

  // 面板 → ?panel= query（replaceState；关闭时清参数）。不限工作区：未登录携带
  // ?panel= 深链时面板 state 已在 App 初始化为打开（进工作区即呈现），此 effect 恰好
  // no-op 保参；登出后面板关闭 → 参数即时清理。
  useEffect(() => {
    if (!enabled) return;
    const current = new URLSearchParams(location.search);
    const next = withPanelParams(current, activePanel, activeTopic);
    const q = next.toString();
    if (q === current.toString()) return;
    history.replaceState({}, "", location.pathname + (q ? `?${q}` : "") + location.hash);
  }, [enabled, activePanel, activeTopic]);
}
