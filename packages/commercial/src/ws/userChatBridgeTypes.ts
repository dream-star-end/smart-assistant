/**
 * Shared public types for userChatBridge (split out for the file-size ratchet;
 * UXE-A1 / PR #1199). Behavior-neutral move.
 */

import type { AuthoritySigner } from "./authoritySigner.js";
import type { AuthorityKeyCensus } from "./authorityKeyCensus.js";
import type { ModelCatalogCache } from "../billing/modelCatalog.js";

export interface BridgeMetricSink {
  /** 一条用户帧已转发到容器(bytes 是 raw 字节数,含 binary)。 */
  onUserFrame?(uid: bigint, bytes: number, isBinary: boolean): void;
  /** 一条容器帧已转发到用户。 */
  onContainerFrame?(uid: bigint, bytes: number, isBinary: boolean): void;
  /**
   * Bridge TTFT:首个 user→container 帧 ↔ 首个 container→user 帧 的间隔。
   * 每个 bridge session 至多触发一次(若用户从未发帧,则不触发)。
   * kind 透 endpoint.coldStart(undefined → "warm",见 ResolveContainerEndpoint 漏标说明)。
   */
  onTtft?(uid: bigint, kind: "cold" | "warm", seconds: number): void;
  /** 当前任意一侧 buffered bytes 取最大值上报(用于 prometheus gauge)。 */
  onBufferedBytes?(uid: bigint, side: "user_to_container" | "container_to_user", bytes: number): void;
  /** 桥关闭时单次,拿到本次会话总字节数 / 时长 / closeCode。 */
  onClose?(stats: {
    uid: bigint;
    connId: string;
    durationMs: number;
    closeCode: number;
    closeReason: string;
    bytesUserToContainer: number;
    bytesContainerToUser: number;
    cause: BridgeCloseCause;
  }): void;
}

/** 桥关闭的根因分类(供 metrics / 日志诊断)。 */
export type BridgeCloseCause =
  | "client_close"           // 用户主动 close
  | "container_close"        // 容器主动 close
  | "container_error"        // 容器 socket 错(ECONNREFUSED 等)
  | "container_unready"      // ensureRunning throw ContainerUnreadyError
  | "auth_failed"            // JWT 验证失败
  | "frame_too_big"          // 单帧超过 maxFrameBytes
  | "binary_unsupported"     // (保留,默认放行 binary)
  | "backpressure"           // buffer 超 maxBufferedBytes
  | "internal_error"         // 兜底
  | "shutdown";              // server.shutdown()

// ---------- 模型执行权威(方案 §2 / §7 步 4)---------------------------------

/**
 * bridge 侧的模型权威签发装配(docs/V5_MODEL_AUTHORITY_PLAN.md)。
 *
 * **注入即开启**(index.ts 只在 flag `OC_MODEL_AUTHORITY=1` 时构造并注入):
 *   - 未注入 → bridge 完全走旧路径(不签发、不注入、不做 attestation 门),零行为变化;
 *   - 注入   → ①每条连接要求容器 attest `model_authority_v1`(未 attest 前缓冲用户帧,
 *              有界 + 超时;超时/不支持 → 拒连接 + 触发 stale recycle);
 *              ②每条 forward 的 inbound.message 先 strip 客户端同名字段,再注入
 *              master 签名的 `__oc_model_authority`;
 *              ③codex 计费链的 isCodex 判定改用 **descriptor.engine**(与签发同源,
 *              不再是 baked 的 gpt-* 前缀集合)。
 *
 * fail-closed 边界:catalog 快照 unknown / epoch fence 失败 / 模型不可路由 → **拒帧**,
 * 绝不「降级为不带 envelope 转发」—— 那会让容器回落 baked 判定,而 master 这边可能已按
 * 另一套语义预扣,正是本批次要消灭的计费/执行分裂。
 */
export interface BridgeModelAuthorityDeps {
  /** master 独占私钥的签发器(公钥 keyring 由 supervisor 注入容器 env)。 */
  signer: AuthoritySigner;
  /** ModelExecutionCatalog 快照缓存(epoch fence 的执行体)。 */
  catalog: ModelCatalogCache;
  /**
   * 容器不支持 attestation(旧 release / 旧 env)→ 触发 stale recycle,让用户下次连接
   * 拿到带 keyring 的新容器。未注入 → 只拒连接不 recycle(测试/降级)。
   */
  recycleContainer?: (containerId: number, reason: string) => void;
  /** 等待容器 attestation 的上限(默认 10s)。 */
  attestTimeoutMs?: number;
  /**
   * **签发边界的 epoch 直读**(代码审 R1 MAJOR-2)。默认 = billing/modelCatalog
   * `readSecurityEpoch()`(单行 SELECT,无时间缓存,与 fence 同一权威源)。
   *
   * 为什么签发边界要**再读一次**:`resolveTurnExecution` 的 fence 发生在 turn 起手,
   * 但从那里走到"签票"之间还隔着 route / acquire / preCheck / journal / 历史消息装配
   * 好几个 await —— 安全写(disable 模型 / 撤销授权 / 改价 / bump epoch)完全可能落在
   * 这中间。只在早期 fence 一次,等于用一个**已经过时的快照**签出一张长命票据
   * (lease TTL = 50min),把"安全变更立刻生效"的承诺打穿。
   *
   * 测试注入用。
   */
  readSecurityEpoch?: () => Promise<bigint>;
  /**
   * keyring 覆盖普查(R3-M7 轮换步骤② 的 gate)。缺省 = 进程级单例
   * `ws/authorityKeyCensus.authorityKeyCensus`。测试注入以隔离。
   */
  census?: AuthorityKeyCensus;
}

/**
 * 0049 grants checker 的连接级 handle(**epoch 联动版**,代码审 R1 BLOCKER-1)。
 *
 * 旧形态的洞:checker 每 GRANTS_REFRESH_INTERVAL_MS(30s)刷一次,**刷新失败永久保留旧
 * checker**。撤销授权后:
 *   - CCB 有 egress 的每请求授权兜底(proxy 里重查 role+grants);
 *   - **codex 根本不经 /v1/messages egress** → 唯一的授权闸就是本 checker。
 * 于是「撤权 → 30s 窗口(或 DB 抖动时的**无限**窗口)内旧连接照签票、照执行」。
 *
 * 修法(与 catalog 同一条 fence 语义):
 *   - grants 快照带 **epoch 戳**(= 读 grants 之前观察到的 DB security epoch 的下界);
 *   - 0144 起任何 grant 写(含 DELETE)都 bump epoch;
 *   - 每个 turn 在 catalog epoch fence **之后**比对:checker.epoch < 权威 epoch → 说明
 *     期间发生过安全写(可能就是撤权)→ `reloadAtLeast(权威 epoch)` 同步重载并**重新判定**;
 *   - 重载失败 / 达不到目标 epoch → **拒帧**(禁止 keep-LKG 放行)。
 *
 * 「放宽」与「收窄」两条路分开:周期 refresh 失败仍 keep-LKG(新授权晚点生效可以忍),
 * 收窄面(reloadAtLeast)一律 fail-closed。
 */
export interface ModelCheckerHandle {
  /** 已绑定本连接 uid+DB role+grants+fenced visibility 的 sync 判定闭包。 */
  isAllowed: (modelId: string) => boolean;
  /** 当前 grants 快照的 epoch 下界(0 = 尚未观察到任何 epoch,视作最陈旧)。 */
  epoch: () => bigint;
  /** 周期刷新(放宽面):失败保留上次成功快照,不抛。 */
  refresh: () => Promise<void>;
  /** 严格重载到 ≥ want(收窄面):失败或达不到 → 抛,调用方**必须拒帧**。 */
  reloadAtLeast: (want: bigint) => Promise<void>;
}

/** 容器 attestation 帧 type —— 与 gateway `modelAuthority.CONTAINER_ATTEST_FRAME_TYPE` 同值
 *  (两包不互相 import,parity 由 modelAuthorityBridge.test.ts 锁定)。 */
export const CONTAINER_ATTEST_FRAME_TYPE = "outbound.control.container_attest";
