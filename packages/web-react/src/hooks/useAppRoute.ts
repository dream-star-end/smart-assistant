import { useEffect, useRef } from 'react'
import { type ProductFeatureId, isProductFeatureId } from '../lib/productCapabilities'
import { TICKET_TYPES, type TicketType } from '../lib/taskboard'
import { type TutorialCaseId, parseTutorialCaseId } from '../lib/tutorialCaseCatalog'
import type { Session } from '../lib/types'

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
 *   （parsePanelParam）；教程另带稳定 `case` 或兼容旧版的 `topic`。打开/关闭经本 hook replaceState 同步回 query
 *   （面板不压栈，且保留其他无关 query）。
 * - 工作区视图 `chat | board`：board 时路径为 `/board`（与会话路径并列，不是 ?panel=）。
 *   对话 ↔ 任务面板用 pushState（后退回到上一位置）。`?view=board|list|inbox|cost|weekly|backlog`、
 *   `?ticket=<identifier>` 与 `?ticketType=bug|feature|spike|chore` 走 replaceState，复用「保留无关 query」语义；离开 /board 时清掉。
 * - demo / reset-password 特判不启用（enabled=false，URL 原样保留）。
 */
export type PanelParam = 'settings' | 'market' | 'manage' | 'org' | 'help'

/** `/s/<id>` → 会话 id（形态对齐后端 peer.id 约束 `[A-Za-z0-9_-]`；不匹配返回 null）。 */
export function parseSessionPath(pathname: string): string | null {
  const m = /^\/s\/([A-Za-z0-9_-]{1,64})$/.exec(pathname)
  return m ? m[1] : null
}

/** 工作区视图：对话主区 vs 任务面板全屏主区。 */
export type WorkspaceView = 'chat' | 'board'

/** `/board` 视图。`inbox/backlog` 仅保留旧调用兼容，URL 读取会归一到任务列表。 */
export type BoardViewParam = 'board' | 'list' | 'inbox' | 'backlog' | 'cost' | 'weekly'

/** `/board` → true。只认精确路径，不吃 `/board/` 或子路径。 */
export function parseBoardPath(pathname: string): boolean {
  return pathname === '/board'
}

/**
 * 会话路径镜像的 wantPath。board 工作区必须产出 `/board`，否则会话镜像会把
 * 顶级路径冲回 `/` 或 `/s/<id>`。
 */
export function workspaceWantPath(
  workspace: WorkspaceView,
  activeId: string | undefined,
  isEmptyDraft: boolean,
): string {
  if (workspace === 'board') return '/board'
  return activeId && !isEmptyDraft ? `/s/${activeId}` : '/'
}

const BOARD_VIEWS: ReadonlySet<string> = new Set([
  'board',
  'list',
  'inbox',
  'backlog',
  'cost',
  'weekly',
])
const BOARD_TICKET_TYPES: ReadonlySet<string> = new Set(TICKET_TYPES)

/**
 * 任务默认展示：窄屏优先列表，`md` 及以上优先看板。
 * 传参形式供单测与非浏览器调用；不传时读取与 `useMdViewport` 相同的媒体查询。
 */
export function preferredBoardView(isDesktop?: boolean): 'board' | 'list' {
  const desktop =
    isDesktop ??
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(min-width: 768px)').matches)
  return desktop ? 'board' : 'list'
}

/**
 * `?view=` → 任务面板视图。旧的 inbox/backlog 深链归一到任务列表；
 * 缺省 / 未知值由调用方传入设备偏好，纯函数默认仍回落看板。
 */
export function parseBoardView(
  sp: URLSearchParams,
  fallback: 'board' | 'list' = 'board',
): BoardViewParam {
  const v = sp.get('view')
  if (v === 'inbox' || v === 'backlog') return 'list'
  return v && BOARD_VIEWS.has(v) ? (v as BoardViewParam) : fallback
}

/** `?ticket=` → identifier（空/空白当没有）。 */
export function parseBoardTicket(sp: URLSearchParams): string | null {
  const t = sp.get('ticket')?.trim()
  return t ? t : null
}

/** `?ticketType=` → 看板流水线类型（未知值当没有，让后端挑默认）。 */
export function parseBoardTicketType(sp: URLSearchParams): TicketType | null {
  const v = sp.get('ticketType')
  return v && BOARD_TICKET_TYPES.has(v) ? (v as TicketType) : null
}

/**
 * 保留其他 query（含 `?panel=`）；`view`/`ticket`/`ticketType` 只在 board 工作区出现。
 * 默认看板省略 `view=board`，未选类型省略 `ticketType`（由后端挑非终态最多的 type）。
 * 离开 board 时三者都清理。
 */
export function withBoardParams(
  input: URLSearchParams,
  view: BoardViewParam | null,
  ticket?: string | null,
  ticketType?: TicketType | null,
): URLSearchParams {
  const next = new URLSearchParams(input)
  const normalizedView = view === 'inbox' || view === 'backlog' ? 'list' : view
  if (normalizedView && normalizedView !== 'board') next.set('view', normalizedView)
  else next.delete('view')
  if (view && ticket) next.set('ticket', ticket)
  else next.delete('ticket')
  if (view && ticketType) next.set('ticketType', ticketType)
  else next.delete('ticketType')
  return next
}

/** `?panel=` → 面板名（未知值一律当没有，防深链打开不存在的面板）。 */
export function parsePanelParam(sp: URLSearchParams): PanelParam | null {
  const v = sp.get('panel')
  return v === 'settings' || v === 'market' || v === 'manage' || v === 'org' || v === 'help'
    ? v
    : null
}

const COMMUNITY_TUTORIAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** `?panel=help&community=` → 公开教程 id；非 help / 非法 id 返回 null。 */
export function parseTutorialCommunity(sp: URLSearchParams): string | null {
  if (parsePanelParam(sp) !== 'help') return null
  const id = sp.get('community')?.trim() ?? ''
  return COMMUNITY_TUTORIAL_ID_RE.test(id) ? id : null
}

/** `?panel=help&topic=` → 稳定教程 id；非 help / 未知 id 返回 null。 */
export function parseTutorialTopic(sp: URLSearchParams): ProductFeatureId | null {
  if (parsePanelParam(sp) !== 'help') return null
  // community / case / topic 互斥；community 与 case 都优先于旧 topic。
  if (parseTutorialCommunity(sp) || parseTutorialCase(sp)) return null
  const topic = sp.get('topic')
  return isProductFeatureId(topic) ? topic : null
}

/** `?panel=help&case=` → 稳定案例 id；非 help / 未知 id 返回 null。 */
export function parseTutorialCase(sp: URLSearchParams): TutorialCaseId | null {
  if (parsePanelParam(sp) !== 'help') return null
  if (parseTutorialCommunity(sp)) return null
  return parseTutorialCaseId(sp.get('case'))
}

/** 保留其他 query；community/case/topic 互斥；无选择即案例总览；离开 help 时三者都清理。 */
export function withPanelParams(
  input: URLSearchParams,
  panel: PanelParam | null,
  topic?: ProductFeatureId | null,
  caseId?: TutorialCaseId | null,
  communityId?: string | null,
): URLSearchParams {
  const next = new URLSearchParams(input)
  if (panel) next.set('panel', panel)
  else next.delete('panel')
  if (panel === 'help' && communityId) {
    next.set('community', communityId)
    next.delete('case')
    next.delete('topic')
  } else if (panel === 'help' && caseId) {
    next.set('case', caseId)
    next.delete('topic')
    next.delete('community')
  } else if (panel === 'help' && topic) {
    next.set('topic', topic)
    next.delete('case')
    next.delete('community')
  } else {
    next.delete('case')
    next.delete('topic')
    next.delete('community')
  }
  return next
}

/**
 * 生成可复制/新标签打开的教程深链。与状态镜像共用 withPanelParams，确保 campaign、
 * 邀请码等无关 query 以及当前 pathname/hash 都不会被卡片链接静默丢掉。
 */
export function tutorialHref(
  locationLike: { pathname: string; search: string; hash: string },
  topic?: ProductFeatureId | null,
  caseId?: TutorialCaseId | null,
  communityId?: string | null,
): string {
  const query = withPanelParams(
    new URLSearchParams(locationLike.search),
    'help',
    topic,
    caseId,
    communityId,
  ).toString()
  return `${locationLike.pathname}${query ? `?${query}` : ''}${locationLike.hash}`
}

export type UseAppRouteOptions = {
  /** 非 demo 且非 reset-password 时启用。 */
  enabled: boolean
  /** 已进入工作区（auth+user 就绪）：深链恢复与 popstate 只在工作区内生效。 */
  inWorkspace: boolean
  activeId: string | undefined
  sessions: Session[]
  /** listSessions 已落定（useSessionList）：判定深链会话"确实不存在"的依据。 */
  serverListSettled: boolean
  /** 启动深链 `/s/<id>` 的未决恢复目标（App 持有该 state 以同步暂停自动选中）。 */
  pendingSessionId: string | null
  clearPendingSession: () => void
  selectSession: (id: string) => void
  /** popstate 回到 `/`：清除选中（回空会话态）。 */
  onPopToRoot: () => void
  /** 当前打开的面板（App 派生；顶层中心互斥并按单一优先级镜像）。 */
  activePanel: PanelParam | null
  /** help 打开时的旧版功能教程；案例总览/案例详情为 null。 */
  activeTopic?: ProductFeatureId | null
  /** help 打开时的案例；功能教程/案例总览为 null。 */
  activeCase?: TutorialCaseId | null
  /** help 打开时的社区教程公开 id；与 case/topic 互斥。 */
  activeCommunity?: string | null
  /** popstate 反灌面板/query（外部 help 深链恢复时使用）。 */
  onPopPanel?: (
    panel: PanelParam | null,
    topic: ProductFeatureId | null,
    caseId: TutorialCaseId | null,
    communityId: string | null,
  ) => void
  /** 当前工作区。缺省 chat，保持旧调用方零改动。 */
  workspace?: WorkspaceView
  /** board 工作区的三视图（镜像到 `?view=`）。 */
  boardView?: BoardViewParam
  /** board 工作区打开的单据 identifier（镜像到 `?ticket=`）。 */
  boardTicket?: string | null
  /** board 工作区的单据类型（镜像到 `?ticketType=`；null = 让后端挑默认）。 */
  boardTicketType?: TicketType | null
  /** popstate 反灌工作区（`/board` ↔ `/` `/s/<id>`）。 */
  onPopWorkspace?: (workspace: WorkspaceView) => void
  /** popstate 反灌 board 的 view/ticket/ticketType。 */
  onPopBoardParams?: (
    view: BoardViewParam,
    ticket: string | null,
    ticketType: TicketType | null,
  ) => void
}

export function useAppRoute(opts: UseAppRouteOptions): void {
  const { enabled, inWorkspace, activeId, sessions, serverListSettled, pendingSessionId } = opts
  const { activePanel, activeTopic, activeCase, activeCommunity } = opts
  // 回调/最新值经 ref 镜像（App 每渲染传新闭包；popstate 监听只挂一次仍读最新）。
  const cbRef = useRef(opts)
  cbRef.current = opts

  // popstate：浏览器后退/前进 → URL 为权威反灌状态。仅工作区内响应（登录页/首页的
  // 历史导航不该操作会话态）。
  useEffect(() => {
    if (!enabled) return
    const onPop = () => {
      if (!cbRef.current.inWorkspace) return
      const query = new URLSearchParams(location.search)
      cbRef.current.onPopPanel?.(
        parsePanelParam(query),
        parseTutorialTopic(query),
        parseTutorialCase(query),
        parseTutorialCommunity(query),
      )
      const id = parseSessionPath(location.pathname)
      if (id) {
        cbRef.current.onPopWorkspace?.('chat')
        if (cbRef.current.sessions.some((s) => s.id === id)) {
          cbRef.current.selectSession(id)
        } else {
          // 历史栈里的已删除会话:回空态并 replace 修正 URL(不再制造新条目)。
          cbRef.current.onPopToRoot()
          history.replaceState({}, '', `/${location.search}${location.hash}`)
        }
      } else if (parseBoardPath(location.pathname)) {
        // /board 是并列工作区，不能当未知路径掉进空分支（主区会仍停在对话）。
        cbRef.current.onPopWorkspace?.('board')
        cbRef.current.onPopBoardParams?.(
          parseBoardView(query, preferredBoardView()),
          parseBoardTicket(query),
          parseBoardTicketType(query),
        )
      } else if (location.pathname === '/') {
        cbRef.current.onPopWorkspace?.('chat')
        cbRef.current.onPopToRoot()
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [enabled])

  // 启动深链恢复：等目标会话出现（IndexedDB 注水或 listSessions 到达）再选中；
  // listSessions 落定仍不存在 → 放弃（URL 由下方镜像 effect 回写 `/`，自动选中随之解锁）。
  useEffect(() => {
    if (!enabled || !inWorkspace || !pendingSessionId) return
    if (sessions.some((s) => s.id === pendingSessionId)) {
      cbRef.current.clearPendingSession()
      cbRef.current.selectSession(pendingSessionId)
    } else if (serverListSettled) {
      cbRef.current.clearPendingSession()
    }
  }, [enabled, inWorkspace, pendingSessionId, sessions, serverListSettled])

  // activeId → URL 路径镜像。空会话 draft（列表里 messageCount=0，典型为「新建会话」
  // 尚未首发）不占 URL —— 首次发送后计数>0 自然落 /s/<id>；popstate 到侧栏没有的 id 时
  // 列表查不到 → 不视作 draft，URL 保持用户所到之处。
  // push/replace 取舍见文件头「历史栈语义」:会话间导航 push,其余 replace。
  const activeEntry = activeId ? sessions.find((s) => s.id === activeId) : undefined
  const isEmptyDraft = activeEntry !== undefined && activeEntry.messageCount === 0
  const workspace: WorkspaceView = opts.workspace ?? 'chat'
  const wantPath = workspaceWantPath(workspace, activeId, isEmptyDraft)
  const prevIdRef = useRef<string | undefined>(undefined)
  const prevWorkspaceRef = useRef<WorkspaceView | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    // 深链恢复未决：不回写（否则把 URL 里的 /s/<id> 冲成当前空态的 /）。
    if (pendingSessionId) return
    const prevId = prevIdRef.current
    const prevWorkspace = prevWorkspaceRef.current
    prevIdRef.current = activeId
    prevWorkspaceRef.current = workspace
    if (location.pathname === wantPath) return // popstate 反灌/深链恢复:URL 已是权威
    const suffix = location.search + location.hash
    // 对话 ↔ 任务面板：用户换工作区，push（后退=上一个位置）。首次 boot 的
    // prevWorkspace 为空走下面的 replace 分支（启动噪音不压栈）。
    if (prevWorkspace !== undefined && prevWorkspace !== workspace) {
      history.pushState({}, '', wantPath + suffix)
      return
    }
    // 同一会话的 URL 形态毕业(draft 首发 / → /s/<id>):同一逻辑位置,replace;
    // 首次选中(prevId 空:boot 自动选中最近会话,或落地后的第一次点击):启动噪音不压栈。
    if ((activeId !== undefined && activeId === prevId) || prevId === undefined) {
      history.replaceState({}, '', wantPath + suffix)
      return
    }
    // 回 / 且来源会话已不在列表(删除当前会话):死条目不进历史栈,replace。
    if (
      wantPath === '/' &&
      activeId === undefined &&
      !cbRef.current.sessions.some((s) => s.id === prevId)
    ) {
      history.replaceState({}, '', wantPath + suffix)
      return
    }
    // 用户会话导航(切会话/新建):pushState —— 后退=上一个会话。
    history.pushState({}, '', wantPath + suffix)
  }, [enabled, pendingSessionId, wantPath, activeId, workspace])

  // 面板 → ?panel= query（replaceState；关闭时清参数）。不限工作区：未登录携带
  // ?panel= 深链时面板 state 已在 App 初始化为打开（进工作区即呈现），此 effect 恰好
  // no-op 保参；登出后面板关闭 → 参数即时清理。
  useEffect(() => {
    if (!enabled) return
    const current = new URLSearchParams(location.search)
    const next = withPanelParams(current, activePanel, activeTopic, activeCase, activeCommunity)
    const q = next.toString()
    if (q === current.toString()) return
    history.replaceState({}, '', location.pathname + (q ? `?${q}` : '') + location.hash)
  }, [enabled, activePanel, activeTopic, activeCase, activeCommunity])

  // board → ?view= / ?ticket= / ?ticketType=（replaceState；离开 /board 时清参数）。
  // 与 withPanelParams 一样只改自己的键，campaign / panel 等无关 query 原样保留。
  const { boardView, boardTicket, boardTicketType } = opts
  useEffect(() => {
    if (!enabled) return
    const current = new URLSearchParams(location.search)
    const next = withBoardParams(
      current,
      workspace === 'board' ? (boardView ?? 'board') : null,
      workspace === 'board' ? boardTicket : null,
      workspace === 'board' ? boardTicketType : null,
    )
    const q = next.toString()
    if (q === current.toString()) return
    history.replaceState({}, '', location.pathname + (q ? `?${q}` : '') + location.hash)
  }, [enabled, workspace, boardView, boardTicket, boardTicketType])
}
