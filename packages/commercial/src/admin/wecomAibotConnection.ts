/**
 * 企业微信「智能机器人(aibot)」长连接管理器(v5-owned)。
 *
 * 每个 channel_type='wecom_aibot' 通道维护一条 wss 长连接:
 *   connect → aibot_subscribe(BotID + 长连接专用 Secret 鉴权)→ 心跳 30s →
 *   断线指数退避重连(上限 5min)。收到 aibot_msg_callback 时学习 chatid 为推送目标。
 *
 * 出口红线(照 wecomAlertSender 头注 + 归档企微调研):
 *   openws.work.weixin.qq.com 是**国内域名**,必须直连。gateway 启动时
 *   setGlobalDispatcher(EnvHttpProxyAgent) 只作用于 **undici**(fetch);'ws' 客户端走
 *   Node 原生 net/tls,**不读全局 undici dispatcher**,且**不设 `agent` 选项即不消费
 *   HTTP(S)_PROXY env** → 天然直连。故 new WebSocket(url) 不传 agent = 直连(见 openSocket)。
 *
 * 单连接约束(官方):每个机器人同一时间仅一条有效连接,新连接踢旧连接。因此:
 *   - 数据层:0110 全局唯一索引 idx_aac_wecom_aibot_identity 保证一 BotID 一通道行。
 *   - 进程层:本管理器每 channelId 只持一条 ws;重连/reconcile 前先 teardown 旧 socket。
 *   - 部署层:v5-only(controlPlane 关 + v5 单实例)保证全网只有一个管理器实例,绝不双跑。
 *
 * 生命周期:随 wecomAlert dispatcher 的 v5-only gate 启停(index.ts),不注册为 scheduler
 * (命名以 *Manager 结尾,避开 check-schedulers 的 Scheduler|Poller|Worker|... 后缀规则 →
 * 不进 schedulerRegistry,smoke 白名单不动)。通道 CRUD 时经 onChannelChanged/onChannelRemoved
 * 热启停对应连接。
 *
 * 分层:纯函数(帧构造 / 退避 / ack 分类 / 入站解析 / 绑定学习 / 可发送断言)全部 export
 * 供单测,不碰 ws/DB;有副作用的连接编排收在 WecomAibotConnectionManager 里(由纯函数组合)。
 */

import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  listAlertChannels as realListAlertChannels,
  loadChannelSecrets as realLoadChannelSecrets,
  updateAibotBinding as realUpdateAibotBinding,
  markChannelError as realMarkChannelError,
  type AlertChannelRow,
  type ChannelSecrets,
} from './alertChannels.js'

// ─── 常量 ─────────────────────────────────────────────────────────────

/** aibot 长连接 endpoint(国内域名,直连)。 */
export const AIBOT_WS_URL = 'wss://openws.work.weixin.qq.com'
/** 心跳间隔(ping/pong)。官方建议 30s。 */
export const HEARTBEAT_INTERVAL_MS = 30_000
/** 重连退避基数 / 上限。 */
export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 300_000 // 5min
/** aibot_send_msg / aibot_subscribe 等待 ack 的超时(超时判 transient)。 */
export const SEND_ACK_TIMEOUT_MS = 10_000

/** 绑定 / 欢迎 / 礼貌回复文案。 */
export const BINDING_CONFIRM_TEXT = '✅ 已绑定 OpenClaude 告警会话,后续告警将推送到这里。'
export const WELCOME_TEXT =
  '👋 我是 OpenClaude 告警机器人。发送任意消息完成告警绑定,之后系统告警会推送到这里。'
export const POLITE_REPLY_TEXT = '我是 OpenClaude 告警机器人,收到系统告警会在此推送(不接受聊天)。'

/**
 * 发送 ack errcode 分类(参数错永久 / 频控 transient)。0=ok。
 * ⚠️ aibot 官方 errcode 表未在调研中逐条核实;下列取企微通用错误段的保守映射,
 * 真机验证后按 aibot 文档校正。**默认 transient**(未知码宁可退避重试也不静默丢告警)。
 */
export const AIBOT_RATELIMIT_ERRCODES: ReadonlySet<number> = new Set<number>([
  45009, // api freq out of limit
  45047, // 并发/接口调用超限
])
export const AIBOT_PERMANENT_ERRCODES: ReadonlySet<number> = new Set<number>([
  40003, // invalid userid/参数非法
  40058, // invalid request param
  41010, // missing / malformed 参数
])

export type AckClass = 'ok' | 'transient' | 'permanent'

export function classifyAibotAck(errcode: number): AckClass {
  if (errcode === 0) return 'ok'
  if (AIBOT_RATELIMIT_ERRCODES.has(errcode)) return 'transient'
  if (AIBOT_PERMANENT_ERRCODES.has(errcode)) return 'permanent'
  // 未知非零码:保守 transient(退避重试,避免误判永久静默丢告警)。
  return 'transient'
}

// ─── 退避 ─────────────────────────────────────────────────────────────

/**
 * 指数退避(带上限)。attempt 从 1 起:1s,2s,4s,…,封顶 5min。
 * jitter=true 时乘 [0.8,1.2) 随机因子打散重连风暴(用注入的 rng 保证测试确定)。
 */
export function reconnectBackoffMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; jitter?: boolean; rng?: () => number } = {},
): number {
  const baseMs = opts.baseMs ?? RECONNECT_BASE_MS
  const maxMs = opts.maxMs ?? RECONNECT_MAX_MS
  const n = Math.max(1, Math.floor(attempt))
  const raw = baseMs * 2 ** (n - 1)
  const capped = Math.min(raw, maxMs)
  if (!opts.jitter) return capped
  const rng = opts.rng ?? Math.random
  return Math.round(capped * (0.8 + rng() * 0.4))
}

// ─── 帧构造 ───────────────────────────────────────────────────────────

export function newReqId(): string {
  return randomUUID()
}

export interface AibotFrame {
  cmd: string
  headers: { req_id: string }
  body: Record<string, unknown>
}

/** 订阅帧:BotID + 长连接专用 Secret 鉴权。 */
export function buildSubscribeFrame(botId: string, secret: string, reqId: string): AibotFrame {
  return {
    cmd: 'aibot_subscribe',
    headers: { req_id: reqId },
    body: { botid: botId, secret },
  }
}

/** 主动推送 markdown(proactive)。前提:目标会话此前给机器人发过消息。 */
export function buildSendMsgFrame(
  chatId: string,
  chatType: 'single' | 'group',
  markdown: string,
  reqId: string,
): AibotFrame {
  return {
    cmd: 'aibot_send_msg',
    headers: { req_id: reqId },
    body: {
      chatid: chatId,
      chat_type: chatType,
      msgtype: 'markdown',
      markdown: { content: markdown },
    },
  }
}

/** 进入会话事件的欢迎语回复(按事件回调的 req_id 关联)。 */
export function buildWelcomeResponseFrame(reqId: string, content: string): AibotFrame {
  return {
    cmd: 'aibot_respond_welcome_msg',
    headers: { req_id: reqId },
    body: { msgtype: 'markdown', markdown: { content } },
  }
}

// ─── 入站解析 ─────────────────────────────────────────────────────────

export type InboundFrame =
  | { kind: 'ack'; reqId: string | null; errcode: number; errmsg: string }
  | {
      kind: 'msg_callback'
      reqId: string | null
      chatId: string | null
      chatType: 'single' | 'group' | null
      fromUserId: string | null
      msgType: string | null
      text: string | null
    }
  | {
      kind: 'event_callback'
      reqId: string | null
      chatId: string | null
      chatType: 'single' | 'group' | null
      eventType: string | null
    }
  | { kind: 'unknown'; reqId: string | null; cmd: string | null }

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
function normChatType(v: unknown): 'single' | 'group' | null {
  return v === 'single' || v === 'group' ? v : null
}

/**
 * 解析一帧入站 JSON。分四类:
 *   - aibot_msg_callback → msg_callback(含 chatid/chattype/from.userid/text.content)
 *   - aibot_event_callback → event_callback(进入会话等事件)
 *   - 其余带 errcode 的 → ack(我们发出的 subscribe/send_msg 的响应,按 req_id 关联)
 *   - 无法识别 → unknown
 * 解析失败(非 JSON / 结构异常)返回 unknown。
 */
export function parseInboundFrame(raw: string | Buffer): InboundFrame {
  let obj: Record<string, unknown>
  try {
    const s = typeof raw === 'string' ? raw : raw.toString('utf8')
    const parsed = JSON.parse(s)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'unknown', reqId: null, cmd: null }
    }
    obj = parsed as Record<string, unknown>
  } catch {
    return { kind: 'unknown', reqId: null, cmd: null }
  }
  const cmd = asStr(obj.cmd)
  const headers = (obj.headers ?? {}) as Record<string, unknown>
  const reqId = asStr(headers.req_id)
  const body = (obj.body ?? {}) as Record<string, unknown>

  if (cmd === 'aibot_msg_callback') {
    const from = (body.from ?? {}) as Record<string, unknown>
    const textObj = (body.text ?? {}) as Record<string, unknown>
    return {
      kind: 'msg_callback',
      reqId,
      chatId: asStr(body.chatid),
      chatType: normChatType(body.chattype),
      fromUserId: asStr(from.userid),
      msgType: asStr(body.msgtype),
      text: asStr(textObj.content),
    }
  }
  if (cmd === 'aibot_event_callback') {
    return {
      kind: 'event_callback',
      reqId,
      chatId: asStr(body.chatid),
      chatType: normChatType(body.chattype),
      eventType: asStr(body.eventtype) ?? asStr(body.event_type),
    }
  }
  // 带 errcode 的响应帧 → ack(我们发出的 subscribe/send_msg 的回执)。
  if (body.errcode !== undefined || obj.errcode !== undefined) {
    const errcode = Number((body.errcode ?? obj.errcode) as number)
    const errmsg = asStr(body.errmsg) ?? asStr(obj.errmsg) ?? 'unknown'
    return { kind: 'ack', reqId, errcode: Number.isFinite(errcode) ? errcode : -1, errmsg }
  }
  return { kind: 'unknown', reqId, cmd }
}

// ─── 绑定学习 ─────────────────────────────────────────────────────────

/**
 * 从 msg_callback 学习推送目标绑定。single 私聊 / group @机器人 逻辑同:
 * WeCom 群聊只会把 @机器人 的消息投递过来,故凡收到 msg_callback 且带 chatid 即视为
 * 有效绑定触发。返回 null 表示该回调不含可用 chatid(忽略)。
 */
export function learnBindingFromCallback(
  cb: Extract<InboundFrame, { kind: 'msg_callback' }>,
): { chatId: string; chatType: 'single' | 'group' } | null {
  if (!cb.chatId) return null
  // chattype 缺省按 single(私聊)兜底 —— 私聊回调有时不带 chattype。
  return { chatId: cb.chatId, chatType: cb.chatType ?? 'single' }
}

/** 是否需要回「首绑确认」:新绑定(prev 为空)或换了会话。同一会话再发消息不重复确认。 */
export function shouldConfirmBinding(prevChatId: string | null, newChatId: string): boolean {
  return prevChatId !== newChatId
}

// ─── 可发送断言(未绑定 / 未连接文案单一权威源)─────────────────────────

/** 长连接 transient 错误(等待连接 / 等待绑定 / ack 超时 / 频控)→ dispatcher markFailed 退避。 */
export class AibotSendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AibotSendError'
  }
}
/** 长连接 permanent 错误(参数错 ack)→ dispatcher markFailed + markChannelError('permanent')。 */
export class AibotPermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AibotPermanentError'
  }
}

export type AibotConnState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'auth_failed'

/**
 * 发送前置断言:连接未就绪 / 未绑定 chatid 抛 AibotSendError(transient,退避重试)。
 * 这是「等待连接 / 等待绑定」文案的**单一权威源**(dispatcher 与测试都依赖它)。
 */
export function assertAibotSendable(state: {
  connState: AibotConnState
  boundChatId: string | null
}): void {
  if (state.connState !== 'connected') {
    throw new AibotSendError(
      '等待连接:企业微信智能机器人长连接未就绪(重连中),稍后自动重试',
    )
  }
  if (!state.boundChatId) {
    throw new AibotSendError(
      '等待绑定:请在企业微信里给该机器人发一条消息完成告警会话绑定',
    )
  }
}

// ─── 连接管理器 ───────────────────────────────────────────────────────

/** 单条通道连接的运行时视图(供 admin 列表状态展示)。 */
export interface AibotConnStatus {
  state: AibotConnState
  bound: boolean
}

/** ws 工厂:测试可注入假 socket;默认直连(不传 agent)。 */
export type SocketFactory = (url: string) => WebSocket

export interface WecomAibotManagerDeps {
  listAlertChannels: typeof realListAlertChannels
  loadChannelSecrets: (id: string) => Promise<ChannelSecrets | null>
  updateAibotBinding: typeof realUpdateAibotBinding
  markChannelError: typeof realMarkChannelError
  createSocket: SocketFactory
  now: () => number
  onError: (scope: string, err: unknown) => void
}

interface Pending {
  resolve: (ack: { errcode: number; errmsg: string }) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface Conn {
  channelId: string
  botId: string
  state: AibotConnState
  ws: WebSocket | null
  boundChatId: string | null
  boundChatType: 'single' | 'group' | null
  reconnectAttempt: number
  reconnectTimer: NodeJS.Timeout | null
  heartbeatTimer: NodeJS.Timeout | null
  lastPongAt: number
  subscribeReqId: string | null
  pending: Map<string, Pending>
  desired: boolean // 期望在线(通道 enabled)
  closedByUs: boolean
}

function defaultCreateSocket(url: string): WebSocket {
  // 不传 agent → 直连(见文件头出口红线)。
  return new WebSocket(url)
}

export class WecomAibotConnectionManager {
  private started = false
  private readonly conns = new Map<string, Conn>()
  private readonly deps: WecomAibotManagerDeps

  constructor(deps?: Partial<WecomAibotManagerDeps>) {
    this.deps = {
      listAlertChannels: deps?.listAlertChannels ?? realListAlertChannels,
      loadChannelSecrets:
        deps?.loadChannelSecrets ?? ((id: string) => realLoadChannelSecrets(id)),
      updateAibotBinding: deps?.updateAibotBinding ?? realUpdateAibotBinding,
      markChannelError: deps?.markChannelError ?? realMarkChannelError,
      createSocket: deps?.createSocket ?? defaultCreateSocket,
      now: deps?.now ?? (() => Date.now()),
      onError:
        deps?.onError ??
        ((scope, err) => {
          // eslint-disable-next-line no-console
          console.warn(`[admin/wecomAibot] ${scope}:`, err)
        }),
    }
  }

  isStarted(): boolean {
    return this.started
  }

  /** 加载所有 enabled 的 wecom_aibot 通道并各起一条连接。幂等:重复 start 不重复连。 */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    let rows: AlertChannelRow[]
    try {
      rows = await this.deps.listAlertChannels()
    } catch (err) {
      this.deps.onError('start.list', err)
      return
    }
    for (const r of rows) {
      if (r.channel_type === 'wecom_aibot' && r.enabled) {
        void this.connectChannel(r.id)
      }
    }
  }

  /** 停机:关所有连接 + 清所有 timer。 */
  async stop(): Promise<void> {
    this.started = false
    for (const conn of this.conns.values()) {
      this.teardown(conn)
    }
    this.conns.clear()
  }

  /** 通道 create/patch:enabled 的 wecom_aibot → 确保在线;否则收敛该连接。 */
  async onChannelChanged(id: string | number | bigint): Promise<void> {
    if (!this.started) return
    const key = String(id)
    let row: AlertChannelRow | undefined
    try {
      const rows = await this.deps.listAlertChannels()
      row = rows.find((r) => r.id === key)
    } catch (err) {
      this.deps.onError('onChannelChanged.list', err)
      return
    }
    if (!row || row.channel_type !== 'wecom_aibot' || !row.enabled) {
      this.onChannelRemoved(key)
      return
    }
    const existing = this.conns.get(key)
    // 无连接 / 已关闭 / 鉴权失败(admin 停用再启用意图重试)→ 重新连。
    if (!existing || existing.state === 'closed' || existing.state === 'auth_failed') {
      void this.connectChannel(key)
    }
  }

  /** 通道 delete / disable:关连接 + 忘记。 */
  onChannelRemoved(id: string | number | bigint): void {
    const key = String(id)
    const conn = this.conns.get(key)
    if (conn) {
      this.teardown(conn)
      this.conns.delete(key)
    }
  }

  /** dispatcher 调用:经活跃连接发一条 markdown 告警。抛 AibotSendError/AibotPermanentError。 */
  async send(id: string | number | bigint, markdown: string): Promise<void> {
    const key = String(id)
    const conn = this.conns.get(key)
    assertAibotSendable({
      connState: conn?.state ?? 'closed',
      boundChatId: conn?.boundChatId ?? null,
    })
    // assert 通过 → conn 一定 connected 且已绑定。
    const c = conn as Conn
    const reqId = newReqId()
    const frame = buildSendMsgFrame(
      c.boundChatId as string,
      c.boundChatType ?? 'single',
      markdown,
      reqId,
    )
    const ack = await this.sendAndAwaitAck(c, frame, reqId)
    const cls = classifyAibotAck(ack.errcode)
    if (cls === 'ok') return
    const msg = `aibot send errcode=${ack.errcode}: ${ack.errmsg}`
    if (cls === 'permanent') throw new AibotPermanentError(msg)
    throw new AibotSendError(msg)
  }

  /** admin 列表状态:channelId → {state, bound}。 */
  statusAll(): Map<string, AibotConnStatus> {
    const out = new Map<string, AibotConnStatus>()
    for (const [id, conn] of this.conns) {
      out.set(id, { state: conn.state, bound: Boolean(conn.boundChatId) })
    }
    return out
  }

  // ── 内部:连接编排 ──────────────────────────────────────────────────

  private async connectChannel(id: string): Promise<void> {
    if (!this.started) return
    // 先收敛旧连接(单连接约束:绝不同 channelId 并存两条 socket)。
    const prev = this.conns.get(id)
    if (prev) this.teardown(prev)

    let secrets: ChannelSecrets | null
    try {
      secrets = await this.deps.loadChannelSecrets(id)
    } catch (err) {
      this.deps.onError(`connect.secrets ch=${id}`, err)
      secrets = null
    }
    if (!secrets || !secrets.botToken || !secrets.aibotBotId) {
      this.deps.onError(`connect.secrets ch=${id}`, new Error('secret/botid unavailable'))
      // 无凭据:登记一个 closed 占位,等下次 onChannelChanged 或重启。
      this.conns.set(id, this.blankConn(id, ''))
      return
    }
    const conn: Conn = this.blankConn(id, secrets.aibotBotId)
    conn.boundChatId = secrets.aibotChatId
    conn.boundChatType =
      secrets.aibotChatType === 'single' || secrets.aibotChatType === 'group'
        ? secrets.aibotChatType
        : null
    conn.desired = true
    this.conns.set(id, conn)
    this.openSocket(conn, secrets.botToken)
  }

  private blankConn(channelId: string, botId: string): Conn {
    return {
      channelId,
      botId,
      state: 'connecting',
      ws: null,
      boundChatId: null,
      boundChatType: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      heartbeatTimer: null,
      lastPongAt: 0,
      subscribeReqId: null,
      pending: new Map(),
      desired: false,
      closedByUs: false,
    }
  }

  private openSocket(conn: Conn, secret: string): void {
    conn.closedByUs = false
    conn.state = conn.reconnectAttempt > 0 ? 'reconnecting' : 'connecting'
    let ws: WebSocket
    try {
      ws = this.deps.createSocket(AIBOT_WS_URL)
    } catch (err) {
      this.deps.onError(`openSocket ch=${conn.channelId}`, err)
      this.scheduleReconnect(conn, secret)
      return
    }
    conn.ws = ws

    ws.on('open', () => {
      conn.state = 'connected'
      conn.reconnectAttempt = 0
      conn.lastPongAt = this.deps.now()
      const reqId = newReqId()
      conn.subscribeReqId = reqId
      try {
        ws.send(JSON.stringify(buildSubscribeFrame(conn.botId, secret, reqId)))
      } catch (err) {
        this.deps.onError(`subscribe.send ch=${conn.channelId}`, err)
      }
      this.startHeartbeat(conn)
    })

    ws.on('message', (data: unknown) => {
      this.handleMessage(conn, data as Buffer | string)
    })

    ws.on('pong', () => {
      conn.lastPongAt = this.deps.now()
    })

    ws.on('error', (err: unknown) => {
      this.deps.onError(`ws.error ch=${conn.channelId}`, err)
      // 'error' 后 ws 必随 'close';重连逻辑统一在 close 处理。
    })

    ws.on('close', () => {
      this.clearTimers(conn)
      this.rejectAllPending(conn, new AibotSendError('connection closed'))
      conn.ws = null
      if (conn.closedByUs || !conn.desired || conn.state === 'auth_failed') {
        if (conn.state !== 'auth_failed') conn.state = 'closed'
        return
      }
      this.scheduleReconnect(conn, secret)
    })
  }

  private handleMessage(conn: Conn, data: Buffer | string): void {
    const frame = parseInboundFrame(data)
    // 先看是否是我们发出请求的 ack(按 req_id 关联)。
    if (frame.kind === 'ack' && frame.reqId) {
      // 订阅鉴权失败 → permanent,停重连 + 降级通道 error。
      if (frame.reqId === conn.subscribeReqId && frame.errcode !== 0) {
        this.authFailed(conn, `aibot_subscribe errcode=${frame.errcode}: ${frame.errmsg}`)
        return
      }
      const p = conn.pending.get(frame.reqId)
      if (p) {
        clearTimeout(p.timer)
        conn.pending.delete(frame.reqId)
        p.resolve({ errcode: frame.errcode, errmsg: frame.errmsg })
      }
      return
    }
    if (frame.kind === 'msg_callback') {
      void this.handleInboundMessage(conn, frame)
      return
    }
    if (frame.kind === 'event_callback') {
      // 进入会话事件 → 回欢迎语(按事件 req_id 关联)。
      if (frame.reqId) {
        this.rawSend(conn, buildWelcomeResponseFrame(frame.reqId, WELCOME_TEXT))
      }
      return
    }
    // unknown:忽略(含服务端 ping 等)。
  }

  private async handleInboundMessage(
    conn: Conn,
    cb: Extract<InboundFrame, { kind: 'msg_callback' }>,
  ): Promise<void> {
    const learned = learnBindingFromCallback(cb)
    if (!learned) return
    const isNewBinding = shouldConfirmBinding(conn.boundChatId, learned.chatId)
    if (isNewBinding) {
      conn.boundChatId = learned.chatId
      conn.boundChatType = learned.chatType
      try {
        const affected = await this.deps.updateAibotBinding(conn.channelId, {
          chatId: learned.chatId,
          chatType: learned.chatType,
        })
        if (affected === 0) {
          // 通道已删 → 收敛连接。
          this.onChannelRemoved(conn.channelId)
          return
        }
      } catch (err) {
        this.deps.onError(`updateBinding ch=${conn.channelId}`, err)
      }
      // 回首绑确认(proactive:用户刚发过消息,前提满足)。
      this.proactiveSend(conn, BINDING_CONFIRM_TEXT)
    } else {
      // 同一会话再发消息 → 礼貌回复,不接聊天。
      this.proactiveSend(conn, POLITE_REPLY_TEXT)
    }
  }

  /** fire-and-forget 主动推送(确认 / 礼貌回复;不等 ack,不影响告警投递路径)。 */
  private proactiveSend(conn: Conn, content: string): void {
    if (!conn.boundChatId) return
    this.rawSend(
      conn,
      buildSendMsgFrame(conn.boundChatId, conn.boundChatType ?? 'single', content, newReqId()),
    )
  }

  private rawSend(conn: Conn, frame: AibotFrame): void {
    const ws = conn.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify(frame))
    } catch (err) {
      this.deps.onError(`rawSend ch=${conn.channelId}`, err)
    }
  }

  /** 发一帧并等 ack(按 req_id 关联);超时抛 AibotSendError(transient)。 */
  private sendAndAwaitAck(
    conn: Conn,
    frame: AibotFrame,
    reqId: string,
  ): Promise<{ errcode: number; errmsg: string }> {
    return new Promise((resolve, reject) => {
      const ws = conn.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new AibotSendError('等待连接:企业微信智能机器人长连接未就绪,稍后自动重试'))
        return
      }
      const timer = setTimeout(() => {
        conn.pending.delete(reqId)
        reject(new AibotSendError('aibot send ack timeout'))
      }, SEND_ACK_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()
      conn.pending.set(reqId, { resolve, reject, timer })
      try {
        ws.send(JSON.stringify(frame))
      } catch (err) {
        clearTimeout(timer)
        conn.pending.delete(reqId)
        reject(new AibotSendError(`aibot send failed: ${(err as Error)?.message ?? String(err)}`))
      }
    })
  }

  private startHeartbeat(conn: Conn): void {
    if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer)
    const timer = setInterval(() => {
      const ws = conn.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      // 连续两个心跳周期没收到 pong → 判死,主动断(触发 close→重连)。
      if (this.deps.now() - conn.lastPongAt > HEARTBEAT_INTERVAL_MS * 2) {
        try {
          ws.terminate()
        } catch {
          /* */
        }
        return
      }
      try {
        ws.ping()
      } catch {
        /* */
      }
    }, HEARTBEAT_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    conn.heartbeatTimer = timer
  }

  private scheduleReconnect(conn: Conn, secret: string): void {
    conn.state = 'reconnecting'
    conn.reconnectAttempt += 1
    const delay = reconnectBackoffMs(conn.reconnectAttempt, { jitter: true })
    const timer = setTimeout(() => {
      if (!this.started || !conn.desired) return
      this.openSocket(conn, secret)
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    conn.reconnectTimer = timer
  }

  private authFailed(conn: Conn, errmsg: string): void {
    conn.state = 'auth_failed'
    conn.desired = false
    this.teardown(conn)
    conn.state = 'auth_failed' // teardown 会置 closed,这里恢复语义标记
    void this.deps
      .markChannelError(conn.channelId, errmsg, 'permanent')
      .catch((err) => this.deps.onError(`authFailed.markError ch=${conn.channelId}`, err))
  }

  private clearTimers(conn: Conn): void {
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer)
      conn.reconnectTimer = null
    }
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer)
      conn.heartbeatTimer = null
    }
  }

  private rejectAllPending(conn: Conn, err: Error): void {
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    conn.pending.clear()
  }

  private teardown(conn: Conn): void {
    conn.closedByUs = true
    conn.desired = false
    this.clearTimers(conn)
    this.rejectAllPending(conn, new AibotSendError('connection torn down'))
    const ws = conn.ws
    conn.ws = null
    if (ws) {
      try {
        ws.removeAllListeners()
      } catch {
        /* */
      }
      try {
        ws.terminate()
      } catch {
        /* */
      }
    }
    if (conn.state !== 'auth_failed') conn.state = 'closed'
  }
}

// ─── 模块级单例(index.ts 启停 + HTTP handler 热启停 + dispatcher 发送 共用同一实例)──

let singleton: WecomAibotConnectionManager | null = null

/**
 * 取(或首次构造)连接管理器单例。与 getImagePromoteScheduler 同构:index.ts 在 v5 gate
 * 里 .start(),shutdown 里 .stop();HTTP CRUD handler 经 onChannelChanged/onChannelRemoved
 * 热启停;dispatcher 经 send 发送。命名以 Manager 结尾 → 不触发 check-schedulers 的 scheduler
 * 后缀规则(不进 schedulerRegistry)。
 */
export function getWecomAibotConnectionManager(
  deps?: Partial<WecomAibotManagerDeps>,
): WecomAibotConnectionManager {
  if (!singleton) singleton = new WecomAibotConnectionManager(deps)
  return singleton
}
