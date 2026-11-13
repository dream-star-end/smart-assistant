/**
 * Gateway extension types (CommercialHook)
 *
 * Moved verbatim out of server.ts (FINDINGS §7.6, OCV5-484); server.ts re-exports
 * these names, so importers are unchanged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { UserMediaLocationLike } from './gatewayFilePolicy.js'

export interface CommercialHook {
  handle: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>
  handleWsUpgrade: (
    req: IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ) => boolean
  shutdown: () => Promise<void>
  internalProxyAddress?: { host: string; port: number }
  /**
   * v5 灰度运行时状态(commercial 自算,gateway 仅在 /healthz 只读透传)。
   * 结构内联(gateway 对 commercial 零编译期依赖),与 commercial 的
   * CommercialRuntimeStatus 保持一致。
   */
  runtimeStatus?: {
    channel: string
    controlPlaneEnabled: boolean
    autoMigrate: boolean
    agentRuntime: string
    containerRuntime: string
    schedulers: string[]
  }
  /**
   * 商业化模块的 JWT HMAC 密钥(HS256)。注入后,gateway 的 personal-version 路由
   * 会同时尝试用这个 secret 验证 access token,使商业化用户也能命中
   * /api/agents、/api/sessions/* 等 personal-version 端点。
   */
  jwtSecret?: Uint8Array
  /**
   * V3 multi-tenant `/api/uploads` 写入 + `/api/media` 读取 +
   * `/api/file`/openFileHardened allowlist 的路径解析器。
   * 把 `c:<uid>` 的 userId 映射到该用户 docker volume 宿主路径下的
   * `_data/uploads/` 和 `_data/generated/` 两个子目录。
   *
   * 注入时表明商用模块在多租户模式 —— gateway 必须按用户路由,不再使用全局
   * `paths.uploadsDir` / `paths.generatedDir`(那两个目录在多租户下不存在
   * 用户文件,会触发 dispatchInbound 端"媒体不存在或不可读" / 图像 404)。
   */
  resolveUserMediaDirs?: (userId: string) => Promise<UserMediaLocationLike>
  /**
   * **V3 remote-host 上传桥**(2026-05-16)。把 master 收到的上传文件推到远端
   * compute host 上的用户 docker volume 宿主路径。
   *
   * 仅当 `resolveUserMediaDirs` 返回 `{kind:'fail', reason:'remote-host', ...}`
   * 时由 `handleUpload` 调用 —— 此时 master 物理上不持有用户的 volume,本机
   * tmp+rename 路径不可用。
   *
   * 实现侧(commercial):查 compute_hosts 表解出 NodeAgentTarget,经 mTLS
   * PUT `/files?path=<remotePath>&mode=0644&owner_uid=1000&owner_gid=1000` 上传。
   * node-agent 端 AllowedDirRegexes 严格匹配 v3 用户卷形态;mode+owner 与 self
   * host 上 chmod/chown 完全等价(让远端容器内 agent uid 1000 可读)。
   *
   * 错误语义:throw 表示推送失败(网络/证书/agent app err);gateway 转 5xx。
   */
  pushRemoteHostUpload?: (args: {
    hostUuid: string
    remotePath: string
    content: Buffer
  }) => Promise<void>
  /**
   * **V3 remote-host 读路径桥**(2026-05-16 Phase 2)。`pushRemoteHostUpload`
   * 的对称端 —— 当 `resolveUserMediaDirs` 返回 `remote-host`,gateway 用本 hook
   * 从远端 user docker volume 拉文件回 master,由 master 服给 HTTP 终端。
   *
   * 仅在 `handleMediaGet` / `handleApiFile` 命中 remote-host 时调用,自 self-host
   * 路径无关。`remotePath` 必须在 node-agent AllowedDirRegexes 之内(uploads/
   * generated 子目录),否则 node-agent 直接 400 BAD_PATH。
   *
   * 返:
   *   - `Buffer` → 拉到字节(可能为空文件)
   *   - `null`   → 远端 404,gateway 可选择尝试另一目录或最终 404 给用户
   *   - throw   → 网络/mTLS/auth/agent app err,gateway 转 502
   */
  pullRemoteHostMedia?: (args: {
    hostUuid: string
    remotePath: string
  }) => Promise<Buffer | null>
  pushRemoteHostUploadFromPath?: (args: {
    hostUuid: string
    remotePath: string
    localPath: string
    length: number
  }) => Promise<void>
  sumRemoteUploadUsage?: (args: {
    hostUuid: string
    remoteDir: string
  }) => Promise<{ usedBytes: number; truncated: boolean; files: { name: string; size: number; mtimeMs: number }[] }>
  assembleRemoteHostUpload?: (args: {
    hostUuid: string
    remoteDir: string
    uploadId: string
    count: number
    ext: string
    expectedSize: number
  }) => Promise<{ sha256: string; size: number }>
  deleteRemoteHostUpload?: (args: { hostUuid: string; remotePath: string }) => Promise<void>
  openRemoteHostMedia?: (args: {
    hostUuid: string
    remotePath: string
    dest: NodeJS.WritableStream
    onReady: (info: { size: number }) => boolean
  }) => Promise<'ok' | 'missing' | 'rejected'>
  /**
   * **textual** 谓词:判定 `resolvedPath` 是否长得像
   * `/var/lib/docker/volumes/oc-v3-data-u<digits>/_data/(uploads|generated)[/<file>]`。
   *
   * **不是 user-scoped** —— gateway HTTP allowlist 不能用它(cross-tenant
   * IDOR)。allowlist 应该用 `resolveUserMediaDirs(userId)` 解析出当前用户的
   * `{uploads, generated}` 后自己 closure 限制到该 uid 的两 dir。
   *
   * 唯一合法用途:启动时 `.tmp-*` orphan sweep(无 userId 上下文,只想匹配
   * docker volumes 根下的 user volume 目录壳子)。
   */
  isUserVolumeMediaPath?: (resolvedPath: string) => boolean
  /**
   * **P1.7 slice 7c — WeChat broker 入口**。
   *
   * 当 commercial 模块启用 wechat broker (WECHAT_BROKER_ENABLED=1) 时注入。
   * gateway 把它**通过 wechatChannelFactory 的 `onInboundOverride`** 透传给
   * `routeWechatInbound`,broker 由此接管 inbound 事件(替代 ctx.dispatch),
   * 并把目标用户的 outbound 容器 endpoint 暂存,供其 v3WechatOutbound 适配器
   * 按 wsess-* session → bindingUserId → senderId 反查回传。
   *
   * **结构类型 (structural)**:gateway 不 import commercial 的具体类——保持
   * gateway → commercial 单向依赖。
   */
  wechatBroker?: {
    onInbound(evt: {
      bindingUserId: string
      accountId?: string
      senderId: string
      text: string
      messageId?: string
      itemTypes?: string
      rawPayload?: unknown
      imageAttachments?: unknown[]
      mediaAttachments?: unknown[]
      idempotencyKey: string
      receivedAt: number
      channel?: 'wechat'
      agentId?: string
    }): Promise<unknown>
    cleanupBinding?(bindingUserId: string): Promise<unknown>
  }
  /**
   * **v1.0.192 — cold-start guard for `/api/uploads`**(以及 commercial 内部
   * `/api/file`、`/api/media/:file` 由 commercial router 自己直接调底层 wrapper)。
   *
   * `handleUpload` 在确认请求是 commercial user(userId 形如 `c:<digits>`)后,
   * 在 `_resolveMediaDirs` 之前 await 本 hook —— 确保用户容器已 provision +
   * volume 已挂载 + container running,再去解析 host path 并写入。否则会出现
   * "容器尚未启动,写到 volume host path 上,容器内 agent 看不到文件" 的脏写。
   *
   * 与 commercial router 内部使用的 `(uid: bigint) => Promise<void>`(throw 风格)
   * 不同,**这里返回结构化 result**:gateway 不 import commercial 的
   * `ContainerUnreadyError`,保持 structural-only 依赖。`{ok:false}` 由 gateway
   * 翻译成 503 + `Retry-After`,`{ok:true}` 即放行。
   *
   * 底层都是同一个 `sharedEnsureRunning`(per-uid singleflight),所以 WS bridge /
   * HTTP `/api/media-signed` / commercial router file proxy / gateway upload 同
   * uid 的 in-flight 调用会合并成一次 provision。
   *
   * 非 commercial 形态(`c:<digits>` 不匹配,如 personal-version userId)时 gateway
   * 不调用本 hook —— 让 `_resolveMediaDirs` 原有 `invalid-uid` 路径继续判定。
   */
  ensureContainerReady?: (
    uid: bigint,
  ) => Promise<{ ok: true } | { ok: false; retryAfterSec: number; reason: string }>
  /**
   * master GET /api/sessions/:id 时 fire-and-forget POST 到用户容器
   * `/internal/v3/engine-preheat`。仅 master 注入;失败必须 swallow。
   */
  preheatUserContainer?: (args: {
    userId: string
    sessionId: string
    agentId: string
    modelId?: string
  }) => Promise<void>
  /**
   * **P0 监控盲区收口 — 深度依赖探活**(2026-07-07)。
   *
   * gateway 对 PG/Redis 零编译期依赖(client 全在 commercial 侧),故由 commercial
   * 注入本 hook:master 形态 `/healthz` 会在探完 sessions.db 后并发调用它,拿到
   * 各强依赖(约定键:`pg` = `SELECT 1`、`redis` = `PING`,短超时如 2s 由**实现侧
   * (commercial)**保证)的探活结果。任一 fail → healthz 顶层 `ok:false`(**HTTP 仍
   * 200** —— 深度不健康 ≠ 完全不可服务,不给上游 LB 摘流信号,只翻 ok 供监控/deploy
   * smoke 消费 ok 字段告警)。2026-07-06 sessions.db 事故(进程活着但全站 500 无告警)
   * 的同构盲区,本波扩到 PG/Redis 维度。
   *
   * 返回 map:依赖名 → `{ok:true}` | `{ok:false, error}`。gateway 侧 generic 合并
   * 不硬编码依赖清单(commercial 拥有"哪些依赖"的权威)。**未注入**(个人版/dev 无
   * PG/Redis,或 commercial 尚未接线)= 该维度不探,healthz 行为退回仅 sessions.db。
   */
  probeDeps?: () => Promise<Record<string, { ok: true } | { ok: false; error: string }>>
}
