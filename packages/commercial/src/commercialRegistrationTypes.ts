import type { RemoteHostChunkHooks } from "./compute-pool/remoteHostChunkHooks.js";
import type { CommercialHandler } from "./http/router.js";
import type { CommercialRuntimeStatus } from "./runtimeStatus.js";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { UserMediaLocation } from "./agent-sandbox/index.js";

/**
 * v5 灰度运行时状态 — 由 commercial 自身计算(它拥有控制面/运行时的事实),
 * 经 RegisterCommercialResult 暴露给 gateway,gateway 仅在 /healthz 透传序列化。
 * 用作"控制面是否静默 / 容器·agent 运行时是否启用 / 灰度归属(channel)"的只读断言面。
 */

export interface RegisterCommercialResult extends RemoteHostChunkHooks {
  /**
   * HTTP 处理器:gateway 在自身 handleHttp 入口前调用,
   * 返回 true 表示已处理完毕,gateway 不再继续路由。
   */
  handle: CommercialHandler;
  /** v5 灰度运行时状态(见 CommercialRuntimeStatus)。 */
  runtimeStatus?: CommercialRuntimeStatus;
  /**
   * WebSocket upgrade 处理器:gateway 在 HTTP server 的 `upgrade` 事件里调用。
   * 返回 true → commercial 已处理(可能是鉴权失败 + destroy,也可能是成功 upgrade);
   * 返回 false → 非 commercial 路由(如 `/ws`),gateway 自行处理。
   */
  handleWsUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  /** 关闭所有商业化资源(pool / redis / ws)。 */
  shutdown: () => Promise<void>;
  /**
   * V3 2H:内部 anthropic 代理监听地址(`{host, port}`),用于:
   *   - /healthz 反映启用状态
   *   - 测试断言代理已上线
   *   - dev 工具按地址探活
   * 未启用(env 缺失 / skipInternalProxy / 监听失败)时为 undefined。
   */
  internalProxyAddress?: { host: string; port: number };
  /**
   * V3 D.1b:外部 mTLS 监听地址(18443)。remote-host node-agent L7 反代从这里进。
   * 未启用(EXTERNAL_MTLS_ENABLED != 1 / 缺 bind/port / 监听失败)时为 undefined。
   */
  externalMtlsAddress?: { host: string; port: number };
  /**
   * Commercial access JWT 的 HMAC 密钥(已规范化为 ≥32 byte Uint8Array)。
   *
   * 暴露给 gateway,使其在 checkHttpAuth / getUserId 时能识别 commercial
   * 模块签发的 JWT —— 否则商用版用户登录后调 personal-version 沿用的
   * `/api/agents` `/api/sessions/*` 等路由会一律 401(因为 personal 版
   * checkHttpAuth 用 `gateway.accessToken` 当 HMAC,而 commercial JWT
   * 用 JWT_SECRET,两个 secret 完全不同)。
   *
   * gateway 用同步 HS256 验签(node:crypto.createHmac),不引入 jose 依赖,
   * 也不需要把 checkHttpAuth 链路改 async(改动面太大)。
   */
  jwtSecret: Uint8Array;
  /**
   * V3 multi-tenant `/api/uploads` 写入与 `/api/media` 读取的存储路径解析器。
   *
   * 把 `c:<uid>` 形式的 userId 映射到这台 master 上**用户 docker volume 宿主路径**
   * 的 uploads / generated **两个子目录**(同一 docker volume,一次 inspect 同时
   * 确认两 dir 可用)。容器侧 dispatchInbound / codex `image_gen` 通过相同的
   * volume mount 分别看到 `/home/agent/.openclaude/(uploads|generated)/`,从而
   * 消除 "master 写到自己 paths.{uploads,generated}Dir / 容器读自己同名 dir"
   * 的双视图 bug(两次同型回归:2026-05-09 uploads + 2026-05-12 generated)。
   *
   * 装配条件:agentRuntime 起得来(有 docker client)+ pool 已建立。两者任一缺失
   * (e.g. AGENT_IMAGE 没配),resolver 为 undefined,gateway 自动回退到旧的
   * `paths.uploadsDir` / `paths.generatedDir`(personal/单租户兼容)。
   *
   * fail-closed:DB 查无 active container → not-ready;远程 host → remote-host;
   * 多条 active → ambiguous;volume 不存在 → volume-missing。gateway 转译为对应
   * HTTP 4xx/5xx,不做静默回退。
   */
  resolveUserMediaDirs?: (userId: string) => Promise<UserMediaLocation>;
  /**
   * V3 multi-tenant **textual** 谓词:判定一个 resolvedPath 是否长得像
   * `/var/lib/docker/volumes/oc-v3-data-u<digits>/_data/(uploads|generated)[/<file>]`。
   *
   * **不是 user-scoped** —— 只检查路径形态,不验证 uid 等于当前请求 userId。
   * gateway HTTP allowlist **不能**用它(会引入 cross-tenant IDOR:用户 A 拿到
   * 用户 B 的绝对路径就能读)。allowlist 的 user-scoped predicate 应该用
   * `resolveUserMediaDirs(userId)` 解析出当前用户的 `{uploads, generated}` 后
   * 自己 closure。
   *
   * 唯一合法用途:启动时 `.tmp-*` orphan sweep(无 userId 上下文,只想匹配
   * docker volumes 根下的 user volume 目录壳子)。
   */
  isUserVolumeMediaPath?: (resolvedPath: string) => boolean;
  /**
   * v1.0.192 — 给 gateway `handleUpload` 在写 user docker volume 之前用的
   * 冷启动护栏。**结构化返回**(不抛 ContainerUnreadyError),让 gateway 保持
   * 零编译期依赖 commercial 子模块的边界(server.ts 头部明确注释:不 import
   * @openclaude/commercial)。
   *
   * 其他 error(DB 抖 / docker daemon 不可达 / supervisor wired-but-broken)
   * 仍然 throw,gateway 端 catch 后兜底 503。
   *
   * 共享同一 per-uid singleflight(与 commercial 内部 `/api/media-signed` +
   * WS bridge 同闭包),reload 时不会让 upload 路径成为 DB INSERT race 输家。
   *
   * 未注入(agentRuntime 没起 / v3Deps 缺) → gateway 直接跳过冷启动护栏,
   * 走原 `_resolveMediaDirs` 行为(personal/legacy 单租户路径)。
   */
  ensureContainerReady?: (
    uid: bigint,
  ) => Promise<{ ok: true } | { ok: false; retryAfterSec: number; reason: string }>;
  /**
   * GET /api/sessions/:id 时 master 把引擎预热打到用户容器
   * `/internal/v3/engine-preheat`。失败必须 swallow。
   */
  preheatUserContainer?: (args: {
    userId: string;
    sessionId: string;
    agentId: string;
    modelId?: string;
  }) => Promise<void>;
  /**
   * 2026-05-16 hotfix — remote-host upload push hook。
   *
   * 当 `resolveUserMediaDirs(userId)` 返回 `{kind:"fail", reason:"remote-host",
   * hostUuid, uploads, generated}` 时,gateway 把本地暂存好的字节(stream→
   * digest 校验完成)通过这个 hook 推到 host 上的 docker volume:
   *   `${uploads}/${digest}.${ext}` 或 `${generated}/${name}`
   *
   * 实现:getHostById(hostUuid) → hostRowToTarget → nodeAgentPutFile(target,
   * remotePath, content, 0o644, 1000, 1000) → finally psk.fill(0)。
   *
   * 错误语义:任意阶段失败(row 不存在 / agent 不可达 / HTTP >=400)直接抛,
   * gateway 转 502 "remote storage push failed";frontend 重试合理。
   *
   * 装配条件同 `resolveUserMediaDirs`(agentRuntime 在手),为简化保持总是
   * 装配 —— closure 内部自己用 pool,与上面的 resolver 一致。
   */
  pushRemoteHostUpload?: (args: {
    hostUuid: string;
    remotePath: string;
    content: Buffer;
  }) => Promise<void>;
  /**
   * 2026-05-16 hotfix Phase 2 — remote-host **读路径**对称 hook。
   *
   * 当 `resolveUserMediaDirs(userId)` 返回 `remote-host` 失败,gateway 的
   * `handleMediaGet` / `handleApiFile` 通过本 hook 从远端 node-agent /files GET
   * 拉用户卷下的文件回 master,由 master 服给浏览器/API 客户端。
   *
   * 实现:getHostById(hostUuid) → hostRowToTarget → nodeAgentGetFile(target,
   * remotePath) → finally psk.fill(0)。
   *
   * 返回:
   *   - `Buffer` (含空 Buffer = 0 字节文件,合法):远端命中
   *   - `null`:远端 404(node-agent 明确不存在,gateway 可选择 fallback 到另一
   *     目录或最终 404 给用户)
   *
   * 错误:任意阶段失败(row 不存在 / agent 不可达 / mTLS / HTTP >=400 非 404)
   *   直接抛 → gateway 转 502 "remote storage pull failed";frontend 重试合理。
   *
   * 装配条件、psk 清零纪律与 `pushRemoteHostUpload` 完全对称。
   */
  pullRemoteHostMedia?: (args: {
    hostUuid: string;
    remotePath: string;
  }) => Promise<Buffer | null>;
  /**
   * P1.7 slice 7c — WeChat broker 入站入口。
   *
   * 装配条件:
   *   - cfg.WECHAT_BROKER_ENABLED === true (env WECHAT_BROKER_ENABLED=1)
   *   - selfHostUuid / dispatchInternal 等基础设施已就绪
   *
   * gateway 不 import commercial 类型 — 这里只暴露 broker.onInbound 的最小投影
   * (结构对齐 gateway 的 `CommercialHook.wechatBroker.onInbound` 形状)。返回
   * `unknown` 让 caller 不感知 BrokerInboundOutcome 内部 union;broker 自己
   * never-throw,caller 不需要 try/catch。
   */
  /**
   * healthz 深度探活:gateway healthz 经此 seam 探 commercial 强依赖(PG/Redis),
   * 补"依赖宕机但 healthz 仍绿零告警"的盲区。返回 { pg, redis } 各自 ok/err,
   * 内部 2s 超时;gateway 未拿到该函数(旧接线/个人版)时退回仅探 sessions.db。
   */
  probeDeps?: () => Promise<Record<string, { ok: true } | { ok: false; error: string }>>;
  wechatBroker?: {
    onInbound(evt: {
      bindingUserId: string;
      accountId?: string;
      senderId: string;
      text: string;
      messageId?: string;
      itemTypes?: string;
      rawPayload?: unknown;
      mediaAttachments?: import("@openclaude/channel-wechat").WechatMediaAttachment[];
      imageAttachments?: import("@openclaude/channel-wechat").WechatImageAttachment[];
      idempotencyKey: string;
      receivedAt: number;
      channel?: "wechat";
      agentId?: string;
    }): Promise<unknown>;
    cleanupBinding(bindingUserId: string): Promise<unknown>;
  };
}
