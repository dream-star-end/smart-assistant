/**
 * V3 Phase 2 Task 2E — 用户 WS ↔ 容器 WS 桥接。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §4 / 03-MVP-CHECKLIST.md Task 2E。
 *
 * 拓扑(MVP 单 host monolith):
 *   浏览器 ──TLS WS──▶ Gateway `/ws/user-chat-bridge?token=<jwt>`
 *                       │
 *                       ├─ verifyAccess(jwt) → uid
 *                       ├─ ConnectionRegistry.register({uid})  // 默认每人 3 条
 *                       ├─ const {host, port, bundleRev} = await resolveContainerEndpoint(uid)
 *                       │     ↑ 唯一入口(R6.11 reader 硬约束)。Phase 3 接入
 *                       │       supervisor.ensureRunning(uid);Phase 2 由调用方注入。
 *                       │       throw 503 → 关 ws + close code 4503 + retryAfter 给前端
 *                       ├─ await loadAgentModelResolver(uid, { bundleRev })   // 必须在 ↑ 之后!
 *                       │     ↑ seed agent 的计费模型 = **该容器实际跑的 bundle rev** 的 seed 声明
 *                       │       (模型权威批次 §5 阶段 B)。提前到 ensureRunning 之前 = master 用
 *                       │       current 声明给跑旧 seed 的容器计费 = 滚动窗口计费分叉。
 *                       └─ 内部 fetch ws://<host>:<port>/ws → 双向 pipe(text + binary)
 *
 * 协议透明为默认路径:非业务控制帧保持 byte-exact 透传；`inbound.message`
 * 会由 master 注入 trace / 授权 / 历史 / 平台能力提示等私有上下文,再转发给容器。
 * 个人版 `/ws` 协议可演进而无需 commercial 配合。
 *
 * 失败语义:
 *   - JWT 失败  → ws 立刻 send {type:'error',code:'UNAUTHORIZED'} + close(1008)
 *   - 503 容器未就绪 → close(4503, 'migration_in_progress'),前端按 retryAfter 重连
 *   - 容器 WS 拒连(ECONNREFUSED / 4xx)→ close(1011, 'agent unavailable')
 *   - 任一侧 close → 另一侧立刻 close(对端 close code 透传到下游 best-effort)
 *   - buffer 超 maxBufferedBytes → close(1009, 'backpressure')— 防内存爆
 *
 * 不做的(P1+ / 别的 task):
 *   - 不做 ack 屏障 / migrate-aware 重连(R6.11):2E 只做"调一次 ensureRunning,
 *     成功就开桥;失败就 4503"。任何 redirect / 中途切 host 都不在 MVP 范畴
 *   - 不做 metrics 输出:`bufferedBytes` 通过 deps.onMetric 回调暴露,2I-2 接 prom-client
 *   - 不做 audit:个人版 chat 已经在容器内自审,gateway 侧不再额外抓 message body
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID, randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Pool } from "pg";
import { isCursorCredentialMember } from "../cursor/access.js";

import { verifyAccess, JwtError, type AccessClaims } from "../auth/jwt.js";
import { ConnectionRegistry, type Conn } from "./connections.js";
import type { Logger } from "../logging/logger.js";
import { recordTurnTrace, updateTurnTraceDispatch } from "./turnTraces.js";
import {
  extractFirstVisibleAttribution,
  recordTurnFirstVisible,
} from "./turnPerformance.js";
import { GoalStateError } from "../goal/goalStateService.js";
import { isInMaintenance } from "../middleware/maintenanceMode.js";
import type { NodeAgentTarget } from "../compute-pool/nodeAgentClient.js";
import {
  type PreCheckRedis,
  type ReservationHandle,
  preCheckWithCost,
  releasePreCheck,
  estimateMaxCost,
  InsufficientCreditsError,
} from "../billing/preCheck.js";
import type { PricingCache, ModelPricing } from "../billing/pricing.js";
import { projectContextWindowForRole } from "../billing/modelRolePolicy.js";
import {
  parseBillingPricing,
  serializeBillingPricing,
} from "../billing/persistedBillingPricing.js";
import {
  getAgentCostMultiplier,
  composeMultiplier,
} from "../billing/agentMultiplier.js";
import {
  startInflightJournal,
  abortInflightJournal,
  loadUsageAttributionCredits,
  readJournalForTakeover,
  type JournalFailureCode,
} from "../billing/proxyBilling.js";
import {
  DURABLE_CODEX_RECOVERY_VERSION,
  ENGINE_SESSION_ID_RE,
  isPermanentCodexWaiver,
  makeCodexFinalizer,
  permanentCodexWaiverReason,
  type CodexFinalizeHandle,
} from "../billing/codexFinalizer.js";
import {
  bindAuthorityTurnDispatch,
  admitVerificationSponsorship,
  parseVerificationSponsorshipSnapshot,
  serializeVerificationSponsorshipSnapshot,
} from "../billing/verificationSponsorship.js";
import type { TokenUsage } from "../billing/calculator.js";
import { settleCursorExternalUsage } from "../billing/cursorExternalSettle.js";
import {
  publishZcodeCatalogSettle,
  settleZcodeCatalogUsage,
} from "../billing/zcodeCatalogSettle.js";
import {
  abortInsertedZcodeAudit,
  applyZcodeFinalizeOutcome,
  closePendingZcodeAudits,
  closeZcodeAuditWithRetry,
  insertPendingZcodeAudit,
  reconcileStaleZcodeAudits,
  rememberZcodePending,
  zcodeAdmissionAbortTerminal,
  zcodeCleanupTerminal,
} from "../billing/zcodeExternalAudit.js";
import { recordProductFrictionEvent } from "../productFriction/events.js";
import { maybeUpdateAccountQuotaCodex } from "../account-pool/quota.js";
import { applyLearnedCursorQuota, resolveUsedCursorAccountId } from "../account-pool/cursorMaterializer.js";
import { OutboundRingBuffer, DEFAULT_RING_CONFIG } from "@openclaude/gateway";
import {
  AUTOMATIC_TURN_RETRY_MAX,
  DEFAULT_CODEX_ENGINE_MODEL,
  MODEL_AUTHORITY_CAPABILITY,
  MODEL_AUTHORITY_FIELD,
  DURABLE_TURN_DISPATCH_CAPABILITY,
  DISPATCH_AUTHORITY_FIELD,
  stripDispatchAuthorityField,
  computeDispatchRequestHash,
  isCodexEngineModel,
  isGrokEngineModel,
  isCursorEngineModel,
  isZcodeEngineModel,
  isClientMessageId,
  formatMessageReplyPrompt,
  modelHistorySemanticRole,
  modelHistorySemanticText,
  newTraceId,
  normalizeMessageReplyQuote,
  parseSessionWorkspaceMode,
  parseTraceIdCandidate,
  stripModelAuthorityField,
  turnRecoveryAttemptIdentity,
  turnRecoveryIdentity,
  type ModelAuthorityBundle,
  type ModelAuthorityEngine,
  type ModelExecutionDescriptor,
  type TraceIdIssue,
  type GoalStateSnapshot,
  type MessageReplyQuote,
  type DispatchRequestContent,
  type SessionWorkspaceMode,
} from "@openclaude/protocol";
import { mintDispatchEnvelope } from "../dispatch/dispatchSigner.js";
import {
  casAdmittedToAccepted,
  casToManualReconcile,
  casToTerminal,
  getDispatchByLogicalKey,
  heartbeatLease,
  DISPATCH_LEASE_TTL_MS,
  DISPATCH_LEASE_HEARTBEAT_MS,
} from "../dispatch/turnDispatchStore.js";
import {
  HELLO_LIVE_CATCHUP_MAX_BYTES,
  liveCatchupSendDecision,
  readOpenDispatchLiveFramePayloadsAfterSeq,
} from "../db/liveTurnFrames.js";
import {
  admitDurableControl,
  claimDueTurnControls,
  markTurnControlReceipt,
  persistPermissionAuthority,
  releaseTurnControlForRetry,
  resolvePermissionExpiresAt,
  TurnControlConflictError,
} from "../dispatch/turnControlStore.js";
import {
  claimDueRecoveryJobs,
  forwardRecoveryUnderRootFence,
  markRecoveryContainerReceipt,
  releaseRecoveryPreReceipt,
  releaseRecoveryForTransportWait,
  type ClaimedRecoveryJob,
} from "../dispatch/turnRecoveryStore.js";
import type {
  AdmitUserTurnInput,
  AdmitUserTurnResult,
} from "../db/pgSessionsBackend.js";
import type { AuthoritySigner } from "./authoritySigner.js";
import { type AuthorityKeyCensus, authorityKeyCensus } from "./authorityKeyCensus.js";
import { platformAuxModels, readSecurityEpoch } from "../billing/modelCatalog.js";
import type { ModelCatalogCache, ModelCatalogSnapshot } from "../billing/modelCatalog.js";
import type { GithubSelectionRow } from "../github/sessionWorkspaces.js";
import type { AgentModelResolver } from "./agentModelAuthority.js";
import {
  applyStatusFrame,
  buildAutoRebindFrames,
  enrichBindRequest,
  fetchActiveSelectionsForRebind,
  parseBindRequest,
  parseStatusFrame,
  parseUnbindRequest,
} from "./sessionRepoBindBridge.js";
import { appendScanSciPaperIntentHintToFrame } from "./paperIntentHint.js";

// ---------- 协议 / 常量 -----------------------------------------------------

/** 桥接路径(只此一个,gateway upgrade 路由按 url.pathname 匹配)。 */
export const BRIDGE_WS_PATH = "/ws/user-chat-bridge";

/** 五枚举目标画面比例(与 protocol imageEdit.targetAspect / gateway OUTPAINT_ASPECT_RATIOS
 * 同源;master 侧只做识别不算几何,故内联而非跨包 import 保持接帧热路径零新依赖)。 */
const OUTPAINT_ASPECTS = new Set(["16:9", "4:3", "9:16", "3:4", "1:1"]);
const CONTROL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const isControlId = (value: unknown): value is string =>
  typeof value === "string" && CONTROL_ID_RE.test(value);

/** Leftover live-journal frames (no cmid) stay durable but never ride the hot WS. */
export function isLeftoverHotWsFrame(wire: { type?: unknown; clientMessageId?: unknown }): boolean {
  if (isClientMessageId(wire.clientMessageId)) return false;
  return wire.type === "outbound.message" || wire.type === "outbound.error";
}

function parseLeftoverHotWsPayload(data: string): boolean {
  try {
    const parsed = JSON.parse(data) as { type?: unknown; clientMessageId?: unknown };
    return isLeftoverHotWsFrame(parsed);
  } catch {
    return false;
  }
}

/** Strictly recognize a server-completed image-edit envelope before bypassing
 * ordinary Codex precheck/journal plumbing. A loose `imageEdit` presence
 * check would let malformed client frames evade normal chat billing.
 *
 * v5 图片体验:两种直投形态都必须命中此 bypass(否则会被当普通 codex chat turn
 * 预扣槽/开 journal,而 gateway 又永远不发 codex turn → 计费悬挂 / 双计费):
 *   - annotated(笔刷圈选 / 数字锚点评论):带用户 mask,media=[source,mask,guide]
 *     → 3 个互异图片索引(mode 缺省即此,兼容旧前端)。
 *   - outpaint(调整画面比例):无用户 mask,media=[source,guide] → 2 个互异图片
 *     索引 + 合法 targetAspect。计费同 50 积分/张,relay 内完成。 */
export function isValidatedAnnotatedImageInbound(frame: Record<string, unknown>): boolean {
  if (frame.type !== "inbound.message") return false;
  const content = frame.content;
  if (!content || typeof content !== "object") return false;
  const typedContent = content as { text?: unknown; media?: unknown; imageEdit?: unknown };
  if (typeof typedContent.text !== "string" || typedContent.text.trim().length === 0) return false;
  if (!Array.isArray(typedContent.media)) return false;
  const media = typedContent.media;
  const edit = typedContent.imageEdit;
  if (!edit || typeof edit !== "object") return false;
  const value = edit as Record<string, unknown>;
  if (typeof value.clientJobId !== "string" || !/^[0-9a-f]{32}$/.test(value.clientJobId)) return false;
  if (!Number.isInteger(value.width) || Number(value.width) < 1 || Number(value.width) > 8192) return false;
  if (!Number.isInteger(value.height) || Number(value.height) < 1 || Number(value.height) > 8192) return false;
  if (Number(value.width) * Number(value.height) > 16_777_216) return false;
  const isOutpaint = value.mode === "outpaint";
  if (isOutpaint && !OUTPAINT_ASPECTS.has(value.targetAspect as string)) return false;
  const indices = isOutpaint
    ? [value.sourceIndex, value.guideIndex]
    : [value.sourceIndex, value.maskIndex, value.guideIndex];
  const wantDistinct = isOutpaint ? 2 : 3;
  if (
    !indices.every((index) => Number.isInteger(index) && Number(index) >= 0 && Number(index) < media.length)
    || new Set(indices).size !== wantDistinct
  ) return false;
  return indices.every((index) => {
    const item = media[Number(index)];
    return !!item && typeof item === "object" && (item as { kind?: unknown }).kind === "image";
  });
}

/** WebSocket close codes(自家私有码段:4000-4999)。 */
export const CLOSE_BRIDGE = {
  NORMAL: 1000,
  POLICY: 1008,
  TOO_BIG: 1009,
  INTERNAL: 1011,
  /** 容器未就绪 / 迁移中(对应 supervisor.ensureRunning 的 503)。前端按 retryAfter 重试。 */
  CONTAINER_UNREADY: 4503,
  /** V3 Phase 4H+ maintenance_mode=true 时非 admin 的 close code。前端按 retryAfter 重连,
   *  但在维护期内会持续被拒,直到管理员关闭开关。 */
  MAINTENANCE: 4504,
  /** 同一用户连接数超限踢旧连接。不要用 1008,否则前端会误判为登录过期。 */
  TOO_MANY_CONNECTIONS: 4505,
  /** 计费/余额类策略拒绝。 */
  BILLING_POLICY: 4506,
  /** 用户可调整的产品策略(如模型未授权),不是 access token 失效。 */
  PRODUCT_POLICY: 4507,
  /** GPT/Codex 环境被回收/重建,提示刷新重试。 */
  ENV_RECYCLED: 4508,
  /** 服务重启/发版(shutdown → registry.closeAll)。**瞬态**:前端收此码后静默自动重连,
   *  hello/resume 从容器 ring 续传,不弹错、不进会话正文(web-react pure.ts classifyClose
   *  同步认识此码,两端语义务必同改)。不要复用 4505——那是"连接数超限"的 kick 语义。 */
  SERVER_RESTART: 4509,
} as const;

/** 入站 / 出站 帧的最大字节数(单帧)。
 * 前端允许附件单文件 200 MiB / 总量 300 MiB (raw),一条 inbound.message 帧一次性打包全部 media,
 * base64 膨胀 4/3 ≈ 400 MiB + JSON/dataURL prefix/文件名 envelope → 448 MiB 圆整。
 * 早期 1 MiB / 80 MiB 会让大附件被 ws 库 Receiver 以 RangeError 直接关连接,消息到不了业务层。
 *
 * 导出供 index.ts 装配 createTunnelContainerSocket 时复用,避免两处 magic number 漂移。 */
export const DEFAULT_MAX_FRAME_BYTES = 448 * 1024 * 1024;

/** 单条 hello 最多查这么多在飞候选。peers 数组来自客户端,无此上限可把 PG 打满。 */
const HELLO_TERMINAL_NOTIFY_MAX_CANDIDATES = 8;
/** clientMessageId 长度硬顶。先挡住无界字符串(单帧上限 448 MiB),再跑格式校验。 */
const HELLO_TERMINAL_NOTIFY_MAX_CLIENT_MESSAGE_ID_LEN = 200;
/** 单条 hello 最多从 PG 补齐这么多会话的在飞 live frames。 */
const HELLO_LIVE_CATCHUP_MAX_SESSIONS = 8;
/** 单会话 hello 补齐帧数封顶,与 GET live-frames 页大小对齐。 */
const HELLO_LIVE_CATCHUP_MAX_FRAMES = 500;

export const PROMPT_QUEUE_DISPATCH_REQUEST_TYPE = "outbound.prompt_queue.dispatch_request";
export const PROMPT_QUEUE_DISPATCH_RESULT_TYPE = "outbound.prompt_queue.dispatch_result";
export const PROMPT_QUEUE_DISPATCH_CANCEL_TYPE = "outbound.prompt_queue.dispatch_cancel";
export const PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE = "outbound.prompt_queue.dispatch_activated";
export const PROMPT_QUEUE_GRANT_FIELD = "__oc_prompt_queue_grant";

export interface PromptQueueDispatchRequest {
  type: typeof PROMPT_QUEUE_DISPATCH_REQUEST_TYPE;
  grantId: string;
  owner: {
    sessionKey: string;
    clientSessionId: string;
    agentId: string;
    peer: { id: string; kind: "dm" };
  };
  claim: { epoch: string; claimToken: string };
  item: {
    itemId: string;
    clientMessageId: string;
    contentHash: string;
    content: Record<string, unknown>;
    requestedExecution: {
      agentId: string;
      model?: string;
      modelSwitchId?: string;
      effortLevel?: string | null;
      teamMode?: boolean;
    };
  };
}

export interface PromptQueueDispatchResult {
  type: typeof PROMPT_QUEUE_DISPATCH_RESULT_TYPE;
  grantId: string;
  owner: PromptQueueDispatchRequest["owner"];
  itemId: string;
  contentHash: string;
  epoch: string;
  claimToken: string;
  outcome: "rejected";
  disposition: "retryable" | "user_action_required";
  reasonCode: string;
}

export interface PromptQueueDispatchCancel {
  type: typeof PROMPT_QUEUE_DISPATCH_CANCEL_TYPE;
  grantId: string;
  owner: PromptQueueDispatchRequest["owner"];
  itemId: string;
  contentHash: string;
  epoch: string;
  claimToken: string;
  reasonCode: string;
}

export interface PromptQueueDispatchActivated {
  type: typeof PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE;
  grantId: string;
  owner: PromptQueueDispatchRequest["owner"];
  itemId: string;
  contentHash: string;
  epoch: string;
  claimToken: string;
}

/**
 * Parse the trusted container→master queue hand-off. This is deliberately a
 * separate internal envelope: browsers cannot mint a dispatch grant merely by
 * adding private fields to an ordinary inbound.message.
 */
export function parsePromptQueueDispatchRequest(value: unknown): PromptQueueDispatchRequest | null {
  if (!isPlainRecord(value) || value.type !== PROMPT_QUEUE_DISPATCH_REQUEST_TYPE) return null;
  if (!hasOnlyKeys(value, ["type", "grantId", "owner", "claim", "item"])) return null;
  if (typeof value.grantId !== "string" || !/^[0-9a-f-]{36}$/.test(value.grantId)) return null;
  const owner = value.owner;
  const claim = value.claim;
  const item = value.item;
  if (!isPlainRecord(owner) || !hasOnlyKeys(owner, ["sessionKey", "clientSessionId", "agentId", "peer"])) return null;
  if (
    typeof owner.sessionKey !== "string" || owner.sessionKey.length < 1 || owner.sessionKey.length > 512 ||
    typeof owner.clientSessionId !== "string" || owner.clientSessionId.length < 1 || owner.clientSessionId.length > 256 ||
    typeof owner.agentId !== "string" || owner.agentId.length < 1 || owner.agentId.length > 64 ||
    !isPlainRecord(owner.peer) || !hasOnlyKeys(owner.peer, ["id", "kind"]) ||
    owner.peer.kind !== "dm" || owner.peer.id !== owner.clientSessionId
  ) return null;
  const canonicalSessionKey =
    `agent:${owner.agentId}:webchat:dm:${owner.peer.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (owner.sessionKey !== canonicalSessionKey) return null;
  if (
    !isPlainRecord(claim) || !hasOnlyKeys(claim, ["epoch", "claimToken"]) ||
    typeof claim.epoch !== "string" || !/^(0|[1-9][0-9]*)$/.test(claim.epoch) ||
    typeof claim.claimToken !== "string" || !/^[0-9a-f]{64}$/.test(claim.claimToken)
  ) return null;
  if (!isPlainRecord(item) || !hasOnlyKeys(item, ["itemId", "clientMessageId", "contentHash", "content", "requestedExecution"])) return null;
  if (
    !isClientMessageId(item.itemId) || !isClientMessageId(item.clientMessageId) ||
    typeof item.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(item.contentHash) ||
    !isPlainRecord(item.content) || !isPlainRecord(item.requestedExecution)
  ) return null;
  const execution = item.requestedExecution;
  if (!hasOnlyKeys(execution, ["agentId", "model", "modelSwitchId", "effortLevel", "teamMode"])) return null;
  if (execution.agentId !== owner.agentId) return null;
  if (execution.model !== undefined && typeof execution.model !== "string") return null;
  if (execution.modelSwitchId !== undefined && (typeof execution.modelSwitchId !== "string" || !/^[A-Za-z0-9:_-]{8,128}$/.test(execution.modelSwitchId))) return null;
  if (execution.effortLevel !== undefined && execution.effortLevel !== null && typeof execution.effortLevel !== "string") return null;
  if (execution.teamMode !== undefined && typeof execution.teamMode !== "boolean") return null;
  return value as unknown as PromptQueueDispatchRequest;
}

export function parsePromptQueueDispatchCancel(value: unknown): PromptQueueDispatchCancel | null {
  if (!isPlainRecord(value) || value.type !== PROMPT_QUEUE_DISPATCH_CANCEL_TYPE) return null;
  if (!hasOnlyKeys(value, [
    "type", "grantId", "owner", "itemId", "contentHash", "epoch", "claimToken", "reasonCode",
  ])) return null;
  const request = parsePromptQueueDispatchRequest({
    type: PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
    grantId: value.grantId,
    owner: value.owner,
    claim: { epoch: value.epoch, claimToken: value.claimToken },
    item: {
      itemId: value.itemId,
      clientMessageId: value.itemId,
      contentHash: value.contentHash,
      content: {},
      requestedExecution: {
        agentId: isPlainRecord(value.owner) ? value.owner.agentId : undefined,
      },
    },
  });
  if (
    request === null ||
    typeof value.reasonCode !== "string" ||
    !/^[A-Z0-9_]{1,64}$/.test(value.reasonCode)
  ) return null;
  return value as unknown as PromptQueueDispatchCancel;
}

export function parsePromptQueueDispatchActivated(value: unknown): PromptQueueDispatchActivated | null {
  if (!isPlainRecord(value) || value.type !== PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE) return null;
  if (!hasOnlyKeys(value, [
    "type", "grantId", "owner", "itemId", "contentHash", "epoch", "claimToken",
  ])) return null;
  const request = parsePromptQueueDispatchRequest({
    type: PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
    grantId: value.grantId,
    owner: value.owner,
    claim: { epoch: value.epoch, claimToken: value.claimToken },
    item: {
      itemId: value.itemId,
      clientMessageId: value.itemId,
      contentHash: value.contentHash,
      content: {},
      requestedExecution: {
        agentId: isPlainRecord(value.owner) ? value.owner.agentId : undefined,
      },
    },
  });
  return request === null ? null : value as unknown as PromptQueueDispatchActivated;
}

function samePromptQueueDispatch(
  control: PromptQueueDispatchCancel | PromptQueueDispatchActivated,
  request: PromptQueueDispatchRequest,
): boolean {
  return control.grantId === request.grantId &&
    control.owner.sessionKey === request.owner.sessionKey &&
    control.owner.clientSessionId === request.owner.clientSessionId &&
    control.owner.agentId === request.owner.agentId &&
    control.owner.peer.id === request.owner.peer.id &&
    control.owner.peer.kind === request.owner.peer.kind &&
    control.itemId === request.item.itemId &&
    control.contentHash === request.item.contentHash &&
    control.epoch === request.claim.epoch &&
    control.claimToken === request.claim.claimToken;
}

function promptQueueDispositionForCode(
  code: string,
): "retryable" | "user_action_required" {
  return /^(?:ERR_INSUFFICIENT_CREDITS|INSUFFICIENT_CREDITS|MODEL_NOT_AVAILABLE|UNAUTHORIZED_MODEL|UNRESOLVED_AGENT_MODEL|AGENT_NOT_FOUND|INVALID_|ERR_FRAME_TOO_BIG)/.test(code)
    ? "user_action_required"
    : "retryable";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

export function shouldRejectCodexTurnForG7(
  hasActiveTurn: boolean,
  isPromptQueueDispatch: boolean,
): boolean {
  return hasActiveTurn && !isPromptQueueDispatch;
}

/** 单方向 buffer 上限。超出 = 慢消费者 / 死循环 → close。 */
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** 连接到容器的超时 ms。容器 WS 同机回环,1s 都嫌长。 */
const DEFAULT_CONTAINER_CONNECT_TIMEOUT_MS = 5_000;

/** Queue grants must either reach the container or resolve negative while the
 * server-side claim is still live. The timeout also becomes a cancellation
 * fence: a late async preparation result is never allowed to start a turn. */
const DEFAULT_PROMPT_QUEUE_PREPARATION_TIMEOUT_MS = 20_000;

/** ConnectionRegistry 默认 maxPerUser(沿用 connections.ts 的 3)。 */
const DEFAULT_MAX_PER_USER = 3;

/**
 * 2026-04-21 安全审计 HIGH#5:WS ping/pong 心跳。
 *
 * 为什么需要:
 *   - 前端移动端 / 家宽 NAT / 运营商透明代理会在 60-180s 无流量时悄悄 half-close,
 *     TCP 层不发 RST,gateway 以为 socket 还活着,持续占用一条 connection pool slot
 *     + uid→ws 表里的死连接会被 broadcastToUser 当作在线在循环里 send 无效字节。
 *   - 前端 webscoket.js onclose 心跳只检到自己这侧的 EOF,中间链路断掉它不感知,
 *     最终靠业务帧失败才发觉,期间用户看到"发完消息没反应"。
 *
 * 实现:
 *   - 每 30s server 向 client 发 ping;上一次 ping 发出后直到 60s 内必须收到 pong
 *     或任何 message(下游正常聊天帧也算"还活着"的证据)。
 *   - 超时 → terminate() + cleanup 走 client_close 路径,不对容器侧造成额外影响。
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
// turn 在飞最长心跳宽限。CF/Caddy 不转发 WS ping/pong 控制帧 → 浏览器在等长 turn
// (冷启 TTFT / 长生成 / 慢工具 / 静默推理)期间没有任何上行信号刷 lastAlive,会被 60s
// 心跳误杀,连带丢掉响应帧与 cost_charged(计费在 turn 收尾后才广播)。对策:用户发了
// inbound.message 即视为"在等响应",turn 在飞期间不 reap;但这是从 turn 起点算的**硬上限**,
// 防"浏览器真断 + turn 卡死"的连接永不回收(turnActiveUntil 不被下行帧续期,见 Codex 审)。
const MAX_TURN_GRACE_MS = 10 * 60_000;
// turn 收尾(isFinal)后保留的短宽限:cost_charged 在 isFinal 之后才广播,留窗口确保它
// 还能投到 user WS;窗口过后回归正常 idle 回收。取 min(原硬上限剩余, 此值),只缩不延。
const POST_FINAL_GRACE_MS = 90_000;

// ---------- 公共类型 --------------------------------------------------------

/**
 * 容器端点解析器 — Phase 2 由测试或外层注入,Phase 3D 由 supervisor.ensureRunning 实现。
 *
 * 抛 `ContainerUnreadyError(retryAfterSec, reason)` → 桥接层 close(4503, reason)
 *   并把 retryAfter 写进 close reason JSON;前端按建议秒数重连
 *
 * 抛任何其他 error → close(1011, 'internal error');不暴露原始 error 到客户端
 */
export type ResolveContainerEndpoint = (
  uid: bigint,
) => Promise<{
  host: string;
  port: number;
  /**
   * agent_containers.id —— 用于 bridge 调用 markContainerActivity 刷
   * last_ws_activity 防 idle sweep 误杀长会话。可选:测试 / 单测 mock 不需要;
   * v3 supervisor 路径会填上。缺失时 bridge 不发活动信号(语义降级)。
   */
  containerId?: number;
  /**
   * 本次 ensureRunning 是否走了 provision 分支(冷启)。
   * - true → bridge 在 containerWs 'open' 时给 userWs 发一帧 `{type:"sys.cold_start"}`,
   *   前端据此把 typing indicator 文案换成"首次加载上下文较慢"提示
   * - false → 不发,前端走标准"思考中"
   *
   * 缺失视同 false(向后兼容,测试 mock 不必填)。
   *
   * 漏标 trade-off:provision 成功但 readiness 超时 → 4503 → 重连后命中 running 分支,
   * 此时 coldStart=false 但用户实际经历了冷启。低概率事件,运维 metric 也会有同样
   * 漏标(ws_bridge_ttft_seconds.kind=warm 不严格等于"未冷启")。
   */
  coldStart?: boolean;
  /**
   * 跨 host 路由信号:set 表示这个容器在远端 host(boundIp/port 不可直达),
   * bridge 必须经 node-agent tunnel 拉 WS。`nodeAgent` 是为本次 bridge 建链
   * 重新 hydrate 的 NodeAgentTarget(短生命周期,bridge 用完就丢) — 不要复用
   * readiness 内部那份(那份 psk 探活完 fill(0) 了)。
   *
   * 未 set → bridge 直接 dial host:port(self-host / 单机 MVP 场景,行为不变)。
   *
   * 历史 bug(2026-04-26):没有这个字段时 bridge 对 remote-host 容器一直
   * EHOSTUNREACH,readiness 通过后立即 4503 重连风暴。
   */
  tunnel?: {
    hostId: string;
    containerInternalId: string;
    nodeAgent: NodeAgentTarget;
  };
  /**
   * 容器**实际运行**的 platform bundle rev(容器 label `com.openclaude.runtime.bundle_rev`;
   * v3ensureRunning 从 docker inspect labels / provision 实际打的 label 取,不是 master 的
   * desired tuple)。
   *
   * 模型权威批次 §5 阶段 B:bridge 拿它去读**该 rev 的** seed 声明推导 seed agent 计费模型。
   * 正因为需要它,`loadAgentModelResolver` 的调用必须排在 `resolveContainerEndpoint` **之后**
   * —— 否则 master 会用 current 声明给跑旧 seed 的容器计费(滚动窗口分叉)。
   *
   * 缺失(bundle 轴未启用 / 旧容器 / 测试 mock)→ flag `OC_SEED_AUTHORITY_BY_REV` 未开时无害;
   * flag 开启时 resolver loader 抛 SeedDeclarationError → 桥 close(1011) fail-closed。
   */
  bundleRev?: string;
}>;

/**
 * 容器未就绪(provision 中 / 迁移中 / 临时不可达)。
 *
 * MVP 单 host 下,主要触发场景:
 *   - 首次连 ws 时容器还没 provision(冷启 5-10s)
 *   - persistent 容器 stop 后正在 startStoppedContainer
 *
 * Phase 3 supervisor.ensureRunning 内部将 throw 这个;Phase 2 测试桩可手 throw。
 */
export class ContainerUnreadyError extends Error {
  constructor(
    /** 前端建议下次尝试的秒数(2-30 之间合理)。 */
    readonly retryAfterSec: number,
    /** 短诊断字符串,例如 "provisioning" / "migration_in_progress" / "starting"。 */
    readonly reason: string,
  ) {
    super(`container not ready: ${reason} (retry after ${retryAfterSec}s)`);
    this.name = "ContainerUnreadyError";
  }
}

/** 测试 / 2I-2 metrics 回调:单事件钩子。 */
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

/** 等待容器 attestation 的默认上限。容器 open 后立刻发 attest,10s 已是极宽松的上限。 */
const DEFAULT_ATTEST_TIMEOUT_MS = 10_000;

/**
 * slice1 catalog descriptor → protocol 签名载荷 descriptor(wire 形状)。
 *
 * 两个 `ModelExecutionDescriptor` 是**有意不同**的类型:
 *   - commercial/billing/modelCatalog 的那份是 DB 投影(带 providerId / upstreamModelId
 *     —— **路由**语义,只有 master/egress 需要,容器不该看见上游身份);
 *   - protocol 的那份是**容器执行**语义(capability / context / effort / vision)。
 * 这里做一次显式收窄 = 「凭据与路由不进容器」这条边界在类型层的落点。
 *
 * `contextWindow` 的 null 原样进入签名载荷；0 不是合法窗口，不能拿哨兵值混淆语义。
 */
function toProtocolDescriptor(
  d: import("../billing/modelCatalog.js").ModelExecutionDescriptor,
): ModelExecutionDescriptor {
  const profile = d.capabilityProfile;
  return {
    capabilityProfile: {
      supportsVision: profile.supportsVision,
      reasoning: {
        supported: [...profile.reasoning.supported],
        codexModelDefault: profile.reasoning.codexModelDefault,
      },
      ccb: {
        capabilityZero: profile.ccb.capabilityZero,
        supportsThinking: profile.ccb.supportsThinking,
      },
    },
    capabilitySchemaVersion: d.capabilitySchemaVersion,
    contextWindow: d.contextWindow,
    supportedEfforts: [...profile.reasoning.supported],
    ...(profile.reasoning.codexModelDefault === null
      ? {}
      : { codexDefaultEffort: profile.reasoning.codexModelDefault }),
    supportsVision: profile.supportsVision,
  };
}

/** 一个 turn 的执行解析结果(epoch fence 已过 → 可以签)。 */
interface ResolvedTurnExecution {
  canonicalModel: string;
  engine: ModelAuthorityEngine;
  descriptor: ModelExecutionDescriptor;
  /** 与 descriptor / epoch 来自同一个 fenced snapshot generation 的原始模型价格。 */
  pricing: ModelPricing;
  /** 只进 journal/audit，不对容器暴露。 */
  billingRevision: string;
  /** 该 turn 的平台次级模型放行集(见 billing/modelCatalog.ts platformAuxModels)。 */
  auxModels: string[];
  executionRevision: string;
  securityEpoch: number;
}

/** 模型不可路由(catalog 无 active 行 / 无价 / capability schema 未来版本)。 */
class ModelNotAvailableError extends Error {
  constructor(readonly modelId: string) {
    super(`model not available: ${modelId}`);
    this.name = "ModelNotAvailableError";
  }
}

/**
 * epoch fence + 解析执行 descriptor(方案 §1.2 R3-B2:签发 authority **之前**必须 fence)。
 *
 * `catalog.assertFresh()` 语义:快照 epoch 与 DB 单行 epoch 比对(**无时间缓存**),
 * 不等 → 同步重建;重建失败 / DB 不可达 → 抛 → 调用方拒帧(fail-closed)。
 */
async function resolveTurnExecution(
  catalog: ModelCatalogCache,
  modelIdOrAlias: string,
): Promise<ResolvedTurnExecution> {
  const snapshot: ModelCatalogSnapshot = await catalog.assertFresh();
  const canonicalModel = snapshot.aliasToCanonical(modelIdOrAlias);
  const descriptor = snapshot.resolve(canonicalModel);
  const pricing = snapshot.billingPricingFor(canonicalModel);
  if (descriptor === null || pricing === null) throw new ModelNotAvailableError(modelIdOrAlias);
  return {
    canonicalModel: descriptor.canonicalModel,
    engine: descriptor.engine,
    descriptor: toProtocolDescriptor(descriptor),
    pricing,
    billingRevision: snapshot.billingRevision,
    // 次级模型只对 **ccb** 引擎有意义:CCB 的 WebFetch/WebSearch 等隐藏调用读
    // ANTHROPIC_SMALL_FAST_MODEL 打 anthropic proxy;codex turn 走 /internal/v3/codex-relay,
    // 根本不产生 `/v1/messages` —— 给它签 aux 只会白白撑大放行集合(最小权限)。
    // platformAuxModels 对"aux 不在 catalog active"fail-closed 抛 → 调用方拒帧。
    auxModels: descriptor.engine === "ccb" ? platformAuxModels(snapshot) : [],
    executionRevision: snapshot.executionRevision,
    securityEpoch: Number(snapshot.securityEpoch),
  };
}

// ---------- Deps + Handler --------------------------------------------------

export interface UserChatBridgeDeps {
  jwtSecret: string | Uint8Array;
  /** Prompt queue is dark unless the process-level rollout flag is exactly on. */
  promptQueueEnabled?: boolean;
  /** Internal queue preparation deadline; override only for focused tests. */
  promptQueuePreparationTimeoutMs?: number;
  /**
   * 模型执行权威签发(方案 §2)。注入即开启 flag —— 见 BridgeModelAuthorityDeps。
   * 缺省(v3 / 测试 / flag 未开)→ bridge 行为与本批次之前**完全一致**。
   */
  modelAuthority?: BridgeModelAuthorityDeps;
  /** 解析 uid → 容器 host/port。Phase 3D 接 supervisor.ensureRunning;Phase 2 单测自行 mock。 */
  resolveContainerEndpoint: ResolveContainerEndpoint;
  /**
   * 版本握手(v5 spa):返回当前 dist 前端构建 id(index.html `<meta name="oc-build">`,
   * 见 ws/frontendBuild.ts probe)。注入后 bridge 在每个 userWs accept 时发一帧
   * `{type:"sys.frontend_build", build}` —— 客户端 reload governor 据此在安全点软刷新,
   * 收敛"长驻旧 bundle 撞新服务端语义"(2026-07-07 CODEX_BILLING_GUARD 旧前端复发事故)。
   * 未注入(v3 / 测试)或返回 null → 不发帧,零行为变化。
   */
  getFrontendBuildId?: () => string | null;
  /** 可选:每用户最大并发(默认 3)。 */
  maxPerUser?: number;
  /** 可选:单帧上限(双向,默认 1MB)。 */
  maxFrameBytes?: number;
  /** 可选:单方向 buffer 上限(默认 4MB)。 */
  maxBufferedBytes?: number;
  /** 可选:连接到容器的超时(默认 5s)。 */
  containerConnectTimeoutMs?: number;
  /** 可选:心跳 ping 间隔 ms(默认 30s)。设 0 禁用(测试用)。 */
  heartbeatIntervalMs?: number;
  /** 可选:心跳超时 ms(默认 60s),超过未收到 pong/message 即判死链。 */
  heartbeatTimeoutMs?: number;
  /** 可选:metrics 钩子(2I-2 接 prom-client)。 */
  metrics?: BridgeMetricSink;
  /** 可选:logger(2I-1)。不传则静默(降到 noop)。 */
  logger?: Logger;
  /**
   * 可选:覆盖容器 WS 客户端构造,主要给单测注入 ws.Server 双向 mock。
   * 默认实现:`new WebSocket(\`ws://${host}:${port}/ws\`)`。
   * 仅用于 endpoint.tunnel **未** set 的情况(self-host / 单机 MVP)。
   */
  createContainerSocket?: (host: string, port: number, signal: AbortSignal) => WebSocket;
  /**
   * 必选(若任何 endpoint 可能返回 tunnel):跨 host 路径下从 node-agent tunnel 拉
   * 容器 WS。default 装配在 commercial/src/index.ts;单测可注入 mock。
   *
   * async 是因为内部要先 await 完 mTLS+pin TLS 握手才能把 socket 交给 ws 库
   * (避免在 cert 校验未完成时把 PSK 写出去)。bridge 在 await 期间继续接早到帧。
   *
   * 抛错或返 reject 都视作"容器不可达",bridge close(1011)。endpoint.tunnel 已
   * set 但本字段未注入 → 同样按"容器不可达"处理(见 handleUpgrade)。
   */
  createTunnelContainerSocket?: (
    tunnel: { hostId: string; containerInternalId: string; nodeAgent: NodeAgentTarget },
    containerPort: number,
    signal: AbortSignal,
    /**
     * S12e CG4(合同 A):connection-level trace id,bridge 持有的 `connId = randomUUID()`
     * 直传。工厂内部写到 outgoing tunnel WS upgrade 的 `X-Connection-Trace-Id` header,
     * node-agent / in-container gateway 据此关联整条 connection 的 log。
     *
     * 必传 string —— 调用方在 startBridge 一定已经生成 connId(line ~999);测试 mock
     * 也必须传(传 `_connId` 之类参数承接即可)。
     */
    connectionTraceId: string,
  ) => Promise<WebSocket>;
  /**
   * 可选:每收到一帧 client→container 消息时调用,用于刷 last_ws_activity。
   *
   * bridge 内部做了 60s debounce(常量 `ACTIVITY_REFRESH_INTERVAL_MS`),所以 caller
   * 不必再做节流。container→user 帧、ping/pong、心跳**都不刷**(防 chatty 输出
   * 把 idle 假装成活跃)。markContainerActivity 自身要 fire-and-forget(不阻塞 bridge),
   * 异常也要 swallow,典型实现包 `void markV3ContainerActivity(deps, cid)`。
   *
   * 没注入 / endpoint 没返 containerId → bridge 直接跳过这层逻辑(等价空实现)。
   */
  markContainerActivity?: (containerId: number) => void;
  /**
   * 0049 模型授权(plan v3 §B3/§B4 + §F4)—— 桥接层是 v3 commercial **唯一**能
   * 看到 inbound.message 帧并且也能拿到 user role + grants 的位置:
   *   - 容器内 personal-version gateway 没有 commercial DB 连接,查不了 grants
   *   - HTTP message-create handler 在 v3 不存在(用户消息走 WS,不走 REST)
   *
   * caller(commercial/index.ts)在 bridge 启动连接时加载 checker，拿到一个**已绑定
   * uid+DB role+grants+catalog visibility**的纯同步 closure;后续每条 user→container
   * 文本帧若是 inbound.message 且带 `model` 字段,就 sync 调一次 checker。返 false →
   * 桥发 error frame + close(1008),不把帧 forward 进容器(避免容器侧 inferAgentForModel
   * 错误信息泄漏 codex agent / config 状态;plan v3 §B4 review v3 补)。
   *
   * loadAllowedModelChecker 失败 throw → 桥关 1011 'agent unavailable'(grants 加载
   * 失败不能 silently 放行,bridge 不区分 DB 故障 vs 用户被禁,统一拒)。
   *
   * 未注入(测试 / 个人版上下文)→ 桥不做模型校验,完全透传(行为与本字段加入前一致)。
   *
   * 为什么不在 bridge 内部直接持 PricingCache + listGrantsForUser:这一层不应耦合
   * billing / admin 子模块;dep injection 把"鉴权策略"留给 caller 拼装,bridge 单测
   * 可注入 mock checker 而不必拖起 PricingCache。
   */
  loadAllowedModelChecker?: (
    uid: bigint,
    /** checker 必须至少绑定到该 security epoch；未启模型权威时为 undefined。 */
    requiredEpoch?: bigint,
  ) => Promise<(modelId: string) => boolean>;
  /**
   * P0 计费旁路封堵(bridge 可信模型推导)—— master 侧 agent 权威:
   * 「该 uid 语境下 agentId 的有效模型」的 sync 快照 closure。
   *
   * 为什么需要:M1a 起容器 gateway 的 engine 判定按 model(resolveEngine),
   * 帧不带 model 时回落 **agent.model**。bridge 若只信 frame.model /
   * agentId==='codex' / lastSeenModelId,则「agent.model=gpt-5.5 + 帧无 model」
   * 的 turn 会被 bridge 当非 codex 透传 —— 不 preCheck、不开 inflight journal、
   * 不注 server-owned requestId → 免费 codex。bridge 必须用 master 自己的
   * agent 权威推导有效模型参与 codex 分类,推导不出且帧无 model → fail-closed
   * 拒帧(不放行)。
   *
   * caller(commercial/index.ts)的权威组成(与容器 agents.yaml 的 master 侧
   * 权威源一一对应):
   *   - 内置 seed agents:main → PLATFORM_DEFAULT_MODEL、codex → gpt-5.5、
   *     hidden-reviewer → PLATFORM_HIDDEN_REVIEWER_MODEL(entrypoint
   *     desiredSeedAgents 的 master 侧镜像);
   *   - marketplace 平台预设 + 用户已装 agent:manifest.model
   *     (internalMarketplaceSync 同源:listPlatformPresetAgents ∪
   *     runtime-ready Agent projections,同 slug 预设优先)。
   * 容器侧用户手改 agents.yaml 的 agent 不在权威内 → 推导失败 → 拒
   * (gateway seam 的 requestId fail-closed guard 是同问题的容器侧兜底)。
   *
   * 生命周期(**模型权威批次 §5 阶段 B 重排**):**必须在 `resolveContainerEndpoint`
   * 之后**加载 —— seed agent 的执行三元组权威 = 该容器实际跑的 bundle rev 的 seed 声明,
   * 而 rev 只有 ensureRunning 返回容器 label 之后才知道。载入失败(含 seed 声明读不出的
   * SeedDeclarationError)→ 桥关 1011,**不静默放行、不回落 master 常量**(回落 = 滚动窗口
   * 里 master 按 current 声明计费、容器按旧 seed 执行的分叉重现)。
   *
   * 桥 lifetime 内随 GRANTS_REFRESH_INTERVAL_MS 周期刷新(新装 agent 在窗口内生效;推导 miss
   * 时也会即时补触发一次 refresh,用户重发即可)。**refresh 复用同一 `bundleRev`**:容器在连接
   * 存续期内不变(被 recycle → 桥断 → 新连接重取 label);refresh 失败保留上次快照。
   *
   * 未注入(测试 / 旧装配)→ 桥不做推导,行为与本字段加入前一致。
   */
  loadAgentModelResolver?: (
    uid: bigint,
    opts: {
      /** 容器 label 上的 platform bundle rev(见 ResolveContainerEndpoint.bundleRev)。 */
      bundleRev?: string;
    },
  ) => Promise<AgentModelResolver>;
  /**
   * Commercial v3 authority for browser chat history lives in master's
   * SQLite, not inside the per-user container. When a browser session switches
   * between providers (e.g. DeepSeek/CCB → Codex native), the container needs
   * a model-window-selected transcript preamble to bridge the provider-local
   * resume gap. The dep returns the selected master messages; this bridge
   * normalizes their semantic fields before attaching the private
   * `_masterHistoricalMessages` field, without a second content cap.
   */
  loadMasterSessionMessages?: (
    uid: bigint,
    sessionId: string,
    options: {
      contextWindow: number | null;
      engine: string;
      currentUserText: string;
      excludeClientMessageId?: string;
    },
  ) => Promise<unknown[] | null>;
  /** Completion dedupe is an indexed authority check, not a reason to hydrate
   * model history (and therefore never touches old giant tape BYTEA). */
  hasCompletedClientTurn?: (
    uid: bigint,
    sessionId: string,
    clientMessageId: string,
  ) => Promise<boolean>;
  /** Platform GoalState injected into every accepted browser turn. */
  loadGoalState?: (uid: bigint, sessionId: string) => Promise<GoalStateSnapshot | null>;
  /** Engine notifications may update only diagnostic engine-owned fields. */
  updateGoalEngineMetrics?: (args: {
    uid: bigint;
    sessionId: string;
    goalId: string;
    stateRevision: number;
    engineStatus?: string;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    engineUpdatedAt?: string;
  }) => Promise<unknown>;
  /** Persist the browser-authored user row before any paid/runtime work starts.
   * V5 wires this to the authoritative PG session backend; tests/legacy
   * deployments may omit it and retain the old forwarding path. */
  persistMasterUserMessage?: (
    uid: bigint,
    sessionId: string,
    message: {
      id: string;
      role: "user";
      text: string;
      ts: number;
      _media?: unknown[];
      _retryMedia?: unknown[];
      _imageEdit?: Record<string, unknown>;
      _modelText?: string;
      _replyTo?: MessageReplyQuote;
      _routing?: { model?: string; teamMode: boolean; effortLevel: string | null };
    },
  ) => Promise<{
    applied: boolean;
    reason?: "session_not_found" | "session_deleted" | "already_exists" | "malformed" | "oversized";
    workspaceMode?: SessionWorkspaceMode;
  }>;
  /** Exact stamped container frame journal.  The bridge MUST await this
   * commit before ring insertion or physical browser delivery. */
  persistOutboundFrame?: (input: {
    uid: bigint;
    sessionId: string;
    clientMessageId: string | null;
    agentContainerId: number;
    sessionKey: string;
    frameSeq: number;
    payload: string;
  }) => Promise<void>;
  /** durable turn dispatch 受理面(RFC-v5-durable-turn-dispatch §2.1)。注入且容器 attest
   * DURABLE_TURN_DISPATCH_CAPABILITY 时,替代 persistMasterUserMessage:单事务幂等 append
   * user 行 + UPSERT dispatch 冲突表裁定(受理即拥有 I1)。未注入 / 无 capability → legacy。 */
  admitUserTurn?: (input: AdmitUserTurnInput) => Promise<AdmitUserTurnResult>;
  reconcileAutomaticRecoveryJobs?: (uid: bigint, limit?: number) => Promise<number>;
  /** Authoritative session cwd policy. V5 production always injects this;
   * legacy/test compositions may omit it and retain the shared workspace. */
  loadSessionWorkspaceMode?: (
    uid: bigint,
    sessionId: string,
  ) => Promise<SessionWorkspaceMode | null>;
  /**
   * plan v3 G5/G7 — codex per-account 并发槽 + 严格单飞 acquire/release。
   *
   * 调用契约:
   *   - bridge 在 inbound.message 帧 + effectiveModel 是 codex 类(`gpt-*` 或
   *     agentImpliedModel='gpt-5.5')时调 `acquire(containerId)`
   *   - acquire 返回:
   *     - `null` → 容器是 legacy NULL(`codex_account_id IS NULL`),走 legacy
   *       `config.auth.codexOAuth` 共享 dir 路径,**不占** per-account 槽(决策 N3)
   *     - `{account_id}` → 已 inc inflight + 通过 lazy migrate(若需要)+ 写
   *       per-container auth.json 并 UPDATE codex_account_id;调用方记下此 id 用于
   *       后续 release
   *   - acquire 抛 `AccountPoolBusyError` → bridge fast-fail(决策 O):error 帧
   *     "codex pool busy",**不 fallback 到 legacy**
   *   - acquire 抛其他 → bridge fast-fail "GPT temporarily unavailable"
   *   - `release(account_id, slotId)` 必须用 acquire 时记录的 (account_id, slotId)(决策 N2
   *     MAJOR 3:不重读 row,防 lazy migrate 漂移;slotId 精确还槽,不误伤同账号其它在途槽)
   *
   * **G7 严格单飞**:bridge 内部维护 per-bridge "已持槽" 状态;新 inbound 命中已持
   * 状态 → reject "previous codex turn still in progress"(error 帧),不复用 slot
   * 不并发,frame 不 forward 到容器。
   *
   * 未注入 → bridge 不做 codex 并发管控,inbound 透传(测试 / 个人版上下文)。
   */
  codexBinding?: CodexBindingHandle;
  /** Create an opaque per-turn Codex API relay route. When injected, GPT turns use api_relay groups instead of legacy OAuth codex accounts. */
  createCodexRoute?: (args: {
    containerId: number;
    userId: bigint;
    modelId: string;
    sessionId?: string;
  }) => Promise<CodexRouteDecision | null>;
  /** Expire an opaque per-turn Codex API relay route after the turn settles or aborts. */
  expireCodexRoute?: (token: string) => Promise<void>;
  /** Expire and release the exact durable Grok subscription lease. */
  releaseGrokRouteLease?: (accountId: bigint, slotId: string) => Promise<void>;
  /** Mint a short-lived opaque ZCode Anthropic relay bound to container/user/request/model. */
  mintZcodeRoute?: (args: {
    containerId: number;
    userId: bigint;
    requestId: string;
    modelId: string;
  }) => Promise<{ token: string; baseUrl: string }>;
  /** Drop a minted ZCode relay token after the turn settles or aborts. */
  expireZcodeRoute?: (token: string) => void | Promise<void>;
  /**
   * Trusted UUID of the compute host running this bridge. Cursor credentials
   * are mounted only by that host's local supervisor, so Cursor dispatch must
   * match the container row to this exact host. Missing means fail closed.
   */
  selfHostId?: string | null;
  /**
   * PR2 v1.0.66 — codex 真扣费三件套(必须同时注入或同时缺省)。
   *
   * - 注入(commercial 路径):codex inbound 帧走 preCheck → inflight journal →
   *   forward → outbound.codex_billing settle → ledger debit + cost_charged 广播
   * - 缺省(测试 / 个人版):codex inbound 仍可走 acquire 占槽,但不 settle,纯透传
   *
   * **创建 handler 时强校验**(见 createUserChatBridge entry):partial 注入
   * (例如只注 pgPool 没注 preCheckRedis)→ 直接 throw,防生产配置错把"漏 settle"
   *  静默隐藏导致 codex 免费。codexBinding 已注 ⇒ 三件套必须全注。
   *
   * settle 路径用法(M2 v5 形态):bridge 用 deps.pgPool 写 journal、用
   * deps.preCheckRedis 跑 preCheckWithCost、用 deps.pricing.get(modelId) 拿
   * ModelPricing 复合 agent multiplier;settle 收口在 billing/codexFinalizer
   * (settleUsageAndLedger → spendTwoBucket 双钱包,零输出免单,account_id NULL,
   * session_id = billing 帧 engineSessionId)。
   */
  pgPool?: Pool;
  preCheckRedis?: PreCheckRedis;
  pricing?: PricingCache;
  /**
   * Persist costCredits into master's `client_sessions` blob via storage's
   * `appendCostCredits` helper. Mirror of the same dep on
   * `AnthropicProxyDeps`: bridge in-line持久化 codex 模式扣费,fail-open if
   * not injected. See plan §4.2 改动 4a.
   *
   * Called only on the codex billing commit success branch (debit > 0).
   * Optional in the same way as `appendCostCredits` on anthropicProxy:
   * tests omit, deploy injects.
   */
  appendCostCredits?: (
    requestId: string,
    userId: string,
    costCredits: string,
    sessionId?: string | null,
    parentSessionId?: string | null,
    delegateAgentId?: string | null,
    turnKey?: string | null,
    parentTurnKey?: string | null,
  ) => Promise<unknown>;
}

/**
 * plan v3 G5/G7 — codex 容器与账号绑定 / per-account 并发槽控制 handle。
 *
 * `acquire`:幂等持锁逻辑(决策 N2):查 row.codex_account_id + status,若 active
 * 则直接 inc inflight slot;若非 active 走 lazy migrate(`pickCodexAccountForBinding`
 * + FOR UPDATE 持锁直到 atomic rename + UPDATE 持锁内同 tx 提交;失败 ROLLBACK
 * 自动回滚 codex_account_id);返回最终 acquire 的 account_id(供 release 用)。
 *
 * `release`:dec inflight slot(scheduler.releaseCodexSlot),不调 health.onSuccess /
 * onFailure(决策 J2:bridge 不知道真实 turn 出参,健康分留给 release 层)。幂等。
 */
export interface CodexBindingHandle {
  /** 成功返回 {account_id, slotId};legacy NULL 容器返 null。slotId 为 per-slot 租约 id。 */
  acquire(containerId: number, groupId?: string | null): Promise<{ account_id: bigint; slotId: string } | null>;
  /** Keep a live long-running turn ahead of the orphan-slot reaper. */
  renew?(account_id: bigint, slotId: string): boolean;
  /** 必须用 acquire 时记录的 (account_id, slotId) 成对还槽(精确 + reaper 兜底)。 */
  release(account_id: bigint, slotId: string): void;
}

export interface CodexApiRelayRoute {
  kind?: "api_relay";
  engine?: "codex" | "grok";
  token: string;
  baseUrl: string;
  modelProvider: string;
  providerName?: string | null;
  wireApi?: "responses" | "chat";
  preferredAuthMethod?: "apikey" | "chatgpt";
  disableResponseStorage?: boolean;
  groupId: string;
  credentialId: string;
  /** Grok selects and occupies its subscription account per turn. */
  accountId?: string;
  slotId?: string;
}

export interface CodexOfficialOAuthRoute {
  kind: "official_oauth";
  groupId: string;
}

export interface CodexRouteUnavailable {
  kind: "unavailable";
  reason: string;
}

export type CodexRouteDecision = CodexApiRelayRoute | CodexOfficialOAuthRoute | CodexRouteUnavailable;

/**
 * 单连每 N ms 最多调一次 markContainerActivity —— 防 chatty 用户每帧都冲 DB。
 * 60s 与 idle sweep 默认 30min cutoff 之间留够余量(用户哪怕 60s 才发一帧
 * 也不会被误判 idle)。
 */
const ACTIVITY_REFRESH_INTERVAL_MS = 60_000;

/**
 * 0049 模型授权 refresh 间隔(plan v3 review v1 §F4 follow-up)。
 *
 * 桥接连接 lifetime 内,每 N ms 重新调一次 loadAllowedModelChecker 拉最新
 * grants 快照 + visibility,使 admin 取消授权后**无需用户重连**就能在窗口内
 * 失效。30s 足够低延迟(用户感知近实时),又不至于把 PG 打穿(每用户每分钟
 * 2 次 SELECT;1k 在线 ≈ 33 QPS,远低于 PricingCache 的 LISTEN/NOTIFY 路径)。
 *
 * Refresh 失败 → 保留上一次成功的 checker,不切到"全拒"或"全放"。原因:DB
 * 临时抖动比授权状态变化更频繁,把已经授权的连接因为一次抖动踢掉会更糟。
 */
const GRANTS_REFRESH_INTERVAL_MS = 30_000;

/**
 * plan v3 G6 — codex per-account 槽兜底释放上限(默认 10 分钟)。
 *
 * 为什么需要:bridge 是 byte-transparent 的,不解析 outbound SSE 流,因此无法精确
 * 检测"codex turn 完成"信号(personal-version `event:message_stop` 在容器 ws 帧
 * 内,跨多帧拼接)。退而求其次:每次 acquire 同时启动一个 setTimeout,到点强制
 * release。CODEX_SESSION_MAX_MS = 600s 与个人版 codex app-server 单次 turn 实际上限
 * (~5min stream + buffer)对齐。ws close 也会通过 cleanup 路径释放(更早触发)。
 *
 * env `CODEX_SESSION_MAX_MS` 覆盖(测试常用 1000-5000)。
 */
const DEFAULT_CODEX_SESSION_MAX_MS = 600_000;
function readCodexSessionMaxMs(): number {
  const raw = process.env.CODEX_SESSION_MAX_MS;
  if (!raw) return DEFAULT_CODEX_SESSION_MAX_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_CODEX_SESSION_MAX_MS;
}

/**
 * Agent → 隐含 model 授权映射(plan v3 round-2 finding 1 fix)。
 *
 * 为什么需要:用户提交 inbound.message 时可以**只**带 `agentId` 不带 `model`
 * (v3 webchat 的常见情况:用户切到某 agent,不主动选 model)。这种帧到达时:
 *   - bridge 之前只看 frame.model → 没 model 就 skip authz
 *   - 容器内 gateway 把 frame 路由给 agentId='codex' 那个 agent → CodexAdapter
 *     用 agent.model='gpt-5.5' 启动 → 未授权用户拿到 codex API
 *
 * 因此:bridge 看到 agentId 命中本表 → 用对应 modelId 做 authz 校验。本质是
 * "哪些 agentId 一旦使用,等于在用受限 model"的 explicit allowlist。新增 codex
 * agent 必须在此登记。
 *
 * 与 agents.yaml 的关系:agents.yaml 是 runtime 配置,本表是**安全 contract**;
 * 二者偏离不影响安全(本表多列 = 多拦,少列 = 漏拦但 inferAgentForModel 仍兜底)。
 */
const AGENT_AUTHZ_IMPLIED_MODEL: Record<string, string> = {
  codex: DEFAULT_CODEX_ENGINE_MODEL,
};

// Hidden system agents are callable by trusted in-container delegation only.
// User-facing WebSocket frames must never be allowed to select them directly.
const HIDDEN_REVIEWER_AGENT_ID = "hidden-reviewer";

/**
 * PR2 v1.0.66 — codex 真扣费 preCheck 估算用的 max output tokens。
 *
 * codex inbound 帧不带 max_tokens 字段(由 codex app-server 内部决定),master 估
 * preCheck 上限只能拍脑袋。64K 是 codex app-server 默认 max output tokens
 * 的近似上限(实际 32-64K 视模型)。
 *
 * 2026-05-06:preCheck 已移除 ceiling 拒,balance > 0 即放行,reservation cap 到
 * balance — 这个估算只影响 originalMaxCost / capped metric,不再决定放/拒。
 * 真实扣费由 finalizer 拿真 usage 重算。
 */
const CODEX_PRECHECK_TOKEN_ESTIMATE = 64_000;

/**
 * PR2 v1.0.66 — user WS close 后等 codex billing 帧的 drain 窗口。
 *
 * 为什么需要(Codex BLOCKER 1):用户中途断开 → cleanup 立即关 container WS
 * → 容器侧已发出但还在网络/事件循环里的 outbound.codex_billing 帧丢失 → 漏扣。
 * Drain 期保留 container WS 监听不变,只把 user 侧资源(registry slot、heartbeat)
 * 立即让出,billing 帧在 5s 内到达走 settle 正常落账;超时未到则按 fail 收尾,
 * 由 reconciler 后续兜底(已存 inflight 行)。
 *
 * 5s 取舍:codex turn 终态信号 → master 间通常毫秒级;5s 远高于 P99 网络抖动,
 * 又不至于卡死容器 WS 太久导致下个用户连接挤占 host 资源。
 *
 * M2:改为 env `DRAIN_BILLING_MS` 可覆盖(读时求值;测试用短窗口验证 timeout
 * 路径,生产不设置 → 5s。旧版模块级常量导致 1167 行测试套只能真等 5s)。
 */
const DEFAULT_DRAIN_BILLING_MS = 5_000;
function readDrainBillingMs(): number {
  const raw = process.env.DRAIN_BILLING_MS;
  if (!raw) return DEFAULT_DRAIN_BILLING_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 50 ? n : DEFAULT_DRAIN_BILLING_MS;
}

/**
 * RFC §2.2 B1 — durable dispatch 的 drain 窗口。有在飞 admitted dispatch 时,drain 需给 reconciler/
 * heartbeat 足够时间守住 lease 或等 dispatch 走到终态,故窗口取
 * `max(readDrainBillingMs(), OC_DISPATCH_DRAIN_MS)`,默认 60s、硬上限 120s。
 *
 * 与 codex billing 的 5s 分开:billing 帧毫秒级到达 5s 足够;dispatch lease 续租/接管周期在分钟级
 * (reconciler 30s + jitter),5s 会让本连接的 admitted dispatch 提前离开 drain、lease 被误当孤儿。
 * env 非法/缺省 → 60s;超 120s → clamp 到 120s(防配置把容器 WS 卡死太久挤占 host)。
 */
const DEFAULT_DISPATCH_DRAIN_MS = 60_000;
const MAX_DISPATCH_DRAIN_MS = 120_000;
function readDispatchDrainMs(): number {
  const raw = process.env.OC_DISPATCH_DRAIN_MS;
  let n = DEFAULT_DISPATCH_DRAIN_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 50) n = parsed;
  }
  return Math.min(n, MAX_DISPATCH_DRAIN_MS);
}

/**
 * PR2 v1.0.66 — 32-hex per-turn 标识,master 生成且**强制覆写** client 提供的值。
 *
 * 设计契约:client (浏览器) 不应也无法预测此 id;若 client 把别的 turn 的
 * requestId 塞进 inbound.message 试图错关 inflight 行 → master 直接覆写,
 * 防伪造。容器侧只在 inbound→outbound.codex_billing 透传,不验证。
 */
function ensureRequestIdServerSide(): string {
  return randomBytes(16).toString("hex");
}

/**
 * PR2 v1.0.66 → M2 — bridge 持有的 codex inflight turn 快照。
 *
 * 关键:settle 时**只信本快照**,不信 outbound.codex_billing 帧的 model/agentId
 * 字段(防容器侧伪造改账)。frame 承载 usage 统计 + requestId 关联键 +
 * engineSessionId 记账键。
 *
 * M2 变化:finalizer **延迟到 billing 帧到达时构造** —— usage_records.session_id
 * 的权威值 = 帧上的 engineSessionId(gateway 唯一 helper
 * engineSessionId(sessionKey) 产物)。inbound 时 bridge 不可靠知道 gateway 侧
 * sessionKey(agent 路由可改写)，故不在 inbound 期自行派生。turn 账务归因
 * 不依赖该字段，独立使用 turnKey / parentTurnKey。
 */
interface CodexTurnSnapshot {
  /** server-owned 32-hex id;Map key 与本字段同值,仅冗余便于日志。 */
  requestId: string;
  /** preCheck 时取的 model id(audit / log)。 */
  model: string;
  /** Issue A v1.0.108 — billing 帧的 codex_billing 分支需要根据账号 id 把
   *  rateLimits 落到 claude_accounts.quota_*(maybeUpdateAccountQuotaCodex)。
   *  bigint 0n = legacy / api_relay 无关联账号(quota writer 内部跳过)。 */
  accountId: bigint;
  /** CG2c — turn 的 canonical traceId(master 在 inbound.message 入口生成,
   *  与本 snapshot 的 requestId 同源固定)。outbound.codex_billing settle 路径用它
   *  派生 billingLog + 注入 outbound.cost_charged 广播帧,实现
   *  inbound→outbound→ledger→broadcast 的 trace 贯穿。
   *  **服务端 trust source**:settle 决策永远只信本字段,不解析 outbound 帧的
   *  frame.traceId(防容器侧伪造影响计费观测)。 */
  traceId: string;
  /** Opaque Codex API relay route token for this turn, if the turn used an API relay group. */
  codexRouteToken: string | null;
  /** Exact local admission-state release keyed by this snapshot's requestId.
   * Cross-bridge recovered snapshots omit it and rely on bridge cleanup/timer. */
  releaseBridgeTurnState?: (reason: string) => boolean;
  /** 计费留证；flag 未开的 legacy/shadow turn 为 null。 */
  authority: import("../billing/proxyBilling.js").BillingAuthorityStamp | null;
  authorityTurnId: string | null;
  /**
   * M2 — 首次调用用 billing 帧的 engineSessionId 构造 codexFinalizer 并 memoize
   * (同 handle 复用 → _done 幂等语义与旧"构造期单 finalizer"完全一致)。
   * 已走过 abandon() → 返 null(belt-and-braces:Map.delete 纪律下不可达,
   * 防未来改动引入 abandon 后再 settle 的错账路径)。
   */
  getFinalizer(engineSessionId: string): CodexFinalizeHandle | null;
  /**
   * M2 — 不扣费收尾:billing 帧缺失/engineSessionId 口径非法(fail-closed 免单)
   * 或 cleanup fail-abort(drain 超时 / bridge 断)路径。
   * 语义 = codexFinalizer.fail:abort inflight journal + release preCheck
   * reservation;若 finalizer 已构造则直接委托其 fail(fail-after-commit 由
   * _done 守门 no-op)。幂等。
   */
  abandon(reason: string, failureCode?: JournalFailureCode): Promise<void>;
}

export function codexAbandonFailureCode(reason: string): JournalFailureCode {
  if (reason.startsWith("bridge_disconnect_")) return "CLIENT_ABORT";
  if (
    reason === "rewritten_frame_too_big" ||
    reason === "codex_billing_engine_session_id_invalid"
  ) return "INVALID_REQUEST";
  if (reason === "container_forward_rejected") return "UPSTREAM_UNAVAILABLE";
  if (reason.startsWith("sign_boundary_")) return "INTERNAL_ERROR";
  return "INTERNAL_ERROR";
}

export interface UserChatBridgeHandler {
  /** Gateway HTTP server 的 'upgrade' 事件入口。返 false → 路径不匹配,gateway 路由别处。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** 优雅关停:踢所有连接 + close ws server。 */
  shutdown(reason?: string): Promise<void>;
  /** 测试 / metrics:获取 ConnectionRegistry。 */
  registry: ConnectionRegistry;
  /**
   * 给指定 uid 的所有活跃 user WS 广播一个 JSON 帧(旁路透传管道,非容器来源)。
   *
   * 场景:anthropicProxy 在 finalize.commit 后想把实际扣费金额推给该用户的前端,
   * 但 bridge 本身是 byte-transparent 的 —— 容器侧不知道扣费细节、也不该改帧。
   * 所以新增此旁路入口,直接把 frame 注入到 user WS。
   *
   * 返回实际发送成功的连接数(用户可能没在线 / 没登录,返 0 是合法状态)。
   * 非 JSON-serializable 输入会吞 JSON.stringify 异常,不抛。
   */
  broadcastToUser(uid: bigint, payload: unknown): number;
  /** Master-only control path into this user's live runtime container(s). */
  syncGoalToContainers(uid: bigint, goal: unknown): number;
  /** 给所有在线用户的每个 OPEN user WS 广播 JSON payload。不得用于用户事故通知。 */
  broadcastAll(payload: unknown): number;
  /**
   * 只给 uids 集合中在线用户的 OPEN user WS 发 payload。用户恢复通知仅允许
   * userNoticeApproval 在审批后调用。uid 以字符串给出(uidToUserWs 的 key 口径)。
   */
  broadcastToUsers(uids: string[], payload: unknown): number;
  /** Return only requested users that currently own at least one OPEN user websocket. */
  onlineUserSubset(uids: string[]): string[];
}

// ---------- 内部工具 --------------------------------------------------------

function parseWsUrl(req: IncomingMessage): URL | null {
  const raw = req.url ?? "/";
  try { return new URL(raw, "http://placeholder"); } catch { return null; }
}

function rejectHttp(socket: Duplex, status: number, body: string): void {
  if (socket.destroyed) return;
  const headers = [
    `HTTP/1.1 ${status} ${status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : "Error"}`,
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
  ];
  try { socket.end(headers.join("\r\n") + "\r\n\r\n" + body); }
  catch { try { socket.destroy(); } catch { /* */ } }
}

function uidFromClaims(claims: AccessClaims): bigint {
  if (!/^[1-9][0-9]{0,19}$/.test(claims.sub)) {
    throw new TypeError(`bad uid in claims.sub: ${claims.sub}`);
  }
  return BigInt(claims.sub);
}

function rawDataLen(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((acc, b) => acc + b.length, 0);
  return 0;
}

export function _sanitizeMasterHistoricalMessagesForFrame(
  rawMessages: unknown[],
  opts: { excludeClientMessageId?: string } = {},
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    if (
      opts.excludeClientMessageId &&
      (msg.id === opts.excludeClientMessageId || msg._clientMessageId === opts.excludeClientMessageId)
    ) continue;
    const role = modelHistorySemanticRole(msg);
    if (!role) continue;
    if (msg.system === true) continue;
    const text = modelHistorySemanticText(msg);
    if (!text.trim()) continue;
    const out: Record<string, unknown> = { role, text };
    if (typeof msg.id === "string") out.id = msg.id;
    if (typeof msg.status === "string") out.status = msg.status;
    if (typeof msg.ts === "number") out.ts = msg.ts;
    rows.push(out);
  }
  return rows;
}

type InboundTurnIdentity = { peerId: string | null; clientMessageId: string | null };

function inboundTurnIdentityFromParsed(parsed: unknown): InboundTurnIdentity {
  if (parsed === null || typeof parsed !== "object") {
    return { peerId: null, clientMessageId: null };
  }
  const peerObj = (parsed as { peer?: { id?: unknown } }).peer;
  const peerIdRaw = peerObj && typeof peerObj === "object"
    ? (peerObj as { id?: unknown }).id
    : undefined;
  const peerId = typeof peerIdRaw === "string" && peerIdRaw !== "" ? peerIdRaw : null;
  const clientMessageId = isClientMessageId(
    (parsed as { clientMessageId?: unknown }).clientMessageId,
  )
    ? (parsed as { clientMessageId: string }).clientMessageId
    : null;
  return { peerId, clientMessageId };
}

function sendErrorFrame(
  ws: WebSocket,
  code: string,
  message: string,
  turn?: { peerId?: string | null; clientMessageId?: string | null },
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({
      type: "error",
      code,
      message,
      ...(turn?.peerId ? { peer: { id: turn.peerId, kind: "dm" } } : {}),
      ...(turn?.clientMessageId ? { clientMessageId: turn.clientMessageId } : {}),
    }));
  }
  catch { /* client gone */ }
}

/**
 * 将 4503 close reason 编码为 JSON 字符串(retryAfterSec + reason),前端 parse 即可拿建议。
 * 注意 close reason 字段有 123 字节上限(WebSocket spec),保持紧凑。
 */
function encode4503Reason(retryAfterSec: number, reason: string): string {
  const safeReason = reason.slice(0, 64);
  return JSON.stringify({ retryAfterSec, reason: safeReason });
}

/**
 * 把对端 close code 净化成"可在 wire 上发送"的值。
 *
 * RFC 6455:1005 / 1006 / 1015 是 reserved,**不能** send;ws lib 会 throw
 * "First argument must be a valid error code number"。其它合法范围:
 *   - 1000-1003, 1007-1011, 1012-1014  (但 1004/1016+ 未使用)
 *   - 3000-4999  (registered + private)
 *
 * 简化策略:落在三个 reserved 码 → 改 1000;否则 1000-4999 内放行,其它一律 1000。
 */
function sanitizeCloseCode(code: number): number {
  if (code === 1005 || code === 1006 || code === 1015) return CLOSE_BRIDGE.NORMAL;
  if (code >= 1000 && code <= 4999) return code;
  return CLOSE_BRIDGE.NORMAL;
}

/**
 * Goal 归因加载的**二分语义**(2026-07-17 goal 停摆事故根治;批D D8 单测锁死)。
 *
 *   - loadGoalState 抛 GoalStateError(NOT_FOUND) → client_sessions 行还不存在(WS-only
 *     首轮,尚无 PUT /api/sessions),目标不可能存在 → `{kind:'ok', goalState:null}` **放行**;
 *     归因仍可修复(无行的会话上设不了目标)。
 *   - 抛其它(瞬态 PG 读失败等)→ `{kind:'unavailable'}` **拒轮**:绝不静默降级为 null
 *     ——那会让本轮无 goal_id 落地、后续 durable 修复不可能。调用方据此发
 *     GOAL_STATE_UNAVAILABLE 并回滚已预留的计费/槽位。
 *
 * 抽成纯函数(无副作用:错误帧/日志/回滚仍留调用方)使这条二分成为**单一可测权威**,
 * 而非埋在转发闭包里靠注释维系。
 */
export type TurnGoalResolution =
  | { kind: "ok"; goalState: GoalStateSnapshot | null }
  | { kind: "unavailable"; err: unknown };

export async function resolveTurnGoalState(
  loadGoalState: (uid: bigint, sessionId: string) => Promise<GoalStateSnapshot | null>,
  uid: bigint,
  sessionId: string,
): Promise<TurnGoalResolution> {
  try {
    return { kind: "ok", goalState: await loadGoalState(uid, sessionId) };
  } catch (err) {
    if (err instanceof GoalStateError && err.code === "NOT_FOUND") {
      return { kind: "ok", goalState: null };
    }
    return { kind: "unavailable", err };
  }
}

/** Cursor may execute only in an active container owned by this bridge host. */
export async function isCursorContainerOnSelfHost(
  pgPool: Pool,
  containerId: number,
  uid: bigint,
  selfHostId: string | null | undefined,
): Promise<boolean> {
  const trustedHostId = selfHostId?.trim();
  if (!trustedHostId) return false;
  const eligible = await pgPool.query<{ ok: number }>(
    `SELECT 1 AS ok FROM agent_containers
      WHERE id=$1 AND user_id=$2 AND state='active' AND host_uuid=$3::uuid`,
    [containerId, uid, trustedHostId],
  );
  return eligible.rowCount === 1;
}

type OutboundPersistQueueState = {
  tail: Promise<void>;
  failedSeq: number | null;
};

function isPermanentLiveFrameConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { liveFramePermanentConflict?: unknown }).liveFramePermanentConflict === true
  );
}

/**
 * Serializes durable outbound writes per container/session namespace.
 *
 * A failure remains a monotonic barrier while at least one browser bridge is
 * attached to that namespace. Once the final browser bridge detaches, the
 * failed state is retired after its current tail drains, so a later reconnect
 * is not permanently poisoned by a failure from an earlier connection.
 */
export class _OutboundPersistQueueCoordinator {
  private readonly queues = new Map<string, OutboundPersistQueueState>();
  private readonly consumerCounts = new Map<string, number>();

  retain(key: string): void {
    this.consumerCounts.set(key, (this.consumerCounts.get(key) ?? 0) + 1);
  }

  release(key: string): void {
    const count = this.consumerCounts.get(key) ?? 0;
    if (count > 1) {
      this.consumerCounts.set(key, count - 1);
      return;
    }
    this.consumerCounts.delete(key);
    const state = this.queues.get(key);
    if (state !== undefined) this.scheduleCleanup(key, state, state.tail);
  }

  enqueue(
    key: string,
    frameSeq: number,
    work: () => Promise<void>,
    onFailure: (error: unknown) => void,
    onPermanentConflict?: (error: unknown) => void,
  ): void {
    let state = this.queues.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), failedSeq: null };
      this.queues.set(key, state);
    }
    const task = state.tail.then(async () => {
      // A reconnect may replay the exact failed sequence from the container's
      // own ring. That exact retry is allowed to heal the namespace; a later
      // sequence must never overtake it while a browser generation is alive.
      if (state!.failedSeq !== null && state!.failedSeq !== frameSeq) {
        onFailure(new Error(`outbound durability blocked at frame ${state!.failedSeq}`));
        return;
      }
      try {
        await work();
        if (state!.failedSeq === frameSeq) state!.failedSeq = null;
      } catch (error) {
        if (isPermanentLiveFrameConflict(error)) {
          // An exact retry can turn a prior transient failure into a proven
          // permanent conflict. Retire only that same-sequence barrier; a
          // barrier for any other missing sequence must remain strict.
          if (state!.failedSeq === frameSeq) state!.failedSeq = null;
          onPermanentConflict?.(error);
          return;
        }
        state!.failedSeq = frameSeq;
        onFailure(error);
      }
    });
    state.tail = task;
    this.scheduleCleanup(key, state, task);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((state) => state.tail));
  }

  snapshotForTest(): { queues: number; consumerKeys: number; consumers: number } {
    return {
      queues: this.queues.size,
      consumerKeys: this.consumerCounts.size,
      consumers: [...this.consumerCounts.values()].reduce((sum, count) => sum + count, 0),
    };
  }

  private scheduleCleanup(
    key: string,
    state: OutboundPersistQueueState,
    tail: Promise<void>,
  ): void {
    const cleanup = (): void => {
      if (
        this.queues.get(key) === state &&
        state.tail === tail &&
        (state.failedSeq === null || !this.consumerCounts.has(key))
      ) {
        this.queues.delete(key);
      }
    };
    void tail.then(cleanup, cleanup);
  }
}

// ---------- 主入口 ----------------------------------------------------------

export function createUserChatBridge(deps: UserChatBridgeDeps): UserChatBridgeHandler {
  // PR2 v1.0.66 — codex 真扣费三件套一致性强校验(Codex BLOCKER 3 修复)。
  // partial 注入(漏一个)在生产里会让 codex 帧 acquire 但不 settle,等于
  // 静默免费送 token。boot-time fail-closed 防漏注。
  // 测试 mock 三个全 undefined 也合法(纯透传 / 不做计费)。
  const codexBillingDepsCount =
    [deps.pgPool, deps.preCheckRedis, deps.pricing].filter((x) => x !== undefined).length;
  if (codexBillingDepsCount !== 0 && codexBillingDepsCount !== 3) {
    throw new TypeError(
      "createUserChatBridge: pgPool/preCheckRedis/pricing must be all set or all unset " +
      "(partial wiring suggests deployment misconfig that would silently disable codex billing)",
    );
  }
  if (deps.codexBinding !== undefined && codexBillingDepsCount === 0) {
    throw new TypeError(
      "createUserChatBridge: codexBinding requires pgPool+preCheckRedis+pricing " +
      "(otherwise codex turns acquire slots but never settle billing — silent free codex)",
    );
  }
  const codexBillingEnabled = codexBillingDepsCount === 3;

  const maxPerUser = deps.maxPerUser ?? DEFAULT_MAX_PER_USER;
  const maxFrameBytes = deps.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxBufferedBytes = deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const connectTimeoutMs = deps.containerConnectTimeoutMs ?? DEFAULT_CONTAINER_CONNECT_TIMEOUT_MS;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const promptQueuePreparationTimeoutMs =
    Number.isSafeInteger(deps.promptQueuePreparationTimeoutMs) &&
      (deps.promptQueuePreparationTimeoutMs ?? 0) > 0
      ? deps.promptQueuePreparationTimeoutMs!
      : DEFAULT_PROMPT_QUEUE_PREPARATION_TIMEOUT_MS;
  const log = deps.logger;
  const metrics = deps.metrics ?? {};
  const createContainerSocket = deps.createContainerSocket
    ?? ((host, port, _signal) =>
        new WebSocket(`ws://${host}:${port}/ws`, { perMessageDeflate: false, maxPayload: maxFrameBytes }));

  const registry = new ConnectionRegistry({ maxPerUser });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });
  const pendingPromptQueueCompensations = new Set<Promise<void>>();
  const trackPromptQueueCompensation = (work: Promise<void>): void => {
    pendingPromptQueueCompensations.add(work);
    void work.catch((err) => {
      log?.error("user-chat-bridge: prompt queue compensation failed", { err });
    }).finally(() => pendingPromptQueueCompensations.delete(work));
  };
  const pendingZcodeAuditWork = new Set<Promise<void>>();
  const trackZcodeAuditWork = (work: Promise<void>): void => {
    pendingZcodeAuditWork.add(work);
    void work.catch((err) => {
      log?.warn("user-chat-bridge: ZCode audit work failed", { err });
    }).finally(() => pendingZcodeAuditWork.delete(work));
  };
  let zcodeStaleReconcileStarted = false;
  const ensureZcodeStaleReconcile = (): void => {
    if (zcodeStaleReconcileStarted || !deps.pgPool) return;
    zcodeStaleReconcileStarted = true;
    trackZcodeAuditWork(
      reconcileStaleZcodeAudits(deps.pgPool).then(() => undefined),
    );
  };

  /**
   * Phase 0.4 — bridge-layer outbound ring buffer (process-singleton).
   *
   * Personal-master ports its `outboundRing` here so that v3-commercial bridges
   * can serve `inbound.hello.lastFrameSeq` replays close to the client without
   * relying on the embedded container's ring (which sees a different WS socket
   * after every reconnect and has no privileged view of cross-tab state).
   *
   * Storage key:    `${uid}:${containerId}:${sessionKey}`
   *   - `uid` isolates tenants (multiple users share one bridge process)
   *   - `containerId` namespaces a container's lifetime — a fresh container
   *     gets a fresh slot, so seq=1 from a restarted container never collides
   *     with the previous container's seq=1 (no in-band reset signal needed)
   *   - `sessionKey` is the wire-stamped key the personal-master gateway
   *     embedded into the outbound frame (verbatim, NOT recomputed)
   *
   * Container ring still receives hello and may also serve replay; client-side
   * frameSeq dedupe (websocket.js handleOutbound) absorbs any duplicate frames.
   */
  const outboundRing = new OutboundRingBuffer(DEFAULT_RING_CONFIG);
  // Process-singleton namespace queues preserve commit→send order even when
  // the same container broadcasts duplicate frames through multiple browser
  // bridges. A failed namespace blocks later sequence numbers while any
  // browser generation remains attached; final detach retires the poison so a
  // future reconnect is not permanently trapped by an earlier DB failure.
  const outboundPersistQueues = new _OutboundPersistQueueCoordinator();

  /**
   * 周期性 lazy prune 兜底。
   *
   * OutboundRingBuffer 的 store / peekReplay 只在被 touch 的 key 上做 prune;
   * 当 containerId 变了之后,旧 `${uid}:${oldCid}:${sessionKey}` 的 key 不再
   * 被任何路径访问,frames 残留 + rings Map entry 不释放,会随容器生命周期累积。
   *
   * 60s 跑一次 pruneAll(now): 对所有 ring 应用 TTL/cap 驱逐,空 ring 从 Map 删除。
   * lastSeq Map 不动 —— 删了会破坏"上次有过 frameSeq>0 但都过期了"的语义,
   * 让冷 tab/state-reset 后 hello cursor=0 + currentLast>0 的 client 拿到
   * ok+[](静默不丢)而不是 resume_failed(no_buffer)→ REST 强同步。
   * lastSeq entry 不带 frame data,单 entry 内存代价 <100B,慢漏可接受。
   */
  const ringPruneTimer: NodeJS.Timeout = setInterval(
    () => { outboundRing.pruneAll(Date.now()); },
    60_000,
  );
  ringPruneTimer.unref?.();

  /**
   * uid(string) → 该用户当前持有的所有正在正常桥接中的 user WS 集合。
   *
   * 为什么单独维护一份而不用 ConnectionRegistry:
   *   - ConnectionRegistry 只存 { id, user_id, opened_at, close } — 没有 ws 句柄引用,
   *     因为原设计保持"关连接靠回调"的抽象,不把 ws lib 泄漏到那层
   *   - broadcastToUser 需要直接 ws.send —— 把 ws 加到 Conn 里会把 registry 接口污染,
   *     所以这里单开一张表。两张表的增删时机严格一致(startBridge 开头加、cleanup 里删),
   *     保持不变量"uidToUserWs[uid] 含的 ws 与 registry[uid] 含的 Conn 一一对应"。
   *
   * 注意:只有**早到帧处理完 + 桥真正开起来**的 ws 才进这张表 —— JWT 失败 / ContainerUnready
   * 期间的 ws 不在这里,因为没有跑到 startBridge 里 registry.register。
   */
  const uidToUserWs = new Map<string, Set<WebSocket>>();
  /**
   * uid+session → 当前已 hello 订阅该会话的 OPEN user WS。
   * forwardCommittedFrame 按此扇出,而不是绑在受理时捕获的那一根 userWs 上。
   * key = `${uid}\0${sessionId}`:同一 uid 的其它会话、其它 uid 都进不了这个集合。
   */
  const sessionToUserWs = new Map<string, Set<WebSocket>>();
  const userWsToSessionKeys = new Map<WebSocket, Set<string>>();

  const sessionFanoutKey = (userId: string, sessionId: string): string =>
    `${userId}\0${sessionId}`;

  const registerUserWsSession = (ws: WebSocket, userId: string, sessionId: string): void => {
    if (sessionId.length < 1 || sessionId.length > 512) return;
    const key = sessionFanoutKey(userId, sessionId);
    let subscribers = sessionToUserWs.get(key);
    if (!subscribers) {
      subscribers = new Set();
      sessionToUserWs.set(key, subscribers);
    }
    subscribers.add(ws);
    let owned = userWsToSessionKeys.get(ws);
    if (!owned) {
      owned = new Set();
      userWsToSessionKeys.set(ws, owned);
    }
    owned.add(key);
  };

  const unregisterUserWsSessions = (ws: WebSocket): void => {
    const owned = userWsToSessionKeys.get(ws);
    if (!owned) return;
    userWsToSessionKeys.delete(ws);
    for (const key of owned) {
      const subscribers = sessionToUserWs.get(key);
      if (!subscribers) continue;
      subscribers.delete(ws);
      if (subscribers.size === 0) sessionToUserWs.delete(key);
    }
  };

  const openUserWsForSession = (userId: string, sessionId: string | null): WebSocket[] => {
    if (sessionId === null || sessionId.length < 1) return [];
    const subscribers = sessionToUserWs.get(sessionFanoutKey(userId, sessionId));
    if (!subscribers || subscribers.size === 0) return [];
    const open: WebSocket[] = [];
    for (const candidate of subscribers) {
      if (candidate.readyState === WebSocket.OPEN) open.push(candidate);
    }
    return open;
  };
  const uidToContainerWs = new Map<string, Set<WebSocket>>();
  const uidToRecoveryExecutors = new Map<
    string,
    Set<(job: ClaimedRecoveryJob) => void>
  >();
  const controlDrainRunning = new Set<string>();
  const recoveryDrainRunning = new Set<string>();
  const recoveryLastScanAt = new Map<string, number>();
  const controlLeaseOwner = `master:${randomUUID()}`;
  const recoveryLeaseOwner = `master-recovery:${randomUUID()}`;
  const controlLeaseMs = 15_000;
  const recoveryLeaseMs = 120_000;

  /** Master-owned control outbox drainer. The physical bridge is only a
   * transport candidate: PostgreSQL claim/lease is the delivery authority,
   * so browser disconnects and Master restarts cannot erase Stop/permission. */
  const drainDurableControlsForUser = async (uid: bigint): Promise<void> => {
    if (!deps.pgPool) return;
    const key = uid.toString();
    if (controlDrainRunning.has(key)) return;
    const sockets = uidToContainerWs.get(key);
    const socket = sockets && [...sockets].find((candidate) => candidate.readyState === WebSocket.OPEN);
    if (!socket) return;
    controlDrainRunning.add(key);
    try {
      const controls = await claimDueTurnControls(deps.pgPool, {
        userId: uid,
        ownerId: controlLeaseOwner,
        leaseMs: controlLeaseMs,
      });
      for (const control of controls) {
        const live = [...(uidToContainerWs.get(key) ?? [])]
          .find((candidate) => candidate.readyState === WebSocket.OPEN);
        if (!live) {
          await releaseTurnControlForRetry(deps.pgPool, control);
          continue;
        }
        const encoded = JSON.stringify({ ...control.payload, controlId: control.controlId });
        try {
          live.send(encoded, { binary: false }, (error) => {
            if (!error) return;
            void releaseTurnControlForRetry(deps.pgPool!, control).catch(() => {});
          });
        } catch {
          await releaseTurnControlForRetry(deps.pgPool, control);
        }
      }
    } catch (error) {
      log?.warn("user-chat-bridge: durable control drain failed", { uid: key, error });
    }
    controlDrainRunning.delete(key);
  };
  const controlDrainTimer = setInterval(() => {
    for (const uid of uidToContainerWs.keys()) {
      void drainDurableControlsForUser(BigInt(uid));
    }
  }, 1_000);
  controlDrainTimer.unref?.();

  /** Master-owned semantic recovery scheduler. Executors are registered only
   * by attested durable-dispatch bridges; every claimed request then enters
   * the same executeAdmittedTurn pipeline as an ordinary browser message. */
  const drainDurableRecoveryForUser = async (uid: bigint): Promise<void> => {
    if (!deps.pgPool) return;
    const key = uid.toString();
    if (recoveryDrainRunning.has(key)) return;
    const executors = uidToRecoveryExecutors.get(key);
    const executor = executors && [...executors][0];
    if (!executor) return;
    recoveryDrainRunning.add(key);
    try {
      const lastScanAt = recoveryLastScanAt.get(key) ?? 0;
      if (deps.reconcileAutomaticRecoveryJobs && Date.now() - lastScanAt >= 30_000) {
        recoveryLastScanAt.set(key, Date.now());
        await deps.reconcileAutomaticRecoveryJobs(uid, 100);
      }
      const jobs = await claimDueRecoveryJobs(deps.pgPool, {
        userId: uid,
        ownerId: recoveryLeaseOwner,
        leaseMs: recoveryLeaseMs,
      });
      for (const job of jobs) {
        const liveExecutor = [...(uidToRecoveryExecutors.get(key) ?? [])][0];
        if (!liveExecutor) {
          await releaseRecoveryForTransportWait(deps.pgPool, job);
          continue;
        }
        try {
          liveExecutor(job);
        } catch {
          await releaseRecoveryForTransportWait(deps.pgPool, job);
        }
      }
    } catch (error) {
      log?.warn("user-chat-bridge: durable recovery drain failed", { uid: key, error });
    }
    recoveryDrainRunning.delete(key);
  };
  const recoveryDrainTimer = setInterval(() => {
    for (const uid of uidToRecoveryExecutors.keys()) {
      void drainDurableRecoveryForUser(BigInt(uid));
    }
  }, 1_000);
  recoveryDrainTimer.unref?.();

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = parseWsUrl(req);
    if (!url) {
      rejectHttp(
        socket, 400,
        JSON.stringify({ error: { code: "BAD_URL", message: "cannot parse URL" } }),
      );
      return true;
    }
    if (url.pathname !== BRIDGE_WS_PATH) return false;

    // 同 agent.ts:先 upgrade,认证错也走 ws frame 报告,前端体验比 HTTP 401 直接关好。
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 版本握手:accept 即发当前前端构建 id(auth 之前——build id 本就公开,任何人
      // GET / 都能看到 meta;放在 auth 前保证"拿着过期 token 的旧前端"也能收到并自救,
      // 401 重试环里的旧客户端正是最需要刷新的那批)。失败/未注入 → 静默跳过,
      // 版本握手是 best-effort 自愈通道,绝不影响桥主链路。
      try {
        const feBuild = deps.getFrontendBuildId?.();
        if (feBuild) ws.send(JSON.stringify({ type: "sys.frontend_build", build: feBuild }));
      } catch { /* best-effort */ }
      // 早到帧暂存(auth + ensureRunning 是 async)
      // receivedAtMs 用于 bridge TTFT 起点 — 早到帧也算"用户已发首条消息"。
      const pendingMessages: Array<{ data: RawData; isBinary: boolean; receivedAtMs: number }> = [];
      let earlyClose: { code: number; reason: Buffer } | null = null;
      const onEarlyMessage = (data: RawData, isBinary: boolean): void => {
        pendingMessages.push({ data, isBinary, receivedAtMs: Date.now() });
      };
      const onEarlyClose = (code: number, reason: Buffer): void => {
        earlyClose = { code, reason };
      };
      ws.on("message", onEarlyMessage);
      ws.on("close", onEarlyClose);

      // S12e CG4:connection-scoped trace id 在 handleUpgrade 早期生成。
      // 历史上这行 `randomUUID()` 在 startBridge 顶上(L1008),但 tunnel factory
      // 调用(L896-900,在 startBridge 之前)也需要这个值塞进 X-Connection-Trace-Id
      // 头。把生成挪到 IIFE 起点,保证 tunnel pre-dial / bridge log / 后续 child
      // (turnLog 等)共享同一 UUID;startBridge 内 connId 参数直接收。
      const connId = randomUUID();

      void (async () => {
        // 1) JWT 验证 — token 来源只接受:
        //    Sec-WebSocket-Protocol "bearer, <token>" > Authorization Bearer
        //    前端 `new WebSocket(url, ['bearer', token])` 会发 Sec-WebSocket-Protocol
        //
        // 2026-04-21 安全审计 HIGH#2 修复:此前曾支持 `?token=<jwt>` URL query
        // fallback,但 query string 会落 Caddy / gateway access log + 浏览器
        // 历史 / referrer header,导致 access JWT 泄漏。前端已全部走
        // ['bearer', token] 子协议路径,纯 server-only 的 fallback 直接删除。
        let token = "";
        const protoHeader = req.headers["sec-websocket-protocol"];
        if (typeof protoHeader === "string") {
          const protos = protoHeader.split(",").map((s) => s.trim());
          if (protos.includes("bearer") && protos.length >= 2) {
            token = protos[protos.length - 1] ?? "";
          }
        }
        if (!token) {
          const authHeader = req.headers.authorization;
          if (typeof authHeader === "string") {
            token = authHeader.replace(/^Bearer\s+/i, "").trim();
          }
        }
        if (!token) {
          sendErrorFrame(ws, "UNAUTHORIZED", "missing token (bearer protocol or Authorization header)");
          try { ws.close(CLOSE_BRIDGE.POLICY, "unauthorized"); } catch { /* */ }
          return;
        }
        let claims: AccessClaims;
        try {
          claims = await verifyAccess(token, deps.jwtSecret);
        } catch (err) {
          if (err instanceof JwtError) {
            sendErrorFrame(ws, "UNAUTHORIZED", "invalid or expired token");
          } else {
            sendErrorFrame(ws, "ERR_INTERNAL", "auth failure");
            log?.error("user-chat-bridge: verifyAccess threw", { err });
          }
          try { ws.close(CLOSE_BRIDGE.POLICY, "unauthorized"); } catch { /* */ }
          return;
        }
        let uid: bigint;
        try { uid = uidFromClaims(claims); }
        catch (err) {
          log?.error("user-chat-bridge: bad sub claim", { err });
          sendErrorFrame(ws, "UNAUTHORIZED", "bad uid in token");
          try { ws.close(CLOSE_BRIDGE.POLICY, "unauthorized"); } catch { /* */ }
          return;
        }

        // 1.35) 封号即时生效:WS 建连时复核 users.status(每连接一次,非每 turn,低成本)。
        //   封号后持有效 access token(≤15min)仍能建新桥聊天/扣费是历史缺口;admin patchUser
        //   封号已同步撤 refresh(≤15min 后自愈),此处再堵住"建连"这条最直接的花钱入口。
        //   deps.pgPool 未注入(测试/个人版)→ 跳过(行为与本检查加入前一致)。
        //   status 查询失败(DB 抖动)→ fail-open 放行 + 告警:封号非实时安全闸(refresh 撤销
        //   已是主机制),不为一次 DB 故障把全体用户锁在门外(可用性优先,与 model-authz 的
        //   fail-closed 取舍不同——那是防 hidden model 数据/成本泄漏,权重更高)。
        if (deps.pgPool) {
          try {
            const st = await deps.pgPool.query<{ status: string }>(
              "SELECT status FROM users WHERE id = $1",
              [uid.toString()],
            );
            const status = st.rows[0]?.status;
            if (status !== undefined && status !== "active") {
              log?.info("user-chat-bridge: rejected non-active user", { uid: uid.toString(), status });
              sendErrorFrame(ws, "FORBIDDEN", "account is not active");
              try { ws.close(CLOSE_BRIDGE.POLICY, "account inactive"); } catch { /* */ }
              return;
            }
          } catch (err) {
            log?.warn("user-chat-bridge: user status check failed (fail-open)", {
              uid: uid.toString(), err: (err as Error).message,
            });
          }
        }

        // 1.4) 0049 模型授权 checker —— 在 ensureRunning 之前拉一次 grants。
        //   - load 失败 throw → close(1011)。grants DB 故障期间不做"放行"假设,
        //     不然付费用户能在故障窗口里调到任何 hidden model。
        //   - 测试 / 个人版上下文未注入 deps.loadAllowedModelChecker → handle=null,
        //     桥行为与本字段加入前完全一致(无校验,纯透传)。
        //   - 桥每 GRANTS_REFRESH_INTERVAL_MS ms 重新加载一次,使 admin 取消授权能
        //     在窗口内对**已开 ws 连接**生效(plan v3 review v1 §F4 follow-up)。
        //     refresh 失败保留上次 checker(**放宽面**的可用性取舍)。
        //   - **epoch 联动(0144 / 代码审 R1 BLOCKER-1)**:周期刷新 + keep-LKG 对
        //     「撤权」是不够的 —— 见 ModelCheckerHandle 头注。
        let modelCheckerHandle: ModelCheckerHandle | null = null;
        if (deps.loadAllowedModelChecker) {
          const loader = deps.loadAllowedModelChecker;

          // grants 快照的 epoch 戳 = **读 grants 之前**观察到的 DB epoch 的保守下界。
          //   · catalog 快照 epoch ≤ DB epoch(单调、只会落后)→ 用它盖戳只会盖低,不会盖高;
          //   · 盖低 = 多做一次重载(安全方向);盖高 = 撤权被永久漏掉(BLOCKER-1 的形态)。
          // 所以取戳**必须发生在 loader() 之前**,绝不能读完 grants 再补一个"当前 epoch"。
          const observeEpoch = (): bigint =>
            deps.modelAuthority?.catalog.peek()?.securityEpoch ?? 0n;

          let inner: (modelId: string) => boolean = () => false; // 载入成功前一律不放行
          let checkerEpoch = 0n;
          const applyLoad = (stamp: bigint, next: (modelId: string) => boolean): void => {
            // 迟到的旧班车(stamp 更小)不得把新快照换回旧的。
            if (stamp < checkerEpoch) return;
            inner = next;
            checkerEpoch = stamp;
          };
          let loadInflight: { minEpoch: bigint; p: Promise<void> } | null = null;
          const startLoad = (minEpoch: bigint): Promise<void> => {
            const entry: { minEpoch: bigint; p: Promise<void> } = { minEpoch, p: Promise.resolve() };
            entry.p = (async () => {
              const next = await loader(uid, minEpoch === 0n ? undefined : minEpoch);
              applyLoad(minEpoch, next);
            })().finally(() => {
              if (loadInflight === entry) loadInflight = null;
            });
            loadInflight = entry;
            return entry.p;
          };

          try {
            await startLoad(observeEpoch());
          } catch (err) {
            log?.error("user-chat-bridge: loadAllowedModelChecker threw", {
              uid: uid.toString(),
              err,
            });
            sendErrorFrame(ws, "ERR_INTERNAL", "authorization unavailable");
            try { ws.close(CLOSE_BRIDGE.INTERNAL, "authorization unavailable"); } catch { /* */ }
            return;
          }

          modelCheckerHandle = {
            isAllowed: (modelId) => inner(modelId),
            epoch: () => checkerEpoch,
            refresh: async () => {
              try {
                await startLoad(observeEpoch());
              } catch (err) {
                // 不切 inner —— 保留上次成功 checker。详见 GRANTS_REFRESH_INTERVAL_MS 注释。
                // (这是**放宽面**的兜底:新授权晚 30s 生效可以忍;**收窄面**由
                //  reloadAtLeast 的 fail-closed 路径接管,不共用这条 keep-LKG。)
                log?.warn("user-chat-bridge: modelChecker refresh failed (keep last good)", {
                  uid: uid.toString(),
                  err,
                });
              }
            },
            reloadAtLeast: async (want) => {
              if (checkerEpoch >= want) return;
              // 只搭「启动时刻已观察到 epoch ≥ want」的车 —— 更早启动的那班可能读的是
              // 撤权之前的 grants,搭上去等于把撤权漏掉。否则自己开一班(grants 是一条
              // 轻 SELECT,多几班的代价远低于把安全结论押在别人的时序上)。
              const cur = loadInflight;
              await (cur !== null && cur.minEpoch >= want ? cur.p : startLoad(want));
              if (checkerEpoch < want) {
                throw new Error(
                  `grants snapshot did not reach epoch ${want} (at ${checkerEpoch})`,
                );
              }
            },
          };
        }

        // 1.5) V3 Phase 4H+ maintenance 闸门:非 admin 在维护模式下不得建立新 chat 会话。
        //   - admin 判定只看 claims.role —— WS chat 不是"动账/改配置"的破坏性操作,
        //     按 HTTP 中间件那种 DB double-check 会让每次 handshake 多一次 PG roundtrip。
        //   - admin 降权立即生效由 HTTP 层(requireAdminVerifyDb)承担;WS 最坏场景是
        //     JWT 未过期的原 admin 仍能在维护期开聊,JWT 24h 内自然淘汰,可接受。
        //   - 维护时**不**force close 已在飞的连接:只拦新建。
        if (claims.role !== "admin" && (await isInMaintenance())) {
          log?.info("user-chat-bridge: maintenance block", { uid: uid.toString() });
          sendErrorFrame(ws, "MAINTENANCE", "服务正在维护中,请稍后再试");
          try {
            ws.close(
              CLOSE_BRIDGE.MAINTENANCE,
              JSON.stringify({ retryAfterSec: 60, reason: "maintenance" }),
            );
          } catch { /* */ }
          return;
        }

        // 2) 解析容器端点(ensureRunning)
        let endpoint: Awaited<ReturnType<ResolveContainerEndpoint>>;
        try {
          endpoint = await deps.resolveContainerEndpoint(uid);
        } catch (err) {
          if (err instanceof ContainerUnreadyError) {
            log?.info("user-chat-bridge: container not ready", {
              uid: uid.toString(), reason: err.reason, retryAfterSec: err.retryAfterSec,
            });
            try {
              ws.close(
                CLOSE_BRIDGE.CONTAINER_UNREADY,
                encode4503Reason(err.retryAfterSec, err.reason),
              );
            } catch { /* */ }
            return;
          }
          log?.error("user-chat-bridge: resolveContainerEndpoint threw", {
            uid: uid.toString(), err,
          });
          sendErrorFrame(ws, "ERR_INTERNAL", "agent unavailable");
          try { ws.close(CLOSE_BRIDGE.INTERNAL, "agent unavailable"); } catch { /* */ }
          return;
        }

        // 2b) P0 计费旁路封堵 —— agent→model 权威快照(bridge 可信模型推导)。
        //
        //   **顺序是硬约束(模型权威批次 §5 阶段 B / 设计审 R2-B3)**:本块必须排在
        //   `resolveContainerEndpoint`(= ensureRunning)**之后** —— seed agent
        //   (main/codex/hidden-reviewer)的执行三元组权威是「该容器实际跑的那个 bundle rev 的
        //   platform-seed 声明」,而 rev 只有 ensureRunning 返回容器 label(endpoint.bundleRev)
        //   之后才知道。若在之前 load,master 只能用自己的 current 常量/声明 → 滚动窗口里
        //   「master 按新声明计费、旧容器按旧 seed 执行」的**计费分叉**原样复活。
        //
        //   语义/生命周期与 modelCheckerHandle 同构:load 失败 close(1011) 不静默放行
        //   (flag 开启时 SeedDeclarationError 走同一条 catch —— 绝不回落 master 常量);
        //   refresh 失败保留上次快照。未注入 → null(测试 / 旧装配,桥不做推导,行为不变)。
        //
        //   **refresh 复用同一 endpoint.bundleRev**:容器在本连接存续期内不会换 rev
        //   (被 recycle → 桥断)。新容器 = 新连接 = 重新取 label,不存在"连接中途换 rev"。
        const connectionBundleRev = endpoint.bundleRev;
        let agentModelResolverHandle:
          | {
              resolve: (agentId: string) => string | null;
              isRuntimeDenied: (agentId: string) => boolean;
              refresh: () => Promise<void>;
            }
          | null = null;
        if (deps.loadAgentModelResolver) {
          const loadResolver = deps.loadAgentModelResolver;
          const resolverOpts: { bundleRev?: string } = connectionBundleRev !== undefined
            ? { bundleRev: connectionBundleRev }
            : {};
          let innerResolve: AgentModelResolver;
          try {
            innerResolve = await loadResolver(uid, resolverOpts);
          } catch (err) {
            // 含阶段 B 的 SeedDeclarationError(rev 缺失 / bundle 被篡改 / schema 不认):
            // fail-closed 拒连接,不放行到容器(放行 = 按未知声明计费)。
            log?.error("user-chat-bridge: loadAgentModelResolver threw", {
              uid: uid.toString(),
              bundleRev: connectionBundleRev ?? null,
              err,
            });
            sendErrorFrame(ws, "ERR_INTERNAL", "authorization unavailable");
            try { ws.close(CLOSE_BRIDGE.INTERNAL, "authorization unavailable"); } catch { /* */ }
            return;
          }
          // refresh 去重:miss 补触发 + 周期 timer 可能并发,同一时刻只放一个在飞
          // (DB 查询很轻,但没必要放大;后到的直接搭前一班车)。
          // 注意:此处刻意不写 `finally { }` 块 —— userChatBridge.test.ts 的
          // tryAutoRebindFlush 源码 tripwire 以「文件内第一个 `finally {`」定位
          // 目标块,在它之前新增 finally 块会让 tripwire 锚错。.finally() 等价。
          let refreshInflight: Promise<void> | null = null;
          agentModelResolverHandle = {
            resolve: (agentId) => innerResolve(agentId),
            isRuntimeDenied: (agentId) => innerResolve.isRuntimeDenied?.(agentId) === true,
            refresh: async () => {
              if (refreshInflight !== null) return refreshInflight;
              refreshInflight = (async () => {
                try {
                  // 同一 bundleRev:连接存续期内容器不变 ⇒ seed 声明不变(LRU 命中,零 IO)。
                  const next = await loadResolver(uid, resolverOpts);
                  innerResolve = next;
                } catch (err) {
                  // 保留上次成功快照(与 modelChecker.refresh 同语义)。
                  log?.warn("user-chat-bridge: agentModelResolver refresh failed (keep last good)", {
                    uid: uid.toString(),
                    err,
                  });
                }
              })().finally(() => {
                refreshInflight = null;
              });
              return refreshInflight;
            },
          };
        }

        // 3) 构造容器 WS — direct(sync)或 tunnel(async pre-dial mTLS+pin)。
        //    早到帧 handler 故意保留挂着,等真正进 startBridge 才解绑;async 拨号期间
        //    用户继续发的帧会进 pendingMessages,startBridge 内 replay。
        const connectAbort = new AbortController();
        let containerWs: WebSocket;
        try {
          if (endpoint.tunnel) {
            if (!deps.createTunnelContainerSocket) {
              // 部署级配置漏注 — 给 4503 让前端别死循环重连(会上报 alert 由 ensureRunning 路径)
              log?.error("user-chat-bridge: tunnel endpoint but factory not injected", {
                uid: uid.toString(),
                hostId: endpoint.tunnel.hostId,
                containerInternalId: endpoint.tunnel.containerInternalId,
              });
              sendErrorFrame(ws, "ERR_INTERNAL", "tunnel not configured");
              try { ws.close(CLOSE_BRIDGE.INTERNAL, "tunnel not configured"); } catch { /* */ }
              return;
            }
            containerWs = await deps.createTunnelContainerSocket(
              endpoint.tunnel,
              endpoint.port,
              connectAbort.signal,
              // S12e CG4:connection-level trace 透传,headers 写 X-Connection-Trace-Id
              connId,
            );
          } else {
            containerWs = createContainerSocket(endpoint.host, endpoint.port, connectAbort.signal);
          }
        } catch (err) {
          log?.error("user-chat-bridge: container socket factory failed", {
            uid: uid.toString(),
            tunnel: !!endpoint.tunnel,
            hostId: endpoint.tunnel?.hostId,
            err,
          });
          sendErrorFrame(ws, "ERR_CONTAINER", "cannot connect");
          try { ws.close(CLOSE_BRIDGE.INTERNAL, "agent unavailable"); } catch { /* */ }
          return;
        }

        // EARLY 'error' handler:ws 在 CONNECTING 阶段被 .terminate()(line ~831
        // earlyClose 路径)时,内部会在 socket 'connect' 异步回调里 throw
        // "WebSocket was closed before the connection was established" 等。
        // startBridge 内部的正式 'error' handler 此时还没挂,无人接 → 升 fatal
        // uncaughtException。挂这个 named handler 兜底;移交 startBridge 时 .off
        // 掉避免双日志,但 earlyClose return 路径保留它直到 ws 自然清理。
        const onEarlyContainerWsError = (err: Error): void => {
          log?.warn("user-chat-bridge: container ws error during connect", {
            uid: uid.toString(),
            tunnel: !!endpoint.tunnel,
            host: endpoint.host,
            port: endpoint.port,
            err: String((err as { message?: string })?.message ?? err),
          });
        };
        containerWs.on("error", onEarlyContainerWsError);

        // 4) 把"早到帧"解绑 + 检查客户端是否已撤,再交给 startBridge
        ws.off("message", onEarlyMessage);
        ws.off("close", onEarlyClose);
        if (earlyClose !== null) {
          // 客户端在 await 期间(ensureRunning 或 tunnel pre-dial)已经撤了
          log?.info("user-chat-bridge: client closed during ensure", {
            uid: uid.toString(),
          });
          // 故意不 .off(onEarlyContainerWsError):terminate() 触发的 async error
          // 仍需被这个 handler 接住。listener 会随 ws 关闭被 GC 清理。
          try { containerWs.terminate(); } catch { /* */ }
          try { connectAbort.abort(); } catch { /* */ }
          return;
        }

        // 移交 startBridge:它会在 line ~1807 挂自己的 'error' handler 接管
        // 容器 ws 生命周期。先解绑 early handler 避免双日志。
        containerWs.off("error", onEarlyContainerWsError);

        startBridge(
          ws,
          uid,
          endpoint,
          pendingMessages,
          endpoint.containerId,
          containerWs,
          connectAbort,
          modelCheckerHandle,
          agentModelResolverHandle,
          connId,
          claims.role === "admin" ? "admin" : "user",
        );
      })().catch((err: unknown) => {
        log?.error("user-chat-bridge: upgrade pipeline threw", { err });
        try { ws.close(CLOSE_BRIDGE.INTERNAL, "internal error"); } catch { /* */ }
      });
    });
    return true;
  }

  function startBridge(
    userWs: WebSocket,
    uid: bigint,
    endpoint: { host: string; port: number; coldStart?: boolean; bundleRev?: string },
    earlyMessages: Array<{ data: RawData; isBinary: boolean; receivedAtMs: number }>,
    /**
     * 可选 agent_containers.id。来自 ResolveContainerEndpoint;v3 supervisor
     * 路径填,test mock 路径可不填。无值或 deps.markContainerActivity 未注入
     * → 不刷活动(等价于回到本 PR 之前的行为,只在 ensureRunning 刷一次)。
     */
    containerId: number | undefined,
    /**
     * 已构造好的容器侧 WS(direct 或 tunnel)。caller 在 handleUpgrade 内
     * 完成构造,把成功品交给本函数;失败品 caller 自己 close,不进 bridge。
     */
    containerWs: WebSocket,
    /**
     * caller 持有的 abort controller(同 createXxxContainerSocket 收到的 signal)。
     * cleanup 时调 abort() — 让 tunnel WS 在握手阶段 abort 也能被打断。
     */
    connectAbort: AbortController,
    /**
     * 0049 模型授权 handle —— null 表示本连接不做模型校验(deps 未注入,或
     * caller 显式不要鉴权)。语义见 `ModelCheckerHandle`(含 R1 BLOCKER-1 的 epoch 联动)。
     *
     * onUserMessage 每条 inbound.message 帧 sync 调一次 isAllowed,且追踪
     * lastSeenModelId 让没带 model 字段的后续帧也参与校验(plan v3 review v1
     * follow-up:防"已用 gpt-5.5 跑起来的桥被撤销后无 model 字段帧透传");
     * 权威开启时,每 turn 还会在 catalog epoch fence 之后跑一次 grants epoch fence
     * (resolveAuthorityExecOrReject 尾部)。
     */
    modelCheckerHandle: ModelCheckerHandle | null,
    /**
     * P0 计费旁路封堵 —— master 侧 agent→model 权威快照 handle(bridge 可信模型
     * 推导;null = deps 未注入,桥不做推导,行为与字段加入前一致)。
     *   - `resolve(agentId)`:已绑定本连接 uid 的 sync 快照 closure;null = 权威
     *     推导不出(未知 agentId)
     *   - `isRuntimeDenied(agentId)`:已安装/预设但能力未就绪的显式拒绝集；即使
     *     浏览器带了 model 也不得绕过
     *   - `refresh()`:重拉快照(周期 timer 与推导 miss 时补触发,幂等去重)
     * onUserMessage 的 inbound.message 分类用它推导「帧无 model 时该 agent 的
     * 有效模型」,与容器 gateway resolveEngine 的判定保持同构。
     */
    agentModelResolverHandle:
      | {
          resolve: (agentId: string) => string | null;
          isRuntimeDenied: (agentId: string) => boolean;
          refresh: () => Promise<void>;
        }
      | null,
    /**
     * S12e CG4:caller(handleUpgrade)早期生成的 connection-scoped trace。
     * 移到 caller 的原因:tunnel factory 在 startBridge 之前调,需要同一个值
     * 写 outgoing `X-Connection-Trace-Id` 头与 bridge log connection 字段共享。
     * 36 char UUID(`randomUUID()`),过 TRACE_ID_REGEX。
     */
    connId: string,
    /**
     * 连接用户的角色(来自 handleUpgrade 的 JWT claims.role,缺省 'user')。
     * 当前唯一消费点 = executionDescriptor 的角色分档窗口投影(modelRolePolicy,
     * 如 kimi-k3:admin 1M / 其他 500k)。语义与 claims.role 的其它读取点一致:
     * 非破坏性产品分档,token 生命周期内的角色漂移可容忍(收窄方向保守)。
     */
    userRole: "user" | "admin" = "user",
  ): void {
    // CG2b/CG4 — connection-scoped logger:把 uid + connection-level trace 钉进 bindings,
    // 后续 startBridge 内所有 log call 不必手写这两个字段。turn-scoped(traceId)再从
    // bridgeLog.child 派生。
    //
    // 字段命名(plan §3.5 合同 A):
    // - `connectionTraceId`(camelCase)= 当前 connection 的 connId(UUID),与 node-agent /
    //   in-container gateway 共享同一名字,跨进程 grep 一条 line 就能拿到整个 connection 日志
    // - `connId` 保留为字段别名(behavioral compat:既有 alert / metric 查询基于此名)
    // - **不绑 agentId**:v3 commercial bridge 是 connection-scoped(一用户一容器,not per-agent),
    //   `resolveContainerEndpoint` 也不返 agentId;agentId 是 per-frame 字段,turn 入口
    //   再 child 进去。Plan §3.5 row A.1 列了 agentId 是文档对 connection 概念的笔误
    //   (Codex 同意,见 plan v3 review)。
    //
    // 此 logger 不能用在 broadcastToUser(跨多 ws,不属于单一 connection),也不用在
    // handshake 阶段(那里 connId 已经存在,但 uid 还没解出来)。
    const bridgeLog = log?.child({
      uid: uid.toString(),
      connId,
      connectionTraceId: connId,
    }) ?? null;
    const startedAt = Date.now();
    // PR1:debounced last_ws_activity 刷新窗口。
    // 初始化为 0 → 第一帧 client→container 一定刷一次。
    // ensureRunning 虽然也刷,但是 fire-and-forget(可能静默失败);bridge 自己再
    // 刷一次更稳妥,代价只是握手后多一次 UPDATE,可接受。
    let lastActivityRefreshAt = 0;
    const markActivity = deps.markContainerActivity;
    let bytesUC = 0;
    let bytesCU = 0;
    let bufferedUC = 0; // user → container 待发字节
    let bufferedCU = 0; // container → user 待发字节
    let cause: BridgeCloseCause = "internal_error";
    let cleaned = false;
    const skippedRecoveryIds = new Set<string>();
    // Bridge TTFT:首个 user→container 帧 ↔ 首个 container→user 帧。
    // - firstUserFrameAtMs 由 onUserMessage / earlyMessages replay 第一次进入时设置
    // - firstContainerFrameAtMs 仅作 dedupe(确保只 observe 一次)
    // - 守卫 firstUserFrameAtMs !== null 是防御"容器在用户发帧前主动 push"导致负值
    let firstUserFrameAtMs: number | null = null;
    let firstContainerFrameAtMs: number | null = null;
    const firstVisibleTraceIds = new Set<string>();
    const ttftKind: "cold" | "warm" = endpoint.coldStart === true ? "cold" : "warm";
    // plan v3 review v1 §F4 follow-up:per-bridge 最后一次"用户主动声明"的 modelId。
    // 用于在没带 model 字段的后续帧上仍然能用对应 model 校验 grants(防在飞会话
    // 被撤销后还能继续发字)。null = 本桥还没收过任何带 model 的帧。
    let lastSeenModelId: string | null = null;
    let clientBuildForConnection: string | null = null;
    // 周期 refresh modelChecker 的定时器;cleanup() 务必清掉。
    let modelCheckerRefreshTimer: ReturnType<typeof setInterval> | null = null;

    // 客户端存活时间戳(只由 pong / 用户上行消息刷新 —— 真·client liveness)。
    // **不**被下行帧刷新(否则容器持续吐帧会架空下面的硬上限,Codex 审 MEDIUM)。
    let lastAliveAt = Date.now();
    // turn 在飞的心跳放行截止点(绝对时刻)。inbound.message 到达 → now+MAX_TURN_GRACE_MS(硬上限);
    // isFinal 到达 → 收窄到 now+POST_FINAL_GRACE_MS(只缩不延);心跳 now<turnActiveUntil 即放行。
    let turnActiveUntil = 0;

    // ── 模型执行权威:per-connection attestation 门 + 签发(方案 §7 步 4)──────
    //
    // attestation 是**连接级持续门**而非一次性 census(R2-B5):stopped 旧容器复活 /
    // 检查窗口内新建的旧容器 / 早到帧,三类竞态全部由「未 attest 前缓冲、超时即拒 +
    // recycle」覆盖 —— 不靠"部署时数一遍容器"这种会过期的证据。
    const authorityDeps = deps.modelAuthority;
    const authorityOn = authorityDeps !== undefined;
    /** 轮换步骤② 的 keyring 覆盖普查(缺省 = 进程级单例);flag 关 → 不登记。 */
    const authorityCensus =
      authorityDeps !== undefined ? (authorityDeps.census ?? authorityKeyCensus) : null;
    /**
     * **签发边界**的 epoch 直读(MAJOR-2)。默认 = catalog 的单行 SELECT(无时间缓存),
     * 与 turn 起手 fence 用的是同一个权威源 —— 两次读之间的任何安全写都会被这次读看见。
     */
    const readEpochAtSign = authorityDeps?.readSecurityEpoch ?? readSecurityEpoch;
    /** 容器 attest 帧携带的 challenge(gateway 每连接现铸)。签进每份 authority payload。 */
    let containerChallenge: string | null = null;
    /** pending = 缓冲用户帧;ok = 放行;failed = 连接已判死(帧丢弃,close 在飞)。 */
    let attestState: "pending" | "ok" | "failed" = authorityOn ? "pending" : "ok";
    /** 容器 attest 是否携带 durable-turn-dispatch-v1:true 才走 dispatch 受理,否则 legacy。 */
    let containerHasDurableDispatch = false;
    let recoveryExecutor: ((job: ClaimedRecoveryJob) => void) | null = null;
    let attestTimer: ReturnType<typeof setTimeout> | null = null;
    const attestQueue: Array<{
      data: RawData;
      isBinary: boolean;
      ingress: "browser" | "prompt_queue" | "recovery";
      dispatchRequest?: PromptQueueDispatchRequest;
      recoveryJob?: ClaimedRecoveryJob;
    }> = [];
    let attestQueuedBytes = 0;

    /** 容器不支持 / 不及时 attest → 拒连接 + 触发 stale recycle(下次连接拿到新容器)。 */
    const failAttestation = (reason: string): void => {
      if (attestState === "failed") return;
      attestState = "failed";
      if (attestTimer !== null) {
        clearTimeout(attestTimer);
        attestTimer = null;
      }
      attestQueue.length = 0;
      attestQueuedBytes = 0;
      bridgeLog?.error("user-chat-bridge: model authority attestation failed", {
        reason,
        containerId,
      });
      if (containerId !== undefined && authorityDeps?.recycleContainer !== undefined) {
        try {
          authorityDeps.recycleContainer(containerId, reason);
        } catch (err) {
          bridgeLog?.warn("user-chat-bridge: recycle request failed", { err });
        }
      }
      if (!cleaned && userWs.readyState === WebSocket.OPEN) {
        sendErrorFrame(
          userWs,
          "CONTAINER_OUTDATED",
          "运行环境需要更新,已自动重建,请刷新页面后重发",
        );
        try {
          userWs.close(CLOSE_BRIDGE.ENV_RECYCLED, "model_authority_unsupported");
        } catch { /* */ }
      }
    };

    /** 容器 attest 帧到达(bridge 拦截消费,**绝不**透传给浏览器)。 */
    const onContainerAttest = (frame: Record<string, unknown>): void => {
      if (!authorityOn || attestState !== "pending") return;
      const capsRaw = frame.capabilities;
      const caps = Array.isArray(capsRaw) ? capsRaw : [];
      const challenge =
        typeof frame.connectionChallenge === "string" ? frame.connectionChallenge : "";
      if (!caps.includes(MODEL_AUTHORITY_CAPABILITY) || challenge === "") {
        // 容器广播不出 capability = 它**验不了签**(旧 release 或旧 env 无 keyring)。
        // 放它过去就等于让 master 与容器各判各的 —— 正是本批次要消灭的双信任源。
        failAttestation("model_authority_capability_missing");
        return;
      }
      // ── keyring 自述(R3-M7 轮换步骤②)────────────────────────────────────
      // 容器上报自己 env ring 的 keyId 集合 + 指纹。两个用处:
      //   (a) **立即门**:ring 里没有 master 当前的 activeKeyId → 这条连接上我们签的每
      //       一张票它都验不过(UnknownKey)。与其让用户撞一整轮 403,不如当场判死 +
      //       recycle,让它带新 env 重建 —— 与"capability 缺失"同一类故障,同一种处置。
      //   (b) **census**:全站覆盖统计,给轮换步骤②(切私钥前的 gate)提供证据。
      // 旧容器(本批次之前的 release)不带 keyIds 字段 → keyIdsUnknown,**不**当场判死
      // (它可能 ring 完全正确,只是不会自报),但 census 把它算作"不覆盖",轮换 gate
      // 因此不会误判为可以切钥。
      const keyIdsRaw = frame.keyIds;
      const keyIdsUnknown = !Array.isArray(keyIdsRaw);
      const attestedKeyIds = Array.isArray(keyIdsRaw)
        ? keyIdsRaw.filter((k): k is string => typeof k === "string")
        : [];
      if (!keyIdsUnknown && !attestedKeyIds.includes(authorityDeps!.signer.activeKeyId)) {
        failAttestation("model_authority_active_key_missing");
        return;
      }
      containerChallenge = challenge;
      // capability 门:容器广播 durable-turn-dispatch-v1 才走 dispatch 受理(RFC §2.2)。
      containerHasDurableDispatch = caps.includes(DURABLE_TURN_DISPATCH_CAPABILITY);
      attestState = "ok";
      if (containerHasDurableDispatch && deps.pgPool && recoveryExecutor === null) {
        recoveryExecutor = (job) => {
          const encoded = Buffer.from(JSON.stringify(job.request), "utf8");
          executeAdmittedTurn(encoded, false, "recovery", undefined, job);
        };
        const key = uid.toString();
        let executors = uidToRecoveryExecutors.get(key);
        if (!executors) {
          executors = new Set();
          uidToRecoveryExecutors.set(key, executors);
        }
        executors.add(recoveryExecutor);
        void drainDurableRecoveryForUser(uid);
      }
      if (attestTimer !== null) {
        clearTimeout(attestTimer);
        attestTimer = null;
      }
      authorityCensus?.record(connId, {
        uid: Number(uid),
        containerId: containerId ?? null,
        keyIds: attestedKeyIds,
        fingerprint:
          typeof frame.keyringFingerprint === "string" ? frame.keyringFingerprint : "",
        keyIdsUnknown,
        attestedAt: Date.now(),
      });
      const queued = attestQueue.splice(0, attestQueue.length);
      attestQueuedBytes = 0;
      bridgeLog?.debug("user-chat-bridge: container attested model authority", {
        containerId,
        queuedFrames: queued.length,
        keyIds: attestedKeyIds,
        keyIdsUnknown,
      });
      // 原样重放:缓冲的是**未处理的原始帧**,重放即走完整 executeAdmittedTurn 流程
      // (authz / codex 分类 / 计费编排 / 签发注入),不存在"半处理帧"的中间态。
      for (const m of queued) {
        executeAdmittedTurn(m.data, m.isBinary, m.ingress, m.dispatchRequest, m.recoveryJob);
      }
    };

    /**
     * 签票(纯 crypto,无 I/O)。**唯一调用方 = sealAuthorityFieldsOrReject**——
     * 私有化是有意的:任何绕过它的签发路径都会跳过签发边界的 epoch 重读(MAJOR-2)。
     * containerChallenge / containerId 缺失 = 装配 bug(attest 门已保证它们就位)→ 抛。
     */
    const signAuthorityBundle = (
      exec: ResolvedTurnExecution,
      billingRequestId?: string,
      authorityTurnId?: string,
    ): ModelAuthorityBundle => {
      if (authorityDeps === undefined || containerChallenge === null || containerId === undefined) {
        throw new Error(
          "[model-authority] sign called before attestation (challenge/containerId missing)",
        );
      }
      return authorityDeps.signer.signBundle({
        uid: Number(uid),
        containerId,
        connectionChallenge: containerChallenge,
        canonicalModel: exec.canonicalModel,
        engine: exec.engine,
        executionDescriptor: exec.descriptor,
        auxModels: exec.auxModels,
        executionRevision: exec.executionRevision,
        securityEpoch: exec.securityEpoch,
        ...(authorityTurnId === undefined ? {} : { authorityTurnId }),
        ...(billingRequestId === undefined ? {} : { billingRequestId }),
      }).bundle;
    };

    /**
     * **签发边界**(代码审 R1 MAJOR-2 的整改单点)——「重读 epoch → 一致才签」。
     *
     * 为什么早期 fence 不够:`resolveAuthorityExecOrReject` 的 fence 发生在 turn 起手,
     * 之后还要走 createCodexRoute → acquire → getAgentCostMultiplier → preCheck →
     * startInflightJournal → attachMasterTurnState 一连串 await(codex 路径实测
     * 可达数十~数百 ms,慢 DB / 大历史时更长)。管理员在这中间禁用模型 / 撤销授权 / 改价
     * 都会 bump epoch,而旧实现会拿**那个已经过时的快照**签出票据 —— 并且 turn lease 的
     * TTL 是 50min。于是"安全变更立刻生效"这条承诺在最要紧的那条路径上被打穿:
     * journal(按旧价开的)照样落、票照样签、容器照样跑。
     *
     * 现在:签之前**直接单行重读 DB epoch**(与 fence 同一权威源,无时间缓存),
     *   - 相等   → 签。此刻之后再发生的安全变更由 egress 的每请求 fence + 容器的 epoch
     *              单调水位接住(方案 §1.2 R3-B2:那是 turn 内后续请求的防线);
     *   - 不等   → **拒帧**(MODEL_CONFIG_CHANGED_RETRY_TURN),
     *   - 读不到(DB 挂)→ **拒帧**(fail-closed;绝不"读不到就当没变")。
     *
     * 拒帧时调用方**必须**跑补偿(`compensate`):这一步之前 codex 路径可能已经开了
     * inflight journal + 占了 preCheck 预扣 + 占了并发槽。留着不管 = 悬空 journal
     * (durable reconciler 最早在 24h evidence SLA 后永久免单)+ 预扣卡 5min + 槽泄漏。
     * 补偿路径复用既有的
     * `snap.abandon()`(abort journal + release reservation)与 `releaseAcquiredSlotForFailure()`
     * —— 不新造第二套回滚语义。
     *
     * @returns 注入 frame 的字段(model 归一 + envelope)| null = 已拒帧,调用方立即 return。
     */
    const sealAuthorityFieldsOrReject = async (args: {
      exec: ResolvedTurnExecution;
      billingRequestId?: string;
      authorityTurnId?: string;
      log: Logger | null;
      onReject?: (code: string) => void;
      turn?: InboundTurnIdentity;
      /** 拒帧时的补偿(abort journal / release preCheck / 还槽);无预扣的路径不传。 */
      compensate?: (reason: string) => Promise<void> | void;
    }): Promise<Record<string, unknown> | null> => {
      const reject = async (code: string, message: string, reason: string): Promise<null> => {
        args.onReject?.(code);
        try {
          await args.compensate?.(reason);
        } catch (err) {
          // 补偿失败不改变"拒帧"这个结论,但必须响亮:悬空 journal 由 reconciler 兜底。
          args.log?.error("user-chat-bridge: authority sign-boundary compensation failed", {
            reason,
            err,
          });
        }
        if (!cleaned && userWs.readyState === WebSocket.OPEN) {
          sendErrorFrame(userWs, code, message, args.turn);
        }
        return null;
      };

      let dbEpoch: bigint;
      try {
        dbEpoch = await readEpochAtSign();
      } catch (err) {
        args.log?.error("user-chat-bridge: sign-boundary epoch read failed", { err });
        return await reject(
          "MODEL_AUTHORITY_UNAVAILABLE",
          "model catalog unavailable, retry shortly",
          "sign_boundary_epoch_read_failed",
        );
      }
      if (Number(dbEpoch) !== args.exec.securityEpoch) {
        args.log?.warn("user-chat-bridge: security epoch changed before signing — refusing turn", {
          fencedEpoch: args.exec.securityEpoch,
          dbEpoch: dbEpoch.toString(),
          model: args.exec.canonicalModel,
        });
        return await reject(
          "MODEL_CONFIG_CHANGED_RETRY_TURN",
          "model configuration changed, please resend",
          "sign_boundary_epoch_changed",
        );
      }
      // 注意:**不**在这里查 `cleaned`。调用方在 seal 之后紧接着就有自己的 cleaned 分支
      // (带各自完整的补偿),在这里提前 return null 会让"已拒(补偿过)"与"桥关了
      // (还没补偿)"两种 null 语义混在一起 —— 正是漏账最爱的那种歧义。
      return {
        model: args.exec.canonicalModel,
        [MODEL_AUTHORITY_FIELD]: signAuthorityBundle(
          args.exec,
          args.billingRequestId,
          args.authorityTurnId,
        ),
      };
    };

    /**
     * 三条 forward 路径共用的前置:epoch fence → resolve descriptor → 与同步分类对账。
     *
     * @returns exec(可签) | null = **已拒帧**(error 帧已发),调用方必须立即 return。
     *
     * 「与同步分类对账」是必须的:codex/非 codex 的**计费路径**在同步上下文里就已按
     * peek 快照选定(preCheck / journal / 单飞槽都挂在那条路上)。若 fence 后的权威快照
     * 判出另一个 engine,说明 catalog 在这两步之间变了 —— 继续跑就是「按 A 计费、按 B 执行」。
     * 此时返回 MODEL_CONFIG_CHANGED_RETRY_TURN(R3-m12),让前端重开 turn。
     */
    const resolveAuthorityExecOrReject = async (args: {
      model: string | null;
      classifiedCodex: boolean;
      log: Logger | null;
      onReject?: (code: string) => void;
      turn?: InboundTurnIdentity;
    }): Promise<ResolvedTurnExecution | null> => {
      const reject = (code: string, message: string): null => {
        args.onReject?.(code);
        if (!cleaned && userWs.readyState === WebSocket.OPEN) {
          sendErrorFrame(userWs, code, message, args.turn);
        }
        return null;
      };
      if (authorityDeps === undefined) return null;
      if (args.model === null) {
        args.log?.info("user-chat-bridge: model authority unresolved model");
        return reject(
          "UNRESOLVED_AGENT_MODEL",
          "cannot resolve execution model for this turn — retry shortly or specify a model",
        );
      }
      let exec: ResolvedTurnExecution;
      try {
        exec = await resolveTurnExecution(authorityDeps.catalog, args.model);
      } catch (err) {
        if (err instanceof ModelNotAvailableError) {
          args.log?.info("user-chat-bridge: model not available", { model: args.model });
          return reject("MODEL_NOT_AVAILABLE", `model not available: ${args.model}`);
        }
        // catalog unknown / epoch fence 重建失败 / DB 不可达 → fail-closed 拒帧。
        // **不降级为"不带 envelope 转发"** —— 那会让容器回落 baked 判定(双信任源)。
        args.log?.error("user-chat-bridge: model authority fence failed", { err });
        return reject("MODEL_AUTHORITY_UNAVAILABLE", "model catalog unavailable, retry shortly");
      }
      if (cleaned) return null;
      const execIsCodex = exec.engine !== "ccb";
      if (execIsCodex !== args.classifiedCodex) {
        args.log?.warn("user-chat-bridge: engine reclassified mid-turn", {
          model: args.model,
          canonicalModel: exec.canonicalModel,
          engine: exec.engine,
          classifiedCodex: args.classifiedCodex,
        });
        return reject(
          "MODEL_CONFIG_CHANGED_RETRY_TURN",
          "model configuration changed, please resend",
        );
      }

      // ── grants 授权快照的 epoch fence(代码审 R1 BLOCKER-1)────────────────
      // 上面 fence 的是 **catalog**(模型是否可执行);授权(visibility ∨ per-user grants)
      // 是**另一份**快照 —— 连接级 checker,原本只有 30s 周期刷新 + 刷新失败 keep-LKG。
      // 0144 起任何 grant 写(尤其 DELETE = 撤权)都 bump security epoch,于是:
      //   checker.epoch < 权威 epoch  ⟺  自本连接读 grants 之后发生过安全写
      //                                  (可能就是针对本用户的撤权)
      // → 同步重载 grants 并**用新快照重新判定**;重载失败 → 拒帧(**不 keep-LKG 放行**:
      //   codex turn 不经 egress 的每请求授权,这里放行 = 撤权后旧连接仍能签票执行)。
      // 命中 reload 的代价只在「epoch 刚变过」的那一两帧,稳态零额外开销。
      if (modelCheckerHandle !== null) {
        const wantEpoch = BigInt(exec.securityEpoch);
        if (modelCheckerHandle.epoch() < wantEpoch) {
          try {
            await modelCheckerHandle.reloadAtLeast(wantEpoch);
          } catch (err) {
            args.log?.error("user-chat-bridge: grants checker reload failed (fail-closed)", {
              wantEpoch: wantEpoch.toString(),
              err,
            });
            return reject(
              "MODEL_AUTHORITY_UNAVAILABLE",
              "authorization unavailable, retry shortly",
            );
          }
          if (cleaned) return null;
          if (!modelCheckerHandle.isAllowed(exec.canonicalModel)) {
            args.log?.info("user-chat-bridge: model authorization revoked mid-connection", {
              model: exec.canonicalModel,
              epoch: wantEpoch.toString(),
            });
            return reject(
              "UNAUTHORIZED_MODEL",
              `model not authorized for current user: ${exec.canonicalModel}`,
            );
          }
        }
      }
      // ── 角色分档窗口投影(modelRolePolicy · 执行轴)──────────────────────────
      // descriptor.contextWindow 是 CCB auto-compact 的实际执行窗口 —— 在签发前按本连接
      // 角色收窄(如 kimi-k3:admin 1M / 其他 500k)。签名 envelope 只对 descriptor 整体签名,
      // egress gate 校验的是快照级 executionRevision(catalog 机制行未动,不受影响)。
      //
      // ⚠ 一致性边界(审计纠偏):这是**执行轴**,role 取连接 claims(JWT),**从不进
      //   projectionRevision 对账**。只有列表轴(listForUser 的 DB role)才有 master↔egress
      //   的 409 对账网;本处窗口收窄不会被任何 409 兜住。JWT/DB 角色在 15min TTL 内的漂移
      //   是被设计容忍的(晋升迟一个 token 生命周期、收窄方向保守;降级窗口 ≤ token TTL,与
      //   grants 30s 刷新同级别容忍)。⇒ 执行轴一致性的**唯一防线** = 与 listForUser 共用
      //   同一纯函数 projectContextWindowForRole + 两处落点单测(modelRolePolicy.test.ts 纯
      //   函数契约 / modelAuthorityBridge.test.ts:431 bridge 签发)。别删这两个测试,也别新增
      //   旁路投影而不加对应落点单测。
      const projectedWindow = projectContextWindowForRole(
        exec.canonicalModel,
        exec.descriptor.contextWindow,
        userRole,
      );
      if (projectedWindow !== exec.descriptor.contextWindow) {
        exec = {
          ...exec,
          descriptor: { ...exec.descriptor, contextWindow: projectedWindow },
        };
      }
      return exec;
    };

    // Codex turn ownership is session-scoped, not bridge-scoped. A browser WS can
    // multiplex several sessions; serializing the whole bridge made one long task
    // block unrelated sessions. Each peer retains strict single-flight while
    // different peers may use the account scheduler's configured concurrency.
    type ActiveCodexTurnState = {
      readonly stateId: string;
      readonly peerKey: string;
      readonly peerId: string | null;
      readonly clientMessageId: string | null;
      readonly promptQueueGrantId: string | null;
      engine: "codex" | "grok";
      acquireInflight: boolean;
      acquiredAccountId: bigint | null;
      acquiredSlotId: string | null;
      apiRelayRouteToken: string | null;
      billingRequestId: string | null;
      turnForwarded: boolean;
      releaseTimer: ReturnType<typeof setTimeout> | null;
      slotHeartbeat: ReturnType<typeof setInterval> | null;
    };
    const activeCodexTurnsByPeer = new Map<string, ActiveCodexTurnState>();
    const promptQueueDispatchCancellations = new Map<string, {
      request: PromptQueueDispatchRequest;
      cancel(reasonCode: string): Promise<void>;
    }>();
    type PendingGrokLeaseRelease = {
      accountId: bigint;
      slotId: string;
      reason: string;
      inFlight: Promise<void> | null;
      retryRequested: boolean;
    };
    // Retain the exact lease identity after local turn state is removed. A
    // transient durable-expiry failure is retried by the immutable terminal
    // billing frame (same bridge here; a new bridge uses journal ctx below).
    const pendingGrokLeaseReleases = new Map<string, PendingGrokLeaseRelease>();
    const retryPendingGrokLeaseRelease = (requestId: string): void => {
      const pending = pendingGrokLeaseReleases.get(requestId);
      if (pending === undefined || deps.releaseGrokRouteLease === undefined) return;
      if (pending.inFlight !== null) {
        pending.retryRequested = true;
        return;
      }
      const attempt = deps.releaseGrokRouteLease(pending.accountId, pending.slotId)
        .then(() => {
          if (pendingGrokLeaseReleases.get(requestId) === pending) {
            pendingGrokLeaseReleases.delete(requestId);
          }
        })
        .catch((err) => {
          bridgeLog?.warn("user-chat-bridge: release durable Grok route lease failed; terminal frame remains retryable", {
            requestId,
            reason: pending.reason,
            err: (err as Error)?.message ?? String(err),
          });
        })
        .finally(() => {
          if (pendingGrokLeaseReleases.get(requestId) !== pending) return;
          pending.inFlight = null;
          if (pending.retryRequested) {
            pending.retryRequested = false;
            retryPendingGrokLeaseRelease(requestId);
          }
        });
      pending.inFlight = attempt;
    };
    const codexPeerKey = (peerId: string | null): string =>
      peerId === null ? "__missing_peer__" : `peer:${peerId}`;
    const isCurrentCodexTurnState = (state: ActiveCodexTurnState): boolean =>
      !cleaned && activeCodexTurnsByPeer.get(state.peerKey) === state;
    const expireCodexRouteToken = (token: string | null, reason: string): void => {
      if (token === null) return;
      const expire = deps.expireCodexRoute;
      if (expire === undefined) return;
      void expire(token).catch((err) => {
        bridgeLog?.warn("user-chat-bridge: expire codex route failed", {
          reason,
          err: (err as Error)?.message ?? String(err),
        });
      });
    };
    const releaseCodexTurnState = (
      state: ActiveCodexTurnState,
      reason: string,
      expireRouteTokenOnRelease = true,
      preserveAccountSlot = false,
    ): void => {
      if (state.releaseTimer !== null) {
        clearTimeout(state.releaseTimer);
        state.releaseTimer = null;
      }
      if (state.slotHeartbeat !== null) {
        clearInterval(state.slotHeartbeat);
        state.slotHeartbeat = null;
      }
      const accountId = state.acquiredAccountId;
      const slotId = state.acquiredSlotId;
      state.acquiredAccountId = null;
      state.acquiredSlotId = null;
      const routeToken = state.apiRelayRouteToken;
      state.apiRelayRouteToken = null;
      state.acquireInflight = false;
      // Identity compare is the stateId fence: a late completion can never delete
      // a newer turn that reused the same peer key.
      const current = activeCodexTurnsByPeer.get(state.peerKey);
      if (current === state && current.stateId === state.stateId) {
        activeCodexTurnsByPeer.delete(state.peerKey);
      }
      if (state.promptQueueGrantId !== null) {
        promptQueueDispatchCancellations.delete(state.promptQueueGrantId);
      }
      const durableGrokRelease =
        !preserveAccountSlot && state.engine === "grok" &&
        accountId !== null && slotId !== null && deps.releaseGrokRouteLease !== undefined;
      if (durableGrokRelease) {
        const releaseKey = state.billingRequestId ?? `state:${state.stateId}`;
        if (!pendingGrokLeaseReleases.has(releaseKey)) {
          pendingGrokLeaseReleases.set(releaseKey, {
            accountId,
            slotId,
            reason,
            inFlight: null,
            retryRequested: false,
          });
        }
        retryPendingGrokLeaseRelease(releaseKey);
      } else if (!preserveAccountSlot && accountId !== null && slotId !== null && deps.codexBinding !== undefined) {
        try { deps.codexBinding.release(accountId, slotId); } catch { /* best effort */ }
      }
      if (expireRouteTokenOnRelease && !durableGrokRelease) {
        expireCodexRouteToken(routeToken, reason);
      }
    };

    // Phase 4 — GitHub session-repo auto-rebind:bridge 实例级 cache。
    //   containerWs.on('open') 时 fetch active selections 进 map(无 token);
    //   inbound.hello 到达时记录 peerIds,然后调 flush:对 peers 取交集,async
    //   富化 token + 推 bind 帧。
    //   key = sessionId;value = DB row。bridge close 时随 closure GC,无需手动清。
    //
    //   Codex Phase 4.7 #2 修:flush 必须从两边触发(hello 到达 + open-fetch 完成),
    //   否则 hello 先于 fetch 完成时 map 是空,fetch 之后没人触发,active 选择
    //   永远不会 rebind。pendingRebindMap 存"需 rebind 的 row",
    //   lastHelloPeerIds 存"最近 hello 见到的 peers",flush 时取交集。
    const pendingRebindMap = new Map<string, GithubSelectionRow>();
    let lastHelloPeerIds: Set<string> | null = null;
    let autoRebindFetchDone = false;
    let autoRebindFlushInFlight = false;
    /**
     * 双触发 flush:hello 到达 + fetch 完成 都调一次,真正的工作只在两边都就绪时
     * 发生。重入保护(autoRebindFlushInFlight)防止两端同一 tick 都触发时 doublework。
     */
    const tryAutoRebindFlush = (): void => {
      if (!deps.pgPool) return;
      if (lastHelloPeerIds === null || lastHelloPeerIds.size === 0) return;
      if (!autoRebindFetchDone) return;
      if (pendingRebindMap.size === 0) return;
      if (autoRebindFlushInFlight) return;
      autoRebindFlushInFlight = true;
      const pgPoolBound = deps.pgPool;
      const peers = Array.from(lastHelloPeerIds);
      ;(async () => {
        // v1.0.119 — 微任务死循环根因修复。
        //   旧实现:finally 里只判 size > 0 就同步递归调 tryAutoRebindFlush。
        //   触发条件:hello peers 与 pendingRebindMap.sessionIds 不交集时
        //   buildAutoRebindFrames 返回 matchedSessionIds=[],没消化任何 row,
        //   pendingRebindMap.size 不变,finally 立即再次自调 → V8 microtask
        //   永远 spin(strace 100% getpid),event loop 拿不回控制权 → healthz
        //   timeout → wedge。生产 2026-05-09 多次复发由此 bug 触发。
        //   修复:仅在本轮"取得进展"(至少消化一行 pending row)时才再触发。
        //   未取得进展 = 当前 hello peers 与 map 不重叠,继续 flush 也是 no-op,
        //   等下一次外部信号(新 hello / 新 fetch)即可。
        let progressMade = false;
        try {
          const built = await buildAutoRebindFrames(
            pgPoolBound,
            Number(uid),
            peers,
            pendingRebindMap,
          );
          if (built.matchedSessionIds.length > 0) progressMade = true;
          for (const sid of built.matchedSessionIds) pendingRebindMap.delete(sid);
          for (const f of built.frames) {
            const buf = Buffer.from(JSON.stringify(f), "utf8");
            forwardInboundFrame(buf, false, buf.length);
            // v1.0.94 — 诊断 instrument。auto-rebind 路径在容器重连后自动重发 bind,
            // 与显式 bind 路径用同一日志体便于 grep。
            bridgeLog?.info("user-chat-bridge: repo_bind_auto_rebind_forwarded", {
              sessionId: f.sessionId,
              selectionVersion: f.selectionVersion,
              agentId: f.agentId,
            });
          }
          if (built.errors.length > 0 && userWs.readyState === WebSocket.OPEN) {
            for (const e of built.errors) {
              try { userWs.send(JSON.stringify(e)); } catch { /* */ }
            }
          }
        } catch (err) {
          bridgeLog?.warn("user-chat-bridge: auto-rebind flush failed", { err });
        } finally {
          autoRebindFlushInFlight = false;
          // 仅在本轮真消化了 row(progressMade)时才再触发,否则当前 hello peers
          // 与 pendingRebindMap 不交集,继续 flush 是 no-op 死循环。
          if (
            progressMade &&
            lastHelloPeerIds !== null &&
            lastHelloPeerIds.size > 0 &&
            pendingRebindMap.size > 0
          ) {
            tryAutoRebindFlush();
          }
        }
      })();
    };

    // PR2 v1.0.66 — codex 真扣费 per-bridge inflight Map + drain 状态。
    //   inflightCodexTurns: requestId → snapshot (deferred finalizer + model)
    //     - 由 codex acquire IIFE 在成功路径 set
    //     - 由 onContainerMessage 的 outbound.codex_billing 分支**同步先 delete** 再 settle
    //     - 由 finalCleanup 兜底清空(**只清本地簿记,不 abort journal** —— P0 修复
    //       2026-07-03:桥关 ≠ turn 终止,权威裁决收敛 request_finalize_journal,
    //       见 finalCleanup 内注释与 handleCrossBridgeCodexBilling)
    //   drainTimer: user_close + Map 非空时启动的 5s(env DRAIN_BILLING_MS)收尾窗口 timer
    //     - settle 把 Map 减到 0 → checkDrainComplete 提前 finalCleanup
    //     - 超时仍未 settle → finalCleanup(journal 保持 inflight;billing 帧后续到
    //       任意新桥走跨桥 settle,真死则 reconciler 终态化)
    //     - 容器异常 / shutdown / force 抢占 drain → 立即 finalCleanup(见 cleanup 状态机)
    //   drainCause: 进入 drain 时的 trigger cause(稳定保留,避免 mutable cause 干扰)
    //   userDetached: 守 detachUserSide 幂等(drain 入口 + finalCleanup 都跑)
    const inflightCodexTurns = new Map<string, CodexTurnSnapshot>();
    const pendingZcodeRequestIds = new Set<string>();
    const pendingZcodeRelays = new Map<string, {
      token: string;
      modelId: string;
      sessionId: string | null;
      traceId: string;
    }>();
    // P0 修复(2026-07-03)— 跨桥 settle 的同步去重簿记:同 requestId 的 duplicate
    // billing 帧在 journal 回查/settle 在途期间直接丢弃(与主路径 Map.delete 先行
    // 的单次门控同构)。跨进程/跨桥并发仍由 journal CAS + usage_records UNIQUE 兜底。
    const pendingJournalSettles = new Set<string>();
    // P0 修复(2026-07-03)— 本桥已进入 settle/abandon 的 requestId 簿记:主路径
    // Map.delete 后,同桥 duplicate 帧会掉进 unknown-turn 分支;没有这本账,它们会
    // 走 journal 回查再撞一次 settle(靠 DB UNIQUE 兜底虽不会重复扣,但多一次无谓
    // settle 尝试 + 依赖时序)。记下后同桥 duplicate 恢复旧语义:同步 info 丢弃。
    // per-connection 生命周期,量级 = 本连接 turn 数,无泄漏。
    const locallySettledCodexTurns = new Set<string>();
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let drainCause: BridgeCloseCause | null = null;
    let userDetached = false;
    const retainedOutboundPersistQueueKeys = new Set<string>();
    const retainOutboundPersistQueueKey = (key: string): void => {
      if (userDetached || retainedOutboundPersistQueueKeys.has(key)) return;
      outboundPersistQueues.retain(key);
      retainedOutboundPersistQueueKeys.add(key);
    };

    // ── durable turn dispatch(RFC §2.2 B1)本连接受理簿记 ─────────────────────
    //   admittedDispatches: clientMessageId → dispatch 身份 + lease。仅
    //     containerHasDurableDispatch 时落表;记录本连接持 lease 的 admitted turn。
    //     生命周期:受理时 set;pre-forward 失败 CAS terminal / heartbeat 判非本 owner
    //     (turn 终态或被接管)时删除;finalCleanup 清空。
    //   dispatchHeartbeatTimer: 持 lease 期间长窗口 attach 内续租(匹配 owner+epoch+
    //     status='admitted');lease drop 出 map,drain 期间保活(仅 finalCleanup 清)。
    //   drain 完成条件与 inflightCodexTurns 并列(checkDrainComplete)。
    interface AdmittedDispatch {
      clientMessageId: string;
      sessionId: string;
      dispatchId: string;
      billingRequestId: string;
      attemptNo: number;
      leaseEpoch: number;
      anchorSeq: bigint | null;
      /** = envelope payloadHash(sha256 内容身份;容器验帧体 hash 用)。 */
      requestHash: string;
      /** Present only for a Master-scheduled automatic recovery. */
      recoveryJob?: ClaimedRecoveryJob;
    }
    const admittedDispatches = new Map<string, AdmittedDispatch>();
    let dispatchHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

    /** 删记录并在 drain 期推进完成判定(map 空 + inflight 空才收尾)。 */
    const dropAdmittedDispatch = (clientMessageId: string): void => {
      if (admittedDispatches.delete(clientMessageId)) checkDrainComplete();
    };
    /** 首次受理时惰性起心跳(unref);legacy 连接从不受理 → 永不建 timer(行为不变)。 */
    const ensureDispatchHeartbeat = (): void => {
      if (dispatchHeartbeatTimer !== null || !deps.pgPool) return;
      dispatchHeartbeatTimer = setInterval(() => {
        const pool = deps.pgPool;
        if (!pool) return;
        for (const rec of [...admittedDispatches.values()]) {
          void heartbeatLease(pool, {
            dispatchId: rec.dispatchId,
            ownerId: connId,
            leaseEpoch: rec.leaseEpoch,
            leaseTtlMs: DISPATCH_LEASE_TTL_MS,
          })
            .then((held) => {
              // held=false ⇒ 已非本 owner(被接管 / 已离态)→ 停止把它当权威。
              if (!held) dropAdmittedDispatch(rec.clientMessageId);
            })
            .catch(() => {});
        }
      }, DISPATCH_LEASE_HEARTBEAT_MS);
      dispatchHeartbeatTimer.unref?.();
    };
    /** pre-forward 失败出口:CAS terminal(executed_error)+ 移除记录。fire-and-forget。
     *  B-R1-1:client_notified 一律 **false**。即便此刻 socket OPEN、也发了实时 error 帧,那只是
     *  「加速」——socket OPEN ≠ 前端已 durable 落地该终态(帧可能在途丢、页面已切走)。durable 的
     *  「已告知」唯一由 reconciler 在权威终态事务内置真(§2.3 ③)。绝不用瞬态 socket 态推断
     *  client_notified,否则 fail-visible(I1)会因误判「已通知」而不再补发终态。 */
    const failDispatchPreForward = (
      record: AdmittedDispatch | undefined,
      failureCode: string,
    ): void => {
      if (record === undefined) return;
      const pool = deps.pgPool;
      dropAdmittedDispatch(record.clientMessageId);
      if (!pool) return;
      if (record.recoveryJob) {
        void releaseRecoveryPreReceipt(pool, {
          job: record.recoveryJob,
          dispatchId: record.dispatchId,
          dispatchOwner: connId,
          dispatchLeaseEpoch: record.leaseEpoch,
        }).catch(() => {});
        return;
      }
      void casToTerminal(pool, {
        dispatchId: record.dispatchId,
        outcome: "executed_error",
        failureCode,
        clientNotified: false,
        expectedEpoch: record.leaseEpoch,
      }).catch(() => {});
    };
    /** 按帧的 clientMessageId 反查本连接受理记录(IIFE forward/失败出口共用)。 */
    const lookupAdmittedDispatch = (
      frameObj: Record<string, unknown>,
    ): AdmittedDispatch | undefined => {
      const cmid = isClientMessageId(frameObj.clientMessageId)
        ? frameObj.clientMessageId
        : null;
      return cmid === null ? undefined : admittedDispatches.get(cmid);
    };
    /** 帧注入 __oc_dispatch envelope(记录存在 + 签发基建就位才注)。mirror MODEL_AUTHORITY_FIELD。 */
    const dispatchAuthorityField = (
      record: AdmittedDispatch | undefined,
    ): Record<string, unknown> => {
      if (
        record === undefined ||
        authorityDeps === undefined ||
        containerChallenge === null ||
        containerId === undefined
      ) {
        return {};
      }
      return {
        [DISPATCH_AUTHORITY_FIELD]: mintDispatchEnvelope(authorityDeps.signer, {
          uid,
          containerId,
          sessionId: record.sessionId,
          clientMessageId: record.clientMessageId,
          dispatchId: record.dispatchId,
          attemptNo: record.attemptNo,
          payloadHash: record.requestHash,
          billingRequestId: record.billingRequestId,
          connectionChallenge: containerChallenge,
        }),
      };
    };

    const recordBillingRecovery = (
      requestId: string,
      outcome: "pending" | "failed" | "recovered" | "abandoned",
      snap?: Pick<CodexTurnSnapshot, "model" | "traceId">,
      attempts = 1,
    ): void => {
      if (!deps.pgPool) return;
      void recordProductFrictionEvent({
        correlation: requestId,
        userId: uid,
        surface: "ws",
        stage: "billing_recovery",
        code: "USER_WS_DETACHED",
        outcome,
        attempts,
        model: snap?.model ?? null,
        traceId: snap?.traceId ?? null,
      }, deps.pgPool).catch(() => {});
    };

    // 注册到 registry,超额会踢老的。连接态信号只走 close code,**不发 turn 级 error 帧**
    // (曾经 kick/shutdown 共用"error 帧 + 4505",部署一次=全线会话钉红卡+误报连接数超限;
    // close code 语义拆分后前端按码分流:4505=提示关多余标签页,4509=静默重连+resume 续传)。
    const conn: Conn = {
      id: connId,
      user_id: uid.toString(),
      opened_at: startedAt,
      close: (_reason, cause) => {
        if (cause === "shutdown") {
          try { userWs.close(CLOSE_BRIDGE.SERVER_RESTART, "server_restart"); } catch { /* */ }
        } else {
          try { userWs.close(CLOSE_BRIDGE.TOO_MANY_CONNECTIONS, "too_many_connections"); } catch { /* */ }
        }
      },
    };
    const { unregister, evicted } = registry.register(conn);
    // 踢人必须留痕:互踢循环/超限排查的第一手证据(close code 4505 服务端此前无日志)。
    for (const victim of evicted) {
      bridgeLog?.warn("user-chat-bridge: kicked oldest connection (per-user limit)", {
        uid: uid.toString(), connId, victimConnId: victim.id, maxPerUser,
      });
    }

    // 同步加入 uid→ws 表,broadcastToUser 用得到。cleanup 里务必同步删除。
    {
      const key = uid.toString();
      let set = uidToUserWs.get(key);
      if (!set) { set = new Set(); uidToUserWs.set(key, set); }
      set.add(userWs);
    }

    // 连接超时:N ms 内 containerWs 没 OPEN → 取消 + 关 user
    const connectTimer = setTimeout(() => {
      if (containerWs.readyState !== WebSocket.OPEN) {
        bridgeLog?.warn("user-chat-bridge: container connect timeout", {
          host: endpoint.host, port: endpoint.port,
        });
        try { connectAbort.abort(); } catch { /* */ }
        try { containerWs.terminate(); } catch { /* */ }
        sendErrorFrame(userWs, "ERR_CONTAINER_TIMEOUT", "agent connect timeout");
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent timeout"); } catch { /* */ }
        // 容器都没起来 → 不可能有 inflight billing 帧来,force=true 直接 final
        cleanup("container_error", true);
      }
    }, connectTimeoutMs);

    // ---------- 双向 pipe handlers ----------

    // Single preparation helper for both browser turns and internally granted
    // queue turns. Persistence, dedupe, master history and GoalState therefore
    // cannot drift between the legacy and queued dispatch lanes.
    const attachMasterTurnState = async (
      frameObj: Record<string, unknown>,
      turnLog: Logger | null,
      // MIN1:受理成功后 fire-and-forget 回填 turn_traces.dispatch_id/request_id 用(纯展示)。
      // 由各 IIFE 传入本 turn 的 canonical traceId(捕获的稳定值,防跨帧 mutate);缺则不回填。
      traceId: string | null = null,
      // prompt-queue lane:协调器已持久化 user 行 → persistUserRow=false 跳过受理/持久块
      // (含 durable dispatch 准入 —— 绝不给 queue turn 建第二套 turn_dispatches 权威,防权威源分裂);
      // onReject 在受理/goal 拒轮时回调,让 queue 协调器取消本次 dispatch grant。
      persistUserRow = true,
      onReject?: (code: string) => void,
      historyModel: string | null = typeof frameObj.model === "string" ? frameObj.model : null,
      recoveryJob?: ClaimedRecoveryJob,
    ): Promise<Record<string, unknown> | null> => {
      const peer = frameObj.peer;
      const peerId =
        peer && typeof peer === "object"
          ? (peer as { id?: unknown }).id
          : undefined;
      if (typeof peerId !== "string" || peerId.length === 0) return frameObj;
      const clientMessageId = isClientMessageId(frameObj.clientMessageId)
        ? frameObj.clientMessageId
        : null;
      const frameContent = frameObj.content && typeof frameObj.content === "object"
        ? frameObj.content as { text?: unknown; replyTo?: unknown; recovery?: unknown }
        : null;
      const rawRecovery = frameContent?.recovery;
      const recovery =
        rawRecovery && typeof rawRecovery === "object" && !Array.isArray(rawRecovery)
          ? rawRecovery as Record<string, unknown>
          : null;
      const replyTo = normalizeMessageReplyQuote(frameContent?.replyTo);
      const currentUserText = formatMessageReplyPrompt(
        typeof frameObj.content === "string"
        ? frameObj.content
        : typeof frameContent?.text === "string"
          ? frameContent.text
          : "",
        replyTo,
      );
      const sendAdmissionAck = (): void => {
        if (clientMessageId === null) return;
        const idempotencyKey = typeof frameObj.idempotencyKey === "string"
          ? frameObj.idempotencyKey
          : undefined;
        try {
          userWs.send(JSON.stringify({
            type: "outbound.ack",
            admitted: true,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            peer: { id: peerId, kind: "dm" },
            clientMessageId,
          }));
        } catch { /* durable admission remains replayable */ }
      };
      const sendRecoverySkippedAck = (reason: string): void => {
        if (clientMessageId === null) return;
        const idempotencyKey = typeof frameObj.idempotencyKey === "string"
          ? frameObj.idempotencyKey
          : undefined;
        try {
          if (skippedRecoveryIds.has(clientMessageId)) {
            turnLog?.info("user-chat-bridge: stopped legacy rejected-recovery retry loop", {
              sessionId: peerId,
              clientMessageId,
            });
          }
          skippedRecoveryIds.add(clientMessageId);
          userWs.send(JSON.stringify({
            type: "outbound.ack",
            recoverySkipped: true,
            recoverySkippedReason: reason,
            ...(isClientMessageId(recovery?.sourceClientMessageId)
              ? { sourceClientMessageId: recovery.sourceClientMessageId }
              : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
            peer: { id: peerId, kind: "dm" },
            clientMessageId,
          }));
          // Re-announce after the ACK has released the old client's local
          // dispatch slot. A stale bundle trapped in this rejected-recovery
          // loop can then hit the existing update governor's safe point and
          // reload instead of remaining permanently "busy".
          const feBuild = deps.getFrontendBuildId?.();
          if (feBuild) {
            userWs.send(JSON.stringify({ type: "sys.frontend_build", build: feBuild }));
          }
        } catch { /* the skipped optimistic row is also removable after REST sync */ }
      };
      let validatedRecovery: AdmitUserTurnInput["recovery"];
      if (rawRecovery !== undefined) {
        const sourceClientMessageId = recovery?.sourceClientMessageId;
        const mode = recovery?.mode;
        const automatic = recovery?.automatic;
        const rootClientMessageId = recovery?.rootClientMessageId;
        const attempt = recovery?.attempt;
        const max = recovery?.max;
        const keys = recovery ? Object.keys(recovery) : [];
        const legacyAutomatic = automatic === true &&
          rootClientMessageId === undefined && attempt === undefined && max === undefined;
        const normalizedRoot = legacyAutomatic ? sourceClientMessageId : rootClientMessageId;
        const normalizedAttempt = legacyAutomatic ? 1 : attempt;
        const identity = automatic === true && typeof normalizedRoot === "string" &&
            typeof normalizedAttempt === "number"
          ? turnRecoveryAttemptIdentity(peerId, normalizedRoot, normalizedAttempt)
          : typeof sourceClientMessageId === "string"
            ? turnRecoveryIdentity(peerId, sourceClientMessageId)
          : null;
        const allowedKeys = automatic === true && !legacyAutomatic
          ? ["sourceClientMessageId", "mode", "automatic", "rootClientMessageId", "attempt", "max"]
          : ["sourceClientMessageId", "mode", "automatic"];
        if (
          clientMessageId === null ||
          !isClientMessageId(sourceClientMessageId) ||
          (mode !== "checkpoint" && mode !== "replay") ||
          typeof automatic !== "boolean" ||
          (automatic === true && !legacyAutomatic && (
            !isClientMessageId(normalizedRoot) ||
            !Number.isSafeInteger(normalizedAttempt) ||
            Number(normalizedAttempt) < 1 ||
            Number(normalizedAttempt) > AUTOMATIC_TURN_RETRY_MAX ||
            max !== AUTOMATIC_TURN_RETRY_MAX
          )) ||
          keys.some((key) => !allowedKeys.includes(key)) ||
          identity?.clientMessageId !== clientMessageId ||
          identity?.idempotencyKey !== frameObj.idempotencyKey
        ) {
          turnLog?.warn("user-chat-bridge: invalid recovery lineage", {
            sessionId: peerId,
            clientMessageId,
          });
          sendRecoverySkippedAck("invalid_lineage");
          return null;
        }
        validatedRecovery = automatic
          ? {
              sourceClientMessageId,
              mode,
              automatic: true,
              rootClientMessageId: normalizedRoot as string,
              attempt: normalizedAttempt as number,
              max: AUTOMATIC_TURN_RETRY_MAX,
            }
          : { sourceClientMessageId, mode, automatic: false };
      }

      // The browser's optimistic POST is intentionally not a dispatch gate.
      // Make the server-side ordering invariant explicit here instead: the
      // authoritative user row must exist before route/acquire/precheck/
      // journal/history injection or any physical forward can happen.
      const useDispatchAdmission = containerHasDurableDispatch && deps.admitUserTurn !== undefined;
      if (validatedRecovery && !useDispatchAdmission) {
        sendRecoverySkippedAck("capability_unavailable");
        return null;
      }

      // B3(R3):本帧受理成功后落此(= 刚受理 dispatch 的 clientMessageId)。受理**之后**的任何 pre-forward
      // 失败出口(goal unavailable / sanitize 抛 / 任意异常 / 未预期早 return)必须据此 CAS terminal +
      // drop,否则留 admitted 永续租孤儿 + 无可见终态(违反 I1)。成功交棒调用方前置空(所有权移交)。
      let admittedThisFrame: string | null = null;
      let sessionWorkspaceMode: SessionWorkspaceMode | null = null;

      // 主会话历史**只读一次**,给「dispatch 受理前 dedup」与「受理/持久化后 enrichment」共用。
      // fail-open:读失败绝不阻断受理/转发(历史只是 UX 上下文,不是 authz/billing)。
      //   - dispatch 路径:受理**之前**读并 dedup(见下,避免孤儿 admitted dispatch);
      //   - legacy 路径:保持「先持久 user 行,再读历史」的既有顺序不变(权威 user 行先于历史注入)。
      let rawHistory: unknown[] | null = null;
      let historyLoaded = false;
      const ensureHistory = async (): Promise<void> => {
        if (historyLoaded) return;
        historyLoaded = true;
        if (!deps.loadMasterSessionMessages) return;
        try {
          let contextWindow: number | null = null;
          let engine = historyModel && isCodexEngineModel(historyModel) ? "codex" : "ccb";
          if (authorityDeps !== undefined) {
            if (historyModel === null) return;
            const execution = await resolveTurnExecution(authorityDeps.catalog, historyModel);
            contextWindow = projectContextWindowForRole(
              execution.canonicalModel,
              execution.descriptor.contextWindow,
              userRole,
            );
            engine = execution.engine;
          }
          const raw = await deps.loadMasterSessionMessages(uid, peerId, {
            contextWindow,
            engine,
            currentUserText,
            ...(clientMessageId ? { excludeClientMessageId: clientMessageId } : {}),
          });
          if (Array.isArray(raw)) rawHistory = raw;
        } catch (err) {
          turnLog?.warn("user-chat-bridge: load master history failed", {
            sessionId: peerId,
            err,
          });
        }
      };
      // 该 clientMessageId 是否早已产出 completed assistant 行(legacy 完成、无 dispatch;或
      // dispatch 已完成、tape 已 materialize)→ 回 dedup ack 收口。命中返 true(调用方 return null)。
      const tryDedupCompleted = async (): Promise<boolean> => {
        if (clientMessageId === null) return false;
        let alreadyCompleted = false;
        if (deps.hasCompletedClientTurn) {
          try {
            alreadyCompleted = await deps.hasCompletedClientTurn(uid, peerId, clientMessageId);
          } catch (err) {
            turnLog?.warn("user-chat-bridge: completed-turn lookup failed", {
              sessionId: peerId,
              clientMessageId,
              err,
            });
          }
        } else if (rawHistory !== null) {
          alreadyCompleted = rawHistory.some((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return false;
            const row = value as Record<string, unknown>;
            return row.role === "assistant" &&
              row._clientMessageId === clientMessageId &&
              row.status === "completed" &&
              row._errorCode === undefined &&
              row._isError !== true;
          });
        }
        if (!alreadyCompleted) return false;
        const idempotencyKey = typeof frameObj.idempotencyKey === "string"
          ? frameObj.idempotencyKey
          : undefined;
        try {
          userWs.send(JSON.stringify({
            type: "outbound.ack",
            deduplicated: true,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            peer: { id: peerId, kind: "dm" },
            clientMessageId,
          }));
        } catch { /* client left; durable response remains syncable */ }
        turnLog?.info("user-chat-bridge: completed client turn deduplicated", {
          sessionId: peerId,
          clientMessageId,
        });
        return true;
      };

      // ── legacy-completed dedup(B10)——dispatch 路径**受理之前**判定 ─────────
      // 若先受理再 dedup,会留下一条永不终态化的孤儿 admitted dispatch —— reconciler 之后会把它
      // reject-if-absent 成 not_accepted、给用户弹一张假 error 卡(RFC B10 根因)。放到受理前:dedup
      // 走 return 不转发任何帧,故**不破坏「受理先于一切」不变量**(该不变量约束的是"转发前 user 行必须在")。
      // legacy 路径(无 admitUserTurn)不建 dispatch 行、无孤儿风险 → 保持既有「持久后再 dedup」顺序。
      if (persistUserRow && useDispatchAdmission && clientMessageId !== null) {
        // The indexed completion authority replaces the old full-history
        // hydration. Legacy/test compositions without it rely on dispatch
        // admission's own idempotency result instead of reading the tape here.
        if (cleaned) return null;
        if (await tryDedupCompleted()) return null;
      }

      // persistUserRow=false(prompt-queue lane)整块跳过:queue 协调器已建 user 行 + turn 权威,
      // 此处再走 admit/persist 会造成 turn_dispatches 与 queue lifecycle 双权威(权威源分裂)。
      if (persistUserRow && clientMessageId !== null && (useDispatchAdmission || deps.persistMasterUserMessage)) {
        const content = frameObj.content && typeof frameObj.content === "object"
          ? frameObj.content as {
              text?: unknown;
              displayText?: unknown;
              media?: unknown;
              imageEdit?: unknown;
              replyTo?: unknown;
            }
          : {};
        const rawMedia = Array.isArray(content.media) ? content.media : [];
        const persistedMedia = rawMedia.filter((item) =>
          !item || typeof item !== "object" || (item as { hidden?: unknown }).hidden !== true);
        const modelText = typeof frameObj.content === "string"
          ? frameObj.content
          : typeof content.text === "string"
            ? content.text
            : "";
        const displayText = typeof content.displayText === "string"
          ? content.displayText
          : modelText;
        const rawImageEdit = content.imageEdit && typeof content.imageEdit === "object" &&
          !Array.isArray(content.imageEdit)
          ? content.imageEdit as Record<string, unknown>
          : undefined;
        const routing = {
          ...(typeof frameObj.model === "string" && frameObj.model !== ""
            ? { model: frameObj.model }
            : {}),
          ...(typeof frameObj.modelSwitchId === "string"
            ? { modelSwitchId: frameObj.modelSwitchId }
            : {}),
          teamMode: frameObj.teamMode === true,
          effortLevel: typeof frameObj.effortLevel === "string" || frameObj.effortLevel === null
            ? frameObj.effortLevel
            : null,
        };
        const message = {
          id: clientMessageId,
          role: "user" as const,
          text: displayText,
          ts: typeof frameObj.ts === "number" && Number.isFinite(frameObj.ts)
            ? frameObj.ts
            : Date.now(),
          ...(persistedMedia.length > 0 ? { _media: persistedMedia } : {}),
          ...(rawImageEdit && rawMedia.length > 0 ? { _retryMedia: rawMedia } : {}),
          ...(rawImageEdit ? { _imageEdit: rawImageEdit } : {}),
          ...(displayText !== modelText ? { _modelText: modelText } : {}),
          ...(replyTo ? { _replyTo: replyTo } : {}),
          _routing: routing,
        };
        if (useDispatchAdmission && deps.admitUserTurn) {
          // ── durable turn dispatch 受理(RFC §2.1)── 替代 persist retry loop。
          // 单事务:幂等 append user 行 → UPSERT dispatch 冲突表裁定。billingRequestId 与
          // envelope payloadHash 均在此确定;'admitted' 落 admittedDispatches(接管复用旧
          // billingRequestId,故读 result.dispatch.* 而非本地铸值)。
          const admitModel = typeof frameObj.model === "string" && frameObj.model !== ""
            ? frameObj.model
            : null;
          const admitAgentId = typeof frameObj.agentId === "string" && frameObj.agentId !== ""
            ? frameObj.agentId
            : "main";
          // requestHash 权威 = protocol.computeDispatchRequestHash(frame.content);容器
          // gateway 用同一函数对同一 content 重算并断言,故此处**必须**同源(不可自铸 sha256)。
          const requestHash = computeDispatchRequestHash(
            frameObj.content as DispatchRequestContent | null | undefined,
          );
          const dispatchId = randomUUID();
          const billingRequestId = ensureRequestIdServerSide();
          let admit: AdmitUserTurnResult;
          try {
            admit = await deps.admitUserTurn({
              uid,
              sessionUserId: "c:" + uid.toString(),
              sessionId: peerId,
              clientMessageId,
              agentId: admitAgentId,
              model: admitModel,
              requestHash,
              billingRequestId,
              dispatchId,
              ownerId: connId,
              message,
              ...(validatedRecovery ? { recovery: validatedRecovery } : {}),
              ...(recoveryJob ? {
                recoveryJob: {
                  jobId: recoveryJob.jobId,
                  leaseOwner: recoveryJob.leaseOwner,
                  leaseEpoch: recoveryJob.leaseEpoch,
                },
              } : {}),
            });
          } catch (err) {
            turnLog?.error("user-chat-bridge: dispatch admission threw", {
              sessionId: peerId, clientMessageId, err,
            });
            sendErrorFrame(
              userWs,
              "SESSION_PERSIST_UNAVAILABLE",
              "user message could not be durably admitted; retry safely",
              { peerId, clientMessageId },
            );
            return null;
          }
          if ("workspaceMode" in admit) {
            sessionWorkspaceMode = parseSessionWorkspaceMode(admit.workspaceMode);
          }
          // R4-B1:cleaned 检查**不得**早于 admitted 接管 —— admit await 期间连接可能已 cleanup,
          // 提交成功的 dispatch 若在登记前 early return 就成了孤儿 lease(admitted 永续租、无
          // durable status)。顺序铁律:先接管所有权,再判连接死活;死了立即终态化。
          switch (admit.kind) {
            case "admitted": {
              const d = admit.dispatch;
              admittedDispatches.set(clientMessageId, {
                clientMessageId,
                sessionId: peerId,
                dispatchId: d.dispatchId,
                billingRequestId: d.billingRequestId,
                attemptNo: d.attemptNo,
                leaseEpoch: d.leaseEpoch,
                anchorSeq: d.anchorSeq,
                requestHash,
                ...(recoveryJob ? { recoveryJob } : {}),
              });
              // B3(R3):标记本帧已受理 —— 受理后任何 pre-forward 失败出口据此终态化(下方 try/finally)。
              admittedThisFrame = clientMessageId;
              if (cleaned) {
                failDispatchPreForward(
                  admittedDispatches.get(clientMessageId),
                  "bridge_closed_during_admission",
                );
                admittedThisFrame = null;
                return null;
              }
              // Browser may clear its exact replay journal only after this
              // transaction-backed admission boundary, never after ws.send().
              sendAdmissionAck();
              // R5 note:heartbeat 只在确认连接存活后才起 —— finalCleanup 已跑过的话,此刻新建的
              // interval 无人清理,会把整个 bridge 闭包钉在内存里。顺序=登记→cleaned→heartbeat。
              ensureDispatchHeartbeat();
              // MIN1:受理成功后回填 turn_traces 的纯展示列(fire-and-forget,不动主链)。
              if (traceId !== null) {
                updateTurnTraceDispatch(deps.pgPool, (msg, fields) => turnLog?.warn(msg, fields), {
                  traceId,
                  dispatchId: d.dispatchId,
                  requestId: d.billingRequestId,
                });
              }
              break; // 继续 enrichment / forward
            }
            case "deduplicated": {
              const idempotencyKey = typeof frameObj.idempotencyKey === "string"
                ? frameObj.idempotencyKey
                : undefined;
              try {
                userWs.send(JSON.stringify({
                  type: "outbound.ack",
                  deduplicated: true,
                  ...(idempotencyKey ? { idempotencyKey } : {}),
                  peer: { id: peerId, kind: "dm" },
                  clientMessageId,
                }));
              } catch { /* client left; durable response remains syncable */ }
              turnLog?.info("user-chat-bridge: dispatch deduplicated", {
                sessionId: peerId, clientMessageId,
              });
              return null;
            }
            case "already_owned":
            case "in_flight":
              // Exact same logical turn is already durable. Treat a browser
              // reload/reconnect replay as admitted instead of a visible busy
              // error; the existing owner/recovery path remains authoritative.
              sendAdmissionAck();
              return null;
            case "previously_failed":
              sendErrorFrame(
                userWs, "TURN_PREVIOUSLY_FAILED",
                "this message previously failed; resend to retry",
                { peerId, clientMessageId },
              );
              return null;
            case "manual_hold":
              sendErrorFrame(
                userWs, "TURN_MANUAL_HOLD", "正在人工核对，请稍后",
                { peerId, clientMessageId },
              );
              return null;
            case "immutable_conflict":
              sendErrorFrame(
                userWs, "TURN_IMMUTABLE_CONFLICT",
                "message content changed for the same id",
                { peerId, clientMessageId },
              );
              return null;
            case "recovery_conflict":
              turnLog?.info("user-chat-bridge: recovery skipped after atomic lineage check", {
                sessionId: peerId,
                clientMessageId,
                reason: admit.reason,
              });
              sendRecoverySkippedAck(admit.reason);
              return null;
            case "session_not_found":
            case "session_deleted":
            case "append_error":
              turnLog?.warn("user-chat-bridge: dispatch admission unavailable", {
                sessionId: peerId, clientMessageId, kind: admit.kind,
              });
              sendErrorFrame(
                userWs, "SESSION_PERSIST_UNAVAILABLE",
                "user message could not be durably admitted; retry safely",
                { peerId, clientMessageId },
              );
              return null;
            default: {
              const _exhaustive: never = admit;
              turnLog?.error("user-chat-bridge: unhandled dispatch admission kind", {
                kind: (admit as { kind?: string }).kind,
              });
              void _exhaustive;
              sendErrorFrame(
                userWs, "SESSION_PERSIST_UNAVAILABLE",
                "user message could not be durably admitted; retry safely",
                { peerId, clientMessageId },
              );
              return null;
            }
          }
        } else if (deps.persistMasterUserMessage) {
          let persisted = false;
          let lastReason: string | undefined;
          const retryDelays = [0, 50, 150];
          for (const delayMs of retryDelays) {
            if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            if (cleaned) return null;
            try {
              const result = await deps.persistMasterUserMessage(uid, peerId, message);
              if (result.applied || result.reason === "already_exists") {
                sessionWorkspaceMode = parseSessionWorkspaceMode(result.workspaceMode);
                persisted = true;
                break;
              }
              lastReason = result.reason;
              // Only the known PUT-vs-WS creation race is retryable here.
              if (result.reason !== "session_not_found") break;
            } catch (err) {
              lastReason = (err as Error)?.message ?? String(err);
              break;
            }
          }
          if (!persisted) {
            onReject?.("SESSION_PERSIST_UNAVAILABLE");
            turnLog?.warn("user-chat-bridge: persist user row before forward failed", {
              sessionId: peerId,
              clientMessageId,
              reason: lastReason,
            });
            sendErrorFrame(
              userWs,
              "SESSION_PERSIST_UNAVAILABLE",
              "user message could not be durably admitted; retry safely",
              { peerId, clientMessageId },
            );
            return null;
          }
        }
      }

      // enrichment:dispatch 路径复用受理前已读的 rawHistory;legacy 路径此刻(持久之后)才首读,
      // 保持「权威 user 行先于历史读/注入」的既有顺序。ensureHistory 幂等,不会二次查库。
      // B3(R3):从此处到 return enriched 是「受理之后、转发之前」窗口。任何异常/早 return 出口都必须
      // 终态化本帧受理的 dispatch —— try/finally 收口:成功交棒前置空 admittedThisFrame(所有权移交
      // 调用方,由它 lookupAdmittedDispatch 后走 failDispatchPreForward);未交棒即离开 → CAS terminal。
      try {
        if (sessionWorkspaceMode === null) {
          if (deps.loadSessionWorkspaceMode) {
            try {
              sessionWorkspaceMode = await deps.loadSessionWorkspaceMode(uid, peerId);
            } catch (err) {
              turnLog?.error("user-chat-bridge: load session workspace mode failed", {
                sessionId: peerId,
                err,
              });
            }
            if (sessionWorkspaceMode === null) {
              onReject?.("SESSION_WORKSPACE_UNAVAILABLE");
              sendErrorFrame(
                userWs,
                "SESSION_WORKSPACE_UNAVAILABLE",
                "session workspace unavailable; retry this turn shortly",
                { peerId, clientMessageId },
              );
              return null;
            }
          } else {
            // Non-commercial/legacy compositions have no PG workspace column.
            sessionWorkspaceMode = "legacy";
          }
        }
        await ensureHistory();
        // legacy 路径的 dedup 在持久之后判定(dispatch 路径已在受理前 dedup,useDispatchAdmission 分支
        // 内 tryDedupCompleted 已消费;此处仅对 legacy 生效,避免二次 dedup 同一轮)。
        if (!useDispatchAdmission && await tryDedupCompleted()) return null;
        let enriched: Record<string, unknown> = {
          ...frameObj,
          _workspaceMode: sessionWorkspaceMode,
        };
        if (rawHistory !== null) {
          const historical = _sanitizeMasterHistoricalMessagesForFrame(rawHistory, {
            ...(clientMessageId ? { excludeClientMessageId: clientMessageId } : {}),
          });
          if (historical.length > 0) {
            turnLog?.info("user-chat-bridge: attached master history", {
              sessionId: peerId,
              messageCount: historical.length,
            });
            enriched = { ...enriched, _masterHistoricalMessages: historical };
          }
        }
        if (deps.loadGoalState) {
          // 二分语义收敛到 resolveTurnGoalState 单一权威(NOT_FOUND=确定性放行 vs 其它=拒轮);
          // 副作用(错误帧/日志/回滚)仍留在此调用点。见该函数头注释。
          const resolved = await resolveTurnGoalState(deps.loadGoalState, uid, peerId);
          if (resolved.kind === "unavailable") {
            // prompt-queue lane:回执让协调器取消 grant(browser lane 无 dispatchRequest → no-op)。
            onReject?.("GOAL_STATE_UNAVAILABLE");
            // Goal attribution is part of the paid turn's durable authority. A
            // transient PG read failure must not be converted to `null`: doing so
            // would run the turn without goal_id and make later repair impossible.
            // Reject this turn before it reaches the container; Codex callers that
            // already reserved billing/slots unwind through their existing
            // pre-forward compensation path.
            turnLog?.error("user-chat-bridge: load platform goal failed; turn rejected", {
              sessionId: peerId,
              err: resolved.err,
            });
            if (!cleaned && userWs.readyState === WebSocket.OPEN) {
              sendErrorFrame(
                userWs,
                "GOAL_STATE_UNAVAILABLE",
                "goal state unavailable, retry this turn shortly",
                { peerId, clientMessageId },
              );
            }
            // B3(R3):受理后 goal 出口 —— 就地终态化(明确失败码),置空后 finally 不再重复。
            if (admittedThisFrame !== null) {
              failDispatchPreForward(admittedDispatches.get(admittedThisFrame), "goal_state_unavailable");
              admittedThisFrame = null;
            }
            return null;
          }
          // NOT_FOUND → resolved.goalState===null(放行,归因仍可修复);否则真实快照。
          enriched = { ...enriched, _goalState: resolved.goalState };
        }
        // 成功:所有权移交调用方(它据返回帧 lookupAdmittedDispatch 后接管 pre-forward 终态化)。
        admittedThisFrame = null;
        return enriched;
      } finally {
        // 未交棒即离开(sanitize/goal 读抛 / 任何未预期早 return)→ 终态化,绝不留孤儿 admitted。
        // casToTerminal 幂等(CAS on epoch),即便调用方 catch 再兜底一次也安全。
        if (admittedThisFrame !== null) {
          failDispatchPreForward(admittedDispatches.get(admittedThisFrame), "history_injection_failed");
        }
      }
    };

    // Both the browser legacy lane and the internal PG dispatch grant enter
    // this one preparation pipeline. Consequently catalog/epoch fencing,
    // Codex slot acquisition, preCheck, journal creation and authority sealing
    // cannot diverge between the two paths.
    const executeAdmittedTurn = (
      data: RawData,
      isBinary: boolean,
      ingress: "browser" | "prompt_queue" | "recovery" = "browser",
      dispatchRequest?: PromptQueueDispatchRequest,
      recoveryJob?: ClaimedRecoveryJob,
      receivedAtMs = Date.now(),
    ): void => {
      const isPromptQueueDispatch = ingress === "prompt_queue";
      let promptQueueResolved = false;
      let promptQueueFallbackTimer: ReturnType<typeof setTimeout> | null = null;
      const rejectPromptQueueDispatch = (reasonCode: string): void => {
        if (recoveryJob && deps.pgPool) {
          void releaseRecoveryForTransportWait(deps.pgPool, recoveryJob).catch(() => {});
        }
        if (!dispatchRequest || promptQueueResolved) return;
        promptQueueResolved = true;
        if (promptQueueFallbackTimer !== null) clearTimeout(promptQueueFallbackTimer);
        const result: PromptQueueDispatchResult = {
          type: PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
          grantId: dispatchRequest.grantId,
          owner: dispatchRequest.owner,
          itemId: dispatchRequest.item.itemId,
          contentHash: dispatchRequest.item.contentHash,
          epoch: dispatchRequest.claim.epoch,
          claimToken: dispatchRequest.claim.claimToken,
          outcome: "rejected",
          disposition: promptQueueDispositionForCode(reasonCode),
          reasonCode,
        };
        const encoded = Buffer.from(JSON.stringify(result), "utf8");
        forwardInboundFrame(encoded, false, encoded.length);
      };
      const forwardPreparedFrame = (
        frameData: RawData,
        frameIsBinary: boolean,
        frameLength: number,
      ): boolean | Promise<boolean> => {
        // `rejectPromptQueueDispatch` is also the cancellation edge. Every
        // async preparation lane funnels through this helper, so a timeout or
        // earlier negative result prevents a late physical execution. Codex
        // callers observe `false` and run their existing slot/journal/precheck
        // compensation before returning.
        if (dispatchRequest && promptQueueResolved) return false;
        const completeForward = (accepted: boolean): boolean => {
          if (accepted && dispatchRequest && !promptQueueResolved) {
            promptQueueResolved = true;
            if (promptQueueFallbackTimer !== null) clearTimeout(promptQueueFallbackTimer);
          }
          return accepted;
        };
        if (!recoveryJob || !deps.pgPool) {
          return completeForward(forwardInboundFrame(frameData, frameIsBinary, frameLength));
        }
        const record = [...admittedDispatches.values()].find(
          (candidate) => candidate.recoveryJob?.jobId === recoveryJob.jobId,
        );
        if (!record) return false;
        return forwardRecoveryUnderRootFence(
          deps.pgPool,
          {
            job: recoveryJob,
            dispatchId: record.dispatchId,
            dispatchAttemptNo: record.attemptNo,
            dispatchOwner: connId,
            dispatchLeaseEpoch: record.leaseEpoch,
          },
          () => forwardInboundFrame(frameData, frameIsBinary, frameLength),
        ).then(
          (accepted) => {
            if (!accepted) failDispatchPreForward(record, "recovery_forward_fenced");
            return completeForward(accepted);
          },
          (error) => {
            bridgeLog?.warn("user-chat-bridge: recovery forward fence failed", {
              jobId: recoveryJob.jobId,
              error,
            });
            failDispatchPreForward(record, "recovery_forward_fence_failed");
            return false;
          },
        );
      };
      const len = rawDataLen(data);
      if (len > maxFrameBytes) {
        rejectPromptQueueDispatch("ERR_FRAME_TOO_BIG");
        sendErrorFrame(userWs, "ERR_FRAME_TOO_BIG",
          `user frame ${len} > max ${maxFrameBytes}`);
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
        // 用户协议错 → force final,不为它 drain
        cleanup("frame_too_big", true);
        return;
      }
      // ── attestation 门(方案 §7 步 4)────────────────────────────────────────
      // 未 attest 前**缓冲**用户帧 —— 三个选项里只有这个是对的:
      //   - 放行 → 容器可能是旧的(不认 envelope,按 baked 判定跑)= 判定源分裂;
      //   - 丢弃 → 用户的第一条消息静默消失;
      //   - 缓冲 → attest 到达即原样重放(容器 open 后立刻 attest,实际延迟 ~ms)。
      // 有界(maxBufferedBytes)+ 有超时(attestTimeoutMs)—— 缓冲不是无限等待。
      if (authorityOn && attestState !== "ok") {
        if (attestState === "failed") return; // 连接已判死(close 在飞),丢弃
        if (attestQueuedBytes + len > maxBufferedBytes) {
          // 背压=连接态瞬态信号:只走 close code,不发 turn 级 error 帧。
          try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
          cleanup("backpressure", true);
          return;
        }
        attestQueuedBytes += len;
        attestQueue.push({ data, isBinary, ingress, dispatchRequest, recoveryJob });
        return;
      }
      if (dispatchRequest) {
        promptQueueFallbackTimer = setTimeout(
          () => rejectPromptQueueDispatch("DISPATCH_PREPARATION_TIMEOUT"),
          promptQueuePreparationTimeoutMs,
        );
        promptQueueFallbackTimer.unref?.();
      }
      let passthroughData: RawData = data;
      let passthroughLen = len;
      // 0049 模型授权(plan v3 §B3/§B4 + review v1/v2 follow-up)+ P0 计费旁路
      // 封堵(agent 权威推导):
      //   inbound.message 帧 sync 检查 visibility OR per-user grants。优先级:
      //     (1) frame.model — 用户/前端显式声明 → 必须有授权
      //     (2) AGENT_AUTHZ_IMPLIED_MODEL[frame.agentId] — agentId 隐含 model
      //         (review v2 finding 1:防 agentId='codex' 不带 model 绕过)
      //     (3) agentModelResolverHandle.resolve(frame.agentId) — master agent
      //         权威推导「该 agent 的有效模型」(P0:帧无 model 时容器回落
      //         agent.model 判 engine,bridge 必须同构分类);带 agentId 但推导
      //         不出且帧无 model → fail-closed 拒帧(不放行、不猜)
      //     (4) lastSeenModelId — 本桥之前出现过的 model(review v1 follow-up:
      //         防"已用 gpt-5.5 跑起来的桥被撤销 grant 后,后续无 model/agentId
      //         的 delta 帧仍能透传"。一旦撤销,继续帧都被拦;仅辅助兜底,
      //         不作 codex 分类的唯一权威)
      //     (5) 全无 → 透传(本桥从没碰过受限 model,默认 claude-* visibility=
      //         public 不需要 grant)
      //
      //   命中 (1) / (2) 时也更新 lastSeenModelId — 任一形式提到过受限 model
      //   都进入"本桥追踪"状态。
      //
      //   modelChecker 内部由周期 refresh 在背后更新(GRANTS_REFRESH_INTERVAL_MS),
      //   admin 取消授权后下一次 frame check 会用最新快照拦帧。
      //
      //   只检查 text 帧 + JSON parsable + type==='inbound.message'。binary 帧 /
      //   非 JSON / 其他类型 → 透传(不校验)。server.ts ALLOWED_INBOUND_MODELS +
      //   inferAgentForModel fail-closed 是 server 端兜底。
      //
      //   这条 check **故意没 try/catch** 套整个 if 块:JSON.parse 异常下面已处理,
      //   isAllowed 是纯同步(canUseModel 读 PricingCache cache 命中即返),异常仅
      //   可能来自代码 bug,不该静默吞。
      // 把 effectiveModel / 是否 codex 帧 提到外层,后面 codex slot 路径要用
      let effectiveModelForFrame: string | null = null;
      // 模型执行权威签发用的 model(= effectiveModel,帧完全无线索时回落默认 agent 的模型)。
      let authorityModelForFrame: string | null = null;
      let isCodexInboundFrame = false;
      let isCursorInboundFrame = false;
      let isZcodeInboundFrame = false;
      let isAnnotatedImageInboundFrame = false;
      // Session-scoped Codex admission key. Outbound terminal frames match this
      // peer plus clientMessageId; missing peer falls back to a bridge-local
      // sentinel and therefore only has timeout/cleanup release safety.
      let inboundPeerIdForFrame: string | null = null;
      let inboundTurnIdentityForFrame: InboundTurnIdentity = { peerId: null, clientMessageId: null };
      // PR2 v1.0.66 — 把 codex 计费需要用到的 frame 字段提到外层(下面 IIFE 用):
      //   inboundParsedFrame:rewrite 帧塞 server requestId 时复用,免再次 JSON.parse
      //   inboundAgentIdForFrame:agent_cost_overrides 查 multiplier 时用,缺省回退 'codex'
      let inboundParsedFrame: Record<string, unknown> | null = null;
      let inboundAgentIdForFrame: string | null = null;
      // CG2a — 强制 canonical trace。inbound.message 命中时由 master 生成,后续
      // forwardInboundFrame 读注入到 frame.traceId。其他帧(hello / repo_bind /
      // 非 JSON / binary)保持 null,走原 raw 透传(不 rewrite)。
      let turnTraceIdForFrame: string | null = null;
      // CG2b — turn-scoped logger:inbound.message 命中时基于 bridgeLog 派生(child binding 加
      // traceId)。同步与 turnTraceIdForFrame 一起 set / 一起 null,codex IIFE / 非 codex
      // forwardInboundFrame 内的 log call 都用它,不必手写 uid/connId/traceId。
      let turnLogForFrame: Logger | null = null;
      if (!isBinary) {
        let frameStr: string | null = null;
        if (typeof data === "string") frameStr = data;
        else if (Buffer.isBuffer(data)) {
          try { frameStr = data.toString("utf8"); } catch { frameStr = null; }
        }
        if (frameStr !== null) {
          let parsed: unknown = null;
          try { parsed = JSON.parse(frameStr); } catch { /* 非 JSON 帧透传 */ }

          // ── 模型执行权威:一切入口的**第一动作** = 无条件 strip 同名字段(方案 §2)──
          // 客户端自带的 `__oc_model_authority` 必须先死,再谈注入。这里 strip 的是
          // **解析后的对象**;下面所有 inbound.message 路径都从它重新序列化转发,
          // 因此原始 raw(带伪造字段)不会被透传。非 inbound.message 的 JSON 帧若带了
          // 该字段,也在此处剥离后重新序列化(passthrough 不再用原 raw)—— 容器侧只在
          // inbound.message 上消费 authority,但"入口无条件 strip"是一条不留缺口的铁律。
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            const parsedObj = parsed as Record<string, unknown>;
            // Browser never authors platform GoalState or the master-only sync
            // control frame. Strip the former and drop the latter before any
            // async enrichment/forwarding.
            if (Object.prototype.hasOwnProperty.call(parsedObj, "_goalState")) {
              delete parsedObj._goalState;
              const strippedStr = JSON.stringify(parsedObj);
              passthroughData = Buffer.from(strippedStr, "utf8");
              passthroughLen = Buffer.byteLength(strippedStr);
            }
            if (parsedObj.type === "inbound.goal_sync") {
              bridgeLog?.warn("user-chat-bridge: browser goal sync frame dropped");
              return;
            }
            if (Object.prototype.hasOwnProperty.call(parsedObj, MODEL_AUTHORITY_FIELD)) {
              stripModelAuthorityField(parsedObj);
              bridgeLog?.warn("user-chat-bridge: client-supplied model authority field stripped");
              const strippedStr = JSON.stringify(parsedObj);
              passthroughData = Buffer.from(strippedStr, "utf8");
              passthroughLen = Buffer.byteLength(strippedStr);
            }
            // durable dispatch envelope 同理:裸 wire 字段可被容器内同 uid 进程伪造 →
            // 无条件先剥离,bridge 后续再按受理记录重新注入(RFC §2.2)。
            if (Object.prototype.hasOwnProperty.call(parsedObj, DISPATCH_AUTHORITY_FIELD)) {
              stripDispatchAuthorityField(parsedObj);
              bridgeLog?.warn("user-chat-bridge: client-supplied dispatch authority field stripped");
              const strippedStr = JSON.stringify(parsedObj);
              passthroughData = Buffer.from(strippedStr, "utf8");
              passthroughLen = Buffer.byteLength(strippedStr);
            }
            // The grant correlation is created only by the internal dispatch
            // request handler below. A browser-authored lookalike must die before
            // it can reach the container coordinator.
            if (
              !isPromptQueueDispatch &&
              Object.prototype.hasOwnProperty.call(parsedObj, PROMPT_QUEUE_GRANT_FIELD)
            ) {
              delete parsedObj[PROMPT_QUEUE_GRANT_FIELD];
              bridgeLog?.warn("user-chat-bridge: client-supplied prompt queue grant stripped");
              const strippedStr = JSON.stringify(parsedObj);
              passthroughData = Buffer.from(strippedStr, "utf8");
              passthroughLen = Buffer.byteLength(strippedStr);
            }
          }

          // Stop and permission responses are Master-owned durable controls,
          // not best-effort websocket writes.  Commit first, acknowledge the
          // persisted state to every tab, then let the lease drainer perform
          // runtime delivery.  Legacy/test compositions without PG retain the
          // transparent path during rolling deployment.
          if (
            !isPromptQueueDispatch && deps.pgPool && parsed !== null &&
            typeof parsed === "object" && !Array.isArray(parsed)
          ) {
            const controlFrame = parsed as Record<string, unknown>;
            const controlType = controlFrame.type;
            if (
              controlType === "inbound.control.stop" ||
              controlType === "inbound.permission_response"
            ) {
              const peer = isPlainRecord(controlFrame.peer) ? controlFrame.peer : null;
              const sessionId = peer && typeof peer.id === "string" ? peer.id : null;
              if (sessionId === null) return;
              const kind = controlType === "inbound.control.stop" ? "stop" : "permission";
              const controlId = isControlId(controlFrame.controlId)
                ? controlFrame.controlId
                : `control-${randomUUID()}`;
              const rootClientMessageId = isClientMessageId(controlFrame.clientMessageId)
                ? controlFrame.clientMessageId
                : null;
              const requestId = kind === "permission" && typeof controlFrame.requestId === "string"
                ? controlFrame.requestId
                : null;
              if (kind === "permission" && requestId === null) return;
              const durablePayload = { ...controlFrame, controlId };
              void (async () => {
                try {
                  const admission = await admitDurableControl(deps.pgPool!, {
                    controlId,
                    userId: uid,
                    sessionId,
                    rootClientMessageId,
                    kind,
                    requestId,
                    payload: durablePayload,
                  });
                  broadcastToUser(uid, {
                    type: "outbound.control.receipt",
                    controlId,
                    controlKind: kind,
                    status: admission.status === "terminal" ? "terminal" : "persisted",
                    peer,
                    ...(rootClientMessageId ? { clientMessageId: rootClientMessageId } : {}),
                    ...(requestId ? { requestId } : {}),
                  });
                  if (admission.status === "pending" || admission.status === "leased") {
                    await drainDurableControlsForUser(uid);
                  }
                } catch (error) {
                  const conflict = error instanceof TurnControlConflictError;
                  const errorCode = conflict ? error.code : "CONTROL_PERSIST_UNAVAILABLE";
                  bridgeLog?.warn("user-chat-bridge: durable control admission failed", {
                    controlId,
                    kind,
                    errorCode,
                  });
                  if (conflict) {
                    broadcastToUser(uid, {
                      type: "outbound.control.receipt",
                      controlId,
                      controlKind: kind,
                      status: "terminal",
                      peer,
                      ...(rootClientMessageId ? { clientMessageId: rootClientMessageId } : {}),
                      ...(requestId ? { requestId } : {}),
                      errorCode,
                    });
                  } else if (userWs.readyState === WebSocket.OPEN) {
                    // A storage outage is not a terminal control outcome. Keep
                    // the browser journal authoritative and force reconnect so
                    // the exact same controlId is replayed after PG recovers.
                    try { userWs.close(CLOSE_BRIDGE.SERVER_RESTART, "control_persist_unavailable"); } catch { /* */ }
                  }
                }
              })();
              return;
            }
          }

          // Phase 4 — GitHub session-repo bind 帧:bridge 富化 + forward
          //   inbound 帧只带 sessionId/version/peer/agentId/channel(token 不在前端);
          //   bridge 用 deps.pgPool 查 selection + link,组装完整 bind 帧再推容器。
          //   错误(stale / link revoked / DB 故障)→ outbound.control.session_repo_bind_error
          //   发回 userWs,**不**转发给容器(防止容器陷在 pending)。
          //   pgPool 未注入(测试)→ skip 富化,**不**透传(防泄漏 raw bind 请求帧到
          //   容器,容器没 token 也处理不了)。
          if (parsed !== null && typeof parsed === "object") {
            const ftype = (parsed as { type?: unknown }).type;
            if (ftype === "inbound.control.session_repo_bind") {
              const bindReq = parseBindRequest(parsed);
              if (bindReq === null) {
                if (userWs.readyState === WebSocket.OPEN) {
                  try {
                    userWs.send(JSON.stringify({
                      type: "outbound.control.session_repo_bind_error",
                      sessionId: typeof (parsed as { sessionId?: unknown }).sessionId === "string"
                        ? (parsed as { sessionId: string }).sessionId
                        : "",
                      selectionVersion: 0,
                      errorCode: "INVALID_BIND_PAYLOAD",
                      errorMessage: "bind frame schema invalid",
                    }));
                  } catch { /* */ }
                }
                return;
              }
              const pgPool = deps.pgPool;
              if (!pgPool) {
                // 生产环境 pgPool 必注入;走到这只能是测试 mock,丢弃且不透传。
                return;
              }
              // async 富化;不阻塞主循环。富化期间 main message 帧可能继续走,
              // bind 因 DB query 抢晚到容器是可接受的(plan v3 修 #4 — 容器侧 bind/
              // message 乱序处理)。
              ;(async () => {
                try {
                  const result = await enrichBindRequest(pgPool, Number(uid), bindReq);
                  if (result.type === "outbound.control.session_repo_bind_error") {
                    if (userWs.readyState === WebSocket.OPEN) {
                      try { userWs.send(JSON.stringify(result)); } catch { /* */ }
                    }
                    return;
                  }
                  // 富化成功 → forward enriched 到容器
                  const enrichedJson = JSON.stringify(result);
                  const buf = Buffer.from(enrichedJson, "utf8");
                  forwardInboundFrame(buf, false, buf.length);
                  // v1.0.94 — 诊断 instrument。bind 帧是关键侧信道,4 个 hop
                  // (前端 → master bridge → 容器 → workspace)只有任一段沉默都会让
                  // 用户卡在「准备中…」。这里记录 bridge → 容器这一段是否真的发出。
                  bridgeLog?.info("user-chat-bridge: repo_bind_forwarded", {
                    sessionId: result.sessionId,
                    selectionVersion: result.selectionVersion,
                    agentId: result.agentId,
                  });
                } catch (err) {
                  bridgeLog?.warn("user-chat-bridge: enrich bind failed", { err });
                  if (userWs.readyState === WebSocket.OPEN) {
                    try {
                      userWs.send(JSON.stringify({
                        type: "outbound.control.session_repo_bind_error",
                        sessionId: bindReq.sessionId,
                        selectionVersion: bindReq.selectionVersion,
                        errorCode: "BRIDGE_ENRICH_FAILED",
                        errorMessage: "internal error during bind enrichment",
                      }));
                    } catch { /* */ }
                  }
                }
              })();
              return; // 同步路径不再 forward 原始帧;async 完成后才推富化版
            }
            if (ftype === "inbound.control.session_repo_unbind") {
              const unbindReq = parseUnbindRequest(parsed);
              if (unbindReq === null) {
                // schema 错 → 静默丢(没必要给前端报错,unbind 是用户操作不应失败)
                return;
              }
              // unbind 不需要富化,直接透传(走 forwardInboundFrame 后续逻辑)
              // fall through to forwardInboundFrame below
            }
          }

          // Phase 0.4 — inbound.hello → bridge ring replay.
          //
          // Each peer in the hello carries `lastFrameSeq` (last outbound seq
          // the tab successfully processed). We peekReplay against the
          // bridge-layer ring; if it satisfies, push the missed frames over
          // userWs. If it can't, emit `outbound.resume_failed` so the client
          // escalates to REST sync (matches personal-master server.ts
          // autoResumeFromHello envelope verbatim — same shape as what the
          // container would have emitted).
          //
          // We do NOT return here: hello must still reach the container so
          // its embedded gateway registers `bridge.containerWs` into
          // `clientsByPeer` for live delivery. Container's own peekReplay
          // may also fire — duplicate frames are deduped client-side via
          // the frameSeq cursor in websocket.js handleOutbound.
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            (parsed as { type?: unknown }).type === "inbound.hello" &&
            containerId !== undefined
          ) {
            const helloPeers = (parsed as { peers?: unknown }).peers;
            const peers = Array.isArray(helloPeers) ? helloPeers : [];
            const rawClientBuild = (parsed as { clientBuild?: unknown }).clientBuild;
            if (typeof rawClientBuild === "string" && /^[0-9a-f]{8,32}$/.test(rawClientBuild)) {
              clientBuildForConnection = rawClientBuild;
            }
            const visiblePeers = peers.filter((p) => {
              if (typeof p !== "object" || p === null) return true;
              return (p as { agentId?: unknown }).agentId !== HIDDEN_REVIEWER_AGENT_ID;
            });
            if (visiblePeers.length !== peers.length) {
              const sanitizedHello = {
                ...(parsed as Record<string, unknown>),
                peers: visiblePeers,
              };
              const sanitizedStr = JSON.stringify(sanitizedHello);
              passthroughData = Buffer.from(sanitizedStr, "utf8");
              passthroughLen = Buffer.byteLength(sanitizedStr);
              parsed = sanitizedHello;
            }
            const cidStr = containerId.toString();
            const uidStr = uid.toString();
            // 前端只在发送态未清且 id 合法时携带 inFlightClientMessageId。
            // 这里只收集候选,查询必须等 hello 转发之后再跑。
            const terminalNotifyCandidates: Array<{ peerId: string; clientMessageId: string }> = [];
            const terminalNotifySeen = new Set<string>();
            const liveCatchupSessions: Array<{ sessionId: string; afterFrameSeq: number }> = [];
            const liveCatchupSeen = new Set<string>();
            for (const p of visiblePeers) {
              if (typeof p !== "object" || p === null) continue;
              const peer = p as {
                peerId?: unknown;
                agentId?: unknown;
                lastFrameSeq?: unknown;
                inFlight?: unknown;
                inFlightClientMessageId?: unknown;
              };
              if (typeof peer.peerId !== "string") continue;
              registerUserWsSession(userWs, uidStr, peer.peerId);
              if (
                !liveCatchupSeen.has(peer.peerId) &&
                liveCatchupSessions.length < HELLO_LIVE_CATCHUP_MAX_SESSIONS
              ) {
                liveCatchupSeen.add(peer.peerId);
                const afterFrameSeq =
                  typeof peer.lastFrameSeq === "number" && Number.isSafeInteger(peer.lastFrameSeq)
                    ? Math.max(0, peer.lastFrameSeq)
                    : 0;
                liveCatchupSessions.push({ sessionId: peer.peerId, afterFrameSeq });
              }
              const inFlightId = peer.inFlightClientMessageId;
              // peers 来自客户端。协议规定 inFlightClientMessageId 仅在
              // inFlight===true 时携带,且为短 uuid;不校验就会被无界字符串/
              // 重复项放大成并行 PG 查询。
              if (
                peer.inFlight === true &&
                typeof inFlightId === "string" &&
                inFlightId !== "" &&
                inFlightId.length <= HELLO_TERMINAL_NOTIFY_MAX_CLIENT_MESSAGE_ID_LEN &&
                isClientMessageId(inFlightId)
              ) {
                const dedupeKey = `${peer.peerId}\0${inFlightId}`;
                if (
                  !terminalNotifySeen.has(dedupeKey) &&
                  terminalNotifyCandidates.length < HELLO_TERMINAL_NOTIFY_MAX_CANDIDATES
                ) {
                  terminalNotifySeen.add(dedupeKey);
                  terminalNotifyCandidates.push({
                    peerId: peer.peerId,
                    clientMessageId: inFlightId,
                  });
                }
              }
              const aid =
                typeof peer.agentId === "string" && peer.agentId !== ""
                  ? peer.agentId
                  : "main";
              // Match openclaude/packages/gateway server.ts L3459-3460
              // sanitisation verbatim — same regex, same default kind=dm.
              const safeId = peer.peerId.replace(/[^a-zA-Z0-9_-]/g, "_");
              const sessionKey = `agent:${aid}:webchat:dm:${safeId}`;
              const storeKey = `${uidStr}:${cidStr}:${sessionKey}`;
              // Hello is the browser's subscription authority. Register every
              // visible peer before forwarding/replay so a second attached tab
              // protects an existing failed-sequence barrier even if it has not
              // received its first outbound frame yet.
              retainOutboundPersistQueueKey(storeKey);
              const cursor =
                typeof peer.lastFrameSeq === "number" ? peer.lastFrameSeq : 0;
              const replay = outboundRing.peekReplay(storeKey, cursor);
              if (replay.ok) {
                for (const f of replay.sent) {
                  if (parseLeftoverHotWsPayload(f.data)) continue;
                  try { userWs.send(f.data); } catch { break; }
                }
              }
              // miss 时【刻意不发 resume_failed】—— replay 的唯一裁决者是容器:
              // hello 会原样转发给容器,其 ring 与 master 生命周期解耦(master 重启
              // 容器不重启),能重放就重放、真不能才由容器发 resume_failed。
              // 旧行为(bridge miss 即抢发)在 master 重启后必然触发:bridge ring
              // 新进程恒空 → 客户端被 resume_failed 打断(游标重置 + REST 快照覆盖
              // 本地流中 partial),容器随后完好的重放反而作废 —— boss 实测:重启时
              // 响应中的消息内容永久丢失,只剩重连后的续帧(2026-07-02)。
              // bridge ring 的定位收敛为「hit 时的近端加速」,不再参与失败裁决;
              // 容器不可达的场景由既有连接超时/relay 断开路径关闭 userWs → 客户端
              // 重连,不会死等。
            }
            // Phase 4 — auto-rebind:记录 hello peers,触发 flush(可能等 fetch 完成)。
            //   双触发设计:hello 端记 peer 集合 → tryAutoRebindFlush;
            //   open 端 fetch 完成 → tryAutoRebindFlush。两边都就绪才真 flush。
            //   Codex Phase 4.7 #2 修:旧实现只在 hello 时同步看 map,fetch 慢于 hello
            //   时 active 选择永不 rebind。
            const helloPeerIds = new Set<string>();
            for (const p of visiblePeers) {
              if (typeof p === "object" && p !== null) {
                const pid = (p as { peerId?: unknown }).peerId;
                if (typeof pid === "string") helloPeerIds.add(pid);
              }
            }
            // 多次 hello(reconnect 重发)合并 peer 集合,不丢之前 hello 见过的 peer
            if (lastHelloPeerIds === null) lastHelloPeerIds = helloPeerIds;
            else for (const id of helloPeerIds) lastHelloPeerIds.add(id);
            tryAutoRebindFlush();
            // 容器重建后内存环 _recentTerminalRing 为空,只能发 turn_state_unknown
            // (isFinal:false),前端明确不清发送态;容器进程又拿不到 master PG。
            // hello 必经本桥且宿主有 PG,终态回落只能在这里补。
            //
            // 绝不能挡在 hello 转发前面:容器靠这条 hello 把 containerWs 登记进
            // clientsByPeer,链路一个字节都不能动。所以只 spawn 浮动 promise,
            // 先 await 让出同步栈,等 fall through 到 forwardInboundFrame 之后再查 PG。
            if (terminalNotifyCandidates.length > 0 && deps.pgPool) {
              const pgPool = deps.pgPool;
              void (async () => {
                try {
                  await Promise.resolve();
                  for (const { peerId, clientMessageId } of terminalNotifyCandidates) {
                    // 查询前也要看连接:断开后结果没人收,继续查只会空烧 PG。
                    if (userWs.readyState !== WebSocket.OPEN) break;
                    const row = await getDispatchByLogicalKey(pgPool, {
                      userId: uid,
                      sessionId: peerId,
                      clientMessageId,
                    });
                    if (row === null || row.status !== "terminal") continue;
                    let reconcile: "turn_completed" | "interrupted" | null = null;
                    if (row.outcome === "completed") {
                      reconcile = "turn_completed";
                    } else if (row.outcome === "interrupted" || row.outcome === "crashed") {
                      // 前端 reducer 只认这两个字面量。不要模仿容器的 turn_interrupted,
                      // 也不要带 interrupted:'service_restart'(会触发自动恢复)。
                      reconcile = "interrupted";
                    }
                    // not_accepted / executed_error / 其它 / null → 什么都不发:
                    // 失败态交给现有 fail-visible 通道,避免和失败卡打架。
                    if (reconcile === null) continue;
                    // 只打本条 hello 所在的 userWs,不用 broadcastToUser —
                    // 同 uid 其它标签页未必卡在这一轮,广播会误清它们的发送态。
                    if (userWs.readyState !== WebSocket.OPEN) continue;
                    try {
                      userWs.send(JSON.stringify({
                        type: "outbound.message",
                        channel: "webchat",
                        peer: { id: peerId, kind: "dm" },
                        clientMessageId,
                        blocks: [],
                        isFinal: true,
                        meta: { reconcile, clientMessageId },
                        ts: Date.now(),
                      }));
                      bridgeLog?.info("user-chat-bridge: hello terminal dispatch fallback sent", {
                        uid: uidStr,
                        sessionId: peerId,
                        clientMessageId,
                        reconcile,
                      });
                    } catch { /* 发不出就静默降级 */ }
                  }
                } catch {
                  // 任何失败都只能静默:hello 处理绝不能因回落抛错。
                }
              })().catch(() => {});
            }
            if (liveCatchupSessions.length > 0 && deps.pgPool) {
              const pgPool = deps.pgPool;
              void (async () => {
                try {
                  await Promise.resolve();
                  for (const { sessionId, afterFrameSeq } of liveCatchupSessions) {
                    if (userWs.readyState !== WebSocket.OPEN) break;
                    const catchupItems = await readOpenDispatchLiveFramePayloadsAfterSeq(pgPool, {
                      uid,
                      sessionId,
                      afterFrameSeq,
                      limit: HELLO_LIVE_CATCHUP_MAX_FRAMES,
                      maxBytes: Math.min(maxBufferedBytes, HELLO_LIVE_CATCHUP_MAX_BYTES),
                    });
                    let catchupBackpressured = false;
                    for (const item of catchupItems) {
                      if (item.kind === "oversize") {
                        catchupBackpressured = true;
                        break;
                      }
                      const payload = item.payload;
                      if (parseLeftoverHotWsPayload(payload)) continue;
                      const decision = liveCatchupSendDecision(
                        userWs.readyState,
                        userWs.bufferedAmount,
                        Buffer.byteLength(payload, "utf8"),
                        maxBufferedBytes,
                      );
                      if (decision === "stop") break;
                      if (decision === "backpressure") {
                        catchupBackpressured = true;
                        break;
                      }
                      try { userWs.send(payload); } catch { break; }
                    }
                    // Slow/huge reconnect: close only this WS. Do not cleanup()
                    // the admitting bridge — other uid+session sockets stay up.
                    if (catchupBackpressured && userWs.readyState === WebSocket.OPEN) {
                      try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
                      break;
                    }
                  }
                } catch {
                  // hello 补齐失败只能静默:不得挡转发、不得关连接。
                }
              })().catch(() => {});
            }
            // Fall through to forwardInboundFrame below.
          }
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            (parsed as { type?: unknown }).type === "inbound.message"
          ) {
            inboundTurnIdentityForFrame = inboundTurnIdentityFromParsed(parsed);
            inboundPeerIdForFrame = inboundTurnIdentityForFrame.peerId;
            const frameModelRaw = (parsed as { model?: unknown }).model;
            const frameModelId = typeof frameModelRaw === "string" ? frameModelRaw : null;
            const frameAgentIdRaw = (parsed as { agentId?: unknown }).agentId;
            const frameAgentId = typeof frameAgentIdRaw === "string" ? frameAgentIdRaw : null;
            const teamModeRequested = (parsed as { teamMode?: unknown }).teamMode === true;
            if (frameAgentId === HIDDEN_REVIEWER_AGENT_ID) {
              rejectPromptQueueDispatch("AGENT_NOT_FOUND");
              bridgeLog?.info("user-chat-bridge: hidden system agent direct frame rejected", {
                agentId: frameAgentId,
              });
              sendErrorFrame(
                userWs,
                "AGENT_NOT_FOUND",
                "agent not found",
                inboundTurnIdentityForFrame,
              );
              try { userWs.close(CLOSE_BRIDGE.PRODUCT_POLICY, "hidden_agent_direct_chat"); } catch { /* */ }
              cleanup("client_close", true);
              return;
            }
            const frameAgentAuthorityModel: string | null =
              frameAgentId !== null && agentModelResolverHandle !== null
                ? agentModelResolverHandle.resolve(frameAgentId)
                : null;
            // Capability readiness is a server-owned execution gate, not a model
            // selection hint. A browser normally supplies frame.model, so checking
            // only the resolver's null model on the no-model path would let an
            // installed-but-unready Agent execute from a stale container projection.
            // Preserve the denied set separately and reject before team-mode/model
            // precedence regardless of what model the client supplied.
            if (
              frameAgentId !== null &&
              agentModelResolverHandle !== null &&
              agentModelResolverHandle.isRuntimeDenied(frameAgentId)
            ) {
              rejectPromptQueueDispatch("UNRESOLVED_AGENT_MODEL");
              void agentModelResolverHandle.refresh();
              bridgeLog?.info("user-chat-bridge: agent runtime not ready, frame rejected", {
                agentId: frameAgentId,
              });
              sendErrorFrame(
                userWs,
                "UNRESOLVED_AGENT_MODEL",
                `agent '${frameAgentId}' is not ready — repair its required capabilities and retry`,
                inboundTurnIdentityForFrame,
              );
              try { userWs.close(CLOSE_BRIDGE.PRODUCT_POLICY, "agent_not_runtime_ready"); } catch { /* */ }
              cleanup("client_close", true);
              return;
            }
            // Gateway 对 unknown explicit agentId 会降级为 default/main。bridge 必须用同
            // 一谓词:团队模式下 unknown agent 也按 main 队长强制 GPT,否则客户端可传
            // agentId="bogus"+model="glm-5.2" 让 master 以 GLM 放行、容器却跑 main。
            // 若测试/旧装配没有 agentModelResolver,bridge 无法证明 explicit non-main
            // agent 真实存在;teamMode 是 main 队长语义,因此也 fail-safe 归一为 main。
            const teamModeNonMainAgentDemotesToMain =
              teamModeRequested &&
              frameAgentId !== null &&
              frameAgentId !== "main" &&
              (agentModelResolverHandle === null || frameAgentAuthorityModel === null);
            const teamModeMain =
              teamModeRequested &&
              (frameAgentId === "main" || frameAgentId === null || teamModeNonMainAgentDemotesToMain);
            const effectiveFrameAgentId = teamModeMain ? "main" : frameAgentId;
            const agentImpliedModel =
              effectiveFrameAgentId !== null ? AGENT_AUTHZ_IMPLIED_MODEL[effectiveFrameAgentId] : undefined;
            // P0 计费旁路封堵 —— master agent 权威推导:帧无 model 时容器 gateway
            // 会回落 agent.model 做 engine 判定(resolveEngine),bridge 必须用
            // master 自己的 agent 权威(seed 常量 + marketplace manifest)推导同一
            // 份「有效模型」,分类才与容器同构。null = 权威推导不出(未知 agentId)。
            const agentAuthorityModel: string | null =
              effectiveFrameAgentId !== null && agentModelResolverHandle !== null
                ? effectiveFrameAgentId === frameAgentId
                  ? frameAgentAuthorityModel
                  : agentModelResolverHandle.resolve(effectiveFrameAgentId)
                : null;

            // 选用顺序:teamMode main 强制 GPT > frame.model > agent 隐含 model
            // (安全 contract)> master agent 权威 > lastSeenModelId(仅辅助:帧连
            // agentId 都没带时的兜底,不作 codex 分类的唯一权威)
            let effectiveModel: string | null = null;
            let source:
              | "frame.model"
              | "agentId.implied"
              | "agentAuthority"
              | "teamMode.main"
              | "lastSeen"
              | null = null;
            if (teamModeMain) {
              // v5 团队模式方案 B:队长固定用 GPT 5.5,隐藏审查员用 GLM。
              // 这里必须在 auth/codex 分类前覆盖 effectiveModel,并在下方 rewrite
              // forwarded frame.model,确保 master 计费链路与容器执行模型一致。
              effectiveModel = DEFAULT_CODEX_ENGINE_MODEL;
              source = "teamMode.main";
            } else if (frameModelId !== null) {
              effectiveModel = frameModelId;
              source = "frame.model";
            } else if (agentImpliedModel !== undefined) {
              effectiveModel = agentImpliedModel;
              source = "agentId.implied";
            } else if (agentAuthorityModel !== null) {
              effectiveModel = agentAuthorityModel;
              source = "agentAuthority";
            } else if (effectiveFrameAgentId !== null && agentModelResolverHandle !== null) {
              // fail-closed:帧无 model + agentId 在 master agent 权威里推导不出。
              // 容器侧会把该 agentId 解析成 agents.yaml 里的某个 agent(未知 id 才
              // 降级 default),其 agent.model 可能是 gpt-5.5 → 免 requestId 落
              // codex(计费旁路)。master 推导不出就不放行 —— 与 UNAUTHORIZED_MODEL
              // 同款拒帧路径。先补触发一次权威快照 refresh(新装 agent 的窗口期
              // miss,用户重发即可命中),再拒本帧。
              void agentModelResolverHandle.refresh();
              rejectPromptQueueDispatch("UNRESOLVED_AGENT_MODEL");
              bridgeLog?.info("user-chat-bridge: agent model unresolved, frame rejected", {
                agentId: effectiveFrameAgentId,
              });
              sendErrorFrame(
                userWs,
                "UNRESOLVED_AGENT_MODEL",
                `cannot resolve model for agent '${effectiveFrameAgentId}' — retry shortly or specify a model`,
                inboundTurnIdentityForFrame,
              );
              try { userWs.close(CLOSE_BRIDGE.PRODUCT_POLICY, "unresolved_agent_model"); } catch { /* */ }
              // 策略拒绝 → force final;此前无 codex inflight(本帧才进 acquire 路径),无 drain 价值
              cleanup("client_close", true);
              return;
            } else if (lastSeenModelId !== null) {
              effectiveModel = lastSeenModelId;
              source = "lastSeen";
            }
            // 命中 frame.model / agentId.implied 时把效果 model 记进 lastSeenModelId,
            // 后续无 model/agentId 帧仍可继续校验。lastSeen 命中时不更新(就是它自己);
            // agentAuthority 命中时也不更新 —— 权威快照每帧现算,无需二次缓存,且
            // agent 卸载后不该靠 stale lastSeen 复活。
            if (source === "frame.model" || source === "agentId.implied") {
              lastSeenModelId = effectiveModel;
            }
            if (
              modelCheckerHandle !== null &&
              effectiveModel !== null &&
              !modelCheckerHandle.isAllowed(effectiveModel)
            ) {
              const peerObj = (parsed as { peer?: { id?: unknown } }).peer;
              const peerId = peerObj && typeof peerObj === "object" && typeof peerObj.id === "string"
                ? peerObj.id
                : null;
              const clientMessageId = isClientMessageId(
                (parsed as { clientMessageId?: unknown }).clientMessageId,
              )
                ? (parsed as { clientMessageId: string }).clientMessageId
                : null;
              rejectPromptQueueDispatch("UNAUTHORIZED_MODEL");
              bridgeLog?.info("user-chat-bridge: model not authorized", {
                modelId: effectiveModel,
                source,
              });
              sendErrorFrame(
                userWs,
                "UNAUTHORIZED_MODEL",
                `model not authorized for current user: ${effectiveModel}`,
                { peerId, clientMessageId },
              );
              return;
            }
            effectiveModelForFrame = effectiveModel;
            // ── 模型执行权威:待签发的 model(方案 §2 步 ②)────────────────────
            // 复用上面既有的 effectiveModel 推导链。它为 null 的唯一场景 = 帧既无
            // model 也无 agentId 且本桥从没见过 model —— 此时容器会落到默认 agent
            // (通常 'main'),故用 master agent 权威解析 'main' 补齐,推不出则由
            // resolveAuthorityExecOrReject fail-closed 拒帧(不猜、不放行)。
            authorityModelForFrame =
              effectiveModel ?? agentModelResolverHandle?.resolve("main") ?? null;
            // codex 判定的**单一权威**:
            //   - flag 开 → catalog 快照的 engine(与签发同源;alias 归一后查 active 行)。
            //     baked 的 gpt-* 前缀集合从此不参与判定 —— 它与 catalog 必然漂移
            //     (catalog 里 engine 迁移 / 新增 codex 系模型,旧镜像的前缀表不认识)。
            //   - flag 关 → 旧的 isCodexEngineModel(零行为变化)。
            // peek() 为 null(快照 unknown)时回落 baked **仅用于选路**:真正的判定发生在
            // IIFE 里的 epoch fence,fence 不过一律拒帧,故错选路不会造成错计费。
            isCodexInboundFrame =
              authorityOn && authorityModelForFrame !== null
                ? (authorityDeps?.catalog.peek()?.isEngineReportedModel(authorityModelForFrame) ??
                   (isCodexEngineModel(effectiveModel) || isGrokEngineModel(effectiveModel)))
                : (isCodexEngineModel(effectiveModel) || isGrokEngineModel(effectiveModel));
            isCursorInboundFrame =
              authorityOn && authorityModelForFrame !== null
                ? (authorityDeps?.catalog.peek()?.isCursorModel(authorityModelForFrame) ??
                   isCursorEngineModel(effectiveModel))
                : isCursorEngineModel(effectiveModel);
            isZcodeInboundFrame =
              authorityOn && authorityModelForFrame !== null
                ? (authorityDeps?.catalog.peek()?.isZcodeModel(authorityModelForFrame) ??
                   isZcodeEngineModel(effectiveModel))
                : isZcodeEngineModel(effectiveModel);
            // peer.id was frozen at inbound.message entry for every turn-level
            // error exit. AgentId is still only needed on engine-billed paths.
            if (isCodexInboundFrame || isCursorInboundFrame || isZcodeInboundFrame) {
              // PR2 v1.0.66 — 把 agentId 提到外层供 codex billing IIFE 用
              // (查 agent_cost_overrides multiplier)。
              inboundAgentIdForFrame = effectiveFrameAgentId;
            }
            // CG2a — canonical trace 生成 + client observation。
            // 任何 inbound.message(codex / 非 codex)都强制注入 master canonical;
            // client 提供的 clientTraceId 仅 observation:
            //   - 合法 → 进 log
            //   - 非法且 raw !== undefined → 只记 issue 不带 raw(MAJOR 2 防 log injection)
            //     且从 forward 给容器的 frame 中 **strip 掉**(防 raw 进入下游 logger)
            if (firstUserFrameAtMs === null) firstUserFrameAtMs = receivedAtMs;
            turnTraceIdForFrame = newTraceId();
            const rawClientTrace = (parsed as { clientTraceId?: unknown }).clientTraceId;
            const clientHint = parseTraceIdCandidate(rawClientTrace);
            const clientTraceFields: {
              clientTraceId?: string;
              clientTraceIdIssue?: TraceIdIssue;
            } = {};
            if (clientHint.ok) {
              clientTraceFields.clientTraceId = clientHint.traceId;
            } else if (rawClientTrace !== undefined) {
              clientTraceFields.clientTraceIdIssue = clientHint.issue;
            }
            // sanitize:
            //   - 非法 clientTraceId 不透传给 container — 合法 / undefined 保留原 parsed
            //   - __oc_codex_route / _workspaceMode 永远是 master-owned 私有字段;
            //     client 输入即使形状合法也必须剥离,后面只由 server 重新注入。
            //   - teamMode main 固定 GPT 队长:即使客户端传/省略其它 model 或省略
            //     agentId,转发给容器的 frame.agentId/model 也必须归一为
            //     main/DEFAULT_CODEX_ENGINE_MODEL,否则 master 已按 GPT 预扣/注 requestId,
            //     容器却可能按 main 默认 GLM 或路由规则执行。
            let sanitizedParsed = parsed as Record<string, unknown>;
            const hasClientCodexRoute = Object.prototype.hasOwnProperty.call(
              sanitizedParsed,
              "__oc_codex_route",
            );
            const hasClientGrokRoute = Object.prototype.hasOwnProperty.call(
              sanitizedParsed,
              "__oc_grok_route",
            );
            const hasClientZcodeRoute = Object.prototype.hasOwnProperty.call(
              sanitizedParsed,
              "__oc_zcode_route",
            );
            const hasClientWorkspaceMode = Object.prototype.hasOwnProperty.call(
              sanitizedParsed,
              "_workspaceMode",
            );
            if (
              (rawClientTrace !== undefined && !clientHint.ok) ||
              hasClientCodexRoute ||
              hasClientGrokRoute ||
              hasClientZcodeRoute ||
              hasClientWorkspaceMode ||
              teamModeMain
            ) {
              sanitizedParsed = { ...sanitizedParsed };
              if (rawClientTrace !== undefined && !clientHint.ok) {
                delete sanitizedParsed.clientTraceId;
              }
              if (hasClientCodexRoute) {
                delete sanitizedParsed.__oc_codex_route;
              }
              if (hasClientGrokRoute) {
                delete sanitizedParsed.__oc_grok_route;
              }
              if (hasClientZcodeRoute) {
                delete sanitizedParsed.__oc_zcode_route;
              }
              if (hasClientWorkspaceMode) {
                const { _workspaceMode: _discard, ...withoutWorkspaceMode } = sanitizedParsed;
                sanitizedParsed = withoutWorkspaceMode;
              }
              if (teamModeMain) {
                sanitizedParsed.agentId = "main";
                sanitizedParsed.model = DEFAULT_CODEX_ENGINE_MODEL;
              }
            }
            // Chat-native paper integration: keep browser/session text unchanged,
            // but enrich the master→container frame with a bounded ScanSci PDF
            // usage hint when the user's message is clearly a paper task.
            inboundParsedFrame = appendScanSciPaperIntentHintToFrame(sanitizedParsed);
            isAnnotatedImageInboundFrame = isValidatedAnnotatedImageInbound(inboundParsedFrame);
            // CG2b — turnLog 派生:traceId 钉进 bindings,后续 turn 内 log 自动带上
            turnLogForFrame = bridgeLog?.child({ traceId: turnTraceIdForFrame }) ?? null;
            turnLogForFrame?.info("user-chat-bridge: inbound turn start", clientTraceFields);
            // CG2d — traceId 唯一持久登记(fire-and-forget):UI 底部展示的请求ID就是
            // 这个 traceId,不落库运维就无从定位(usage_records.request_id 是上游 id,
            // 另一套 id 空间)。sessionKey 派生与 hello replay 路径同一约定
            // (gateway server.ts sanitisation verbatim:agent:<aid>:webchat:dm:<safeId>)。
            {
              const peerObj = (parsed as { peer?: { id?: unknown } }).peer;
              const peerIdRaw =
                peerObj && typeof peerObj === "object" ? peerObj.id : undefined;
              const traceSessionKey =
                typeof peerIdRaw === "string" && peerIdRaw !== ""
                  ? `agent:${effectiveFrameAgentId}:webchat:dm:${peerIdRaw.replace(/[^a-zA-Z0-9_-]/g, "_")}`
                  : "(unknown-peer)";
              // TODO(durable-dispatch): turn_traces.dispatch_id/request_id 是纯展示列
              // (RFC §2 I3),但本 trace 登记是**同步**发生于分类阶段,而 dispatch 受理与
              // server requestId 铸造都在下游 async IIFE(attach 之后)。此处两者均未就绪 →
              // 保持 null(recordTurnTrace 默认 null,schema 兼容)。要填充需把 trace insert
              // 移到受理后逐 IIFE 重复登记,与"不 restructure id-minting"约束冲突,故不做。
              recordTurnTrace(
                deps.pgPool,
                (msg, fields) => turnLogForFrame?.warn(msg, fields),
                {
                  traceId: turnTraceIdForFrame,
                  userId: uid,
                  sessionKey: traceSessionKey,
                  agentId: effectiveFrameAgentId,
                  model: effectiveModelForFrame,
                  bundleRev: endpoint.bundleRev ?? null,
                  clientBuild: clientBuildForConnection,
                },
              );
            }
            // turn 在飞起点:用户已发消息在等响应,心跳在 turn 期间不得 reap(见 MAX_TURN_GRACE_MS 硬上限)。
            turnActiveUntil = Date.now() + MAX_TURN_GRACE_MS;
          }
        }
      }

      // plan v3 G5/G7 — codex per-account 槽 acquire / 严格单飞:
      //   - bridge 看到 codex inbound + 有 codexBinding 注入 + 有 containerId
      //   - 容器 codex_account_id 是 NULL(legacy)→ acquire() 返回 null,IIFE 内
      //     不占槽,但 PR2 v1.0.66 起 **billing 路径仍要跑**(每轮 turn 都要扣费 +
      //     落 journal),所以这里**不**用 codexLegacyContainer 当 outer guard 跳过 IIFE。
      //     legacy 每轮多一次廉价 SELECT(codexBinding.acquire 内部 row 查),换不漏扣。
      //   - 已持槽 / acquire 在飞 → reject "previous codex turn still in progress"(G7)
      //   - 否则:async acquire → 成功 forward;Busy / 其他 fail → fast-fail error 帧
      //
      // 非 codex 帧 / 没注入 codexBinding / 没 containerId → 直接走下方原同步 forward
      if (isCursorInboundFrame && containerId !== undefined) {
        const parsedCapture = inboundParsedFrame;
        const traceCapture = turnTraceIdForFrame;
        const logCapture = turnLogForFrame;
        const authorityModelCapture = authorityModelForFrame;
        const modelCapture = effectiveModelForFrame;
        const peerCapture = inboundPeerIdForFrame;
        const cid = containerId;
        const cursorTurnIdentity = {
          peerId: peerCapture,
          clientMessageId: parsedCapture !== null && isClientMessageId(parsedCapture.clientMessageId)
            ? parsedCapture.clientMessageId
            : null,
        };
        void (async () => {
          let dispatchRecord: AdmittedDispatch | undefined;
          try {
            if (!deps.pgPool || parsedCapture === null || traceCapture === null || !isCursorEngineModel(modelCapture)) {
              rejectPromptQueueDispatch('CURSOR_UNAVAILABLE');
              sendErrorFrame(userWs, 'CURSOR_UNAVAILABLE', 'Cursor is unavailable for this account', cursorTurnIdentity);
              return;
            }
            if (!isCursorCredentialMember(uid)) {
              rejectPromptQueueDispatch('UNAUTHORIZED_MODEL');
              sendErrorFrame(userWs, 'UNAUTHORIZED_MODEL', 'Cursor is not enabled for this account', cursorTurnIdentity);
              return;
            }
            // The local supervisor mounts the owner credential only on this
            // compute host. Missing host identity and remote rows fail closed.
            const eligible = await isCursorContainerOnSelfHost(
              deps.pgPool,
              cid,
              uid,
              deps.selfHostId,
            );
            if (!eligible) {
              rejectPromptQueueDispatch('CURSOR_UNAVAILABLE');
              sendErrorFrame(userWs, 'CURSOR_UNAVAILABLE', 'Cursor requires the account-owned local runtime', cursorTurnIdentity);
              return;
            }
            const enriched = await attachMasterTurnState(parsedCapture, logCapture, traceCapture, !isPromptQueueDispatch, rejectPromptQueueDispatch, authorityModelCapture, recoveryJob);
            if (enriched === null) return;
            dispatchRecord = lookupAdmittedDispatch(enriched);
            let authorityExec: ResolvedTurnExecution | null = null;
            if (authorityOn) {
              // resolveAuthorityExecOrReject's legacy boolean means "non-CCB"
              // (not literally Codex); Cursor is therefore classified true.
              authorityExec = await resolveAuthorityExecOrReject({ model: authorityModelCapture, classifiedCodex: true, log: logCapture, onReject: rejectPromptQueueDispatch, turn: cursorTurnIdentity });
              if (
                authorityExec === null
                || authorityExec.engine !== 'cursor'
                || authorityExec.canonicalModel !== modelCapture
              ) {
                failDispatchPreForward(dispatchRecord, 'cursor_authority_rejected');
                return;
              }
            }
            const requestId = dispatchRecord ? dispatchRecord.billingRequestId : ensureRequestIdServerSide();
            await deps.pgPool.query(
              `INSERT INTO cursor_external_usage_audit(request_id,user_id,container_id,session_id,model_id,status)
               VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT (request_id) DO NOTHING`,
              [requestId, uid, cid, peerCapture, modelCapture],
            );
            let authorityFields: Record<string, unknown> = {};
            if (authorityExec !== null) {
              const sealed = await sealAuthorityFieldsOrReject({ exec: authorityExec, billingRequestId: requestId, log: logCapture, onReject: rejectPromptQueueDispatch, turn: cursorTurnIdentity });
              if (sealed === null) { failDispatchPreForward(dispatchRecord, 'cursor_authority_seal_rejected'); return; }
              authorityFields = sealed;
            }
            const forwarded = { ...enriched, requestId, traceId: traceCapture, ...authorityFields, ...dispatchAuthorityField(dispatchRecord) };
            const encoded = JSON.stringify(forwarded); const len = Buffer.byteLength(encoded);
            if (len > maxFrameBytes) { failDispatchPreForward(dispatchRecord, 'ERR_FRAME_TOO_BIG'); rejectPromptQueueDispatch('ERR_FRAME_TOO_BIG'); return; }
            await forwardPreparedFrame(Buffer.from(encoded, 'utf8'), false, len);
          } catch (err) {
            logCapture?.error('user-chat-bridge: Cursor external admission failed', { err });
            failDispatchPreForward(dispatchRecord, 'cursor_external_admission_failed');
            rejectPromptQueueDispatch('CURSOR_UNAVAILABLE');
            if (!cleaned && userWs.readyState === WebSocket.OPEN) {
              sendErrorFrame(userWs, 'CURSOR_UNAVAILABLE', 'Cursor is temporarily unavailable', cursorTurnIdentity);
            }
          }
        })();
        return;
      }
      if (isZcodeInboundFrame && containerId !== undefined) {
        const parsedCapture = inboundParsedFrame;
        const traceCapture = turnTraceIdForFrame;
        const logCapture = turnLogForFrame;
        const authorityModelCapture = authorityModelForFrame;
        const modelCapture = effectiveModelForFrame;
        const peerCapture = inboundPeerIdForFrame;
        const cid = containerId;
        const zcodeTurnIdentity = {
          peerId: peerCapture,
          clientMessageId: parsedCapture !== null && isClientMessageId(parsedCapture.clientMessageId)
            ? parsedCapture.clientMessageId
            : null,
        };
        void (async () => {
          let dispatchRecord: AdmittedDispatch | undefined;
          let insertedRequestId: string | null = null;
          const abortInserted = (step: "seal_rejected" | "frame_too_big" | "send_failed"): Promise<void> => {
            if (insertedRequestId !== null) {
              const relay = pendingZcodeRelays.get(insertedRequestId);
              if (relay) {
                deps.expireZcodeRoute?.(relay.token);
                pendingZcodeRelays.delete(insertedRequestId);
              }
            }
            if (!deps.pgPool || insertedRequestId === null) return Promise.resolve();
            const requestId = insertedRequestId;
            const work = abortInsertedZcodeAudit(deps.pgPool, {
              requestId,
              userId: uid,
              pending: pendingZcodeRequestIds,
              terminalCode: zcodeAdmissionAbortTerminal(step),
            }).then(() => undefined);
            trackZcodeAuditWork(work);
            return work;
          };
          try {
            const canary = typeof modelCapture === "string" && isZcodeEngineModel(modelCapture);
            const publicCanonical = modelCapture === "glm-5.3-zai";
            if (!deps.pgPool || parsedCapture === null || traceCapture === null || typeof modelCapture !== "string" || (!canary && !publicCanonical)) {
              rejectPromptQueueDispatch('ZCODE_UNAVAILABLE');
              sendErrorFrame(userWs, 'ZCODE_UNAVAILABLE', 'ZCode is unavailable for this account', zcodeTurnIdentity);
              return;
            }
            const zcodeModelId = modelCapture;
            const enriched = await attachMasterTurnState(parsedCapture, logCapture, traceCapture, !isPromptQueueDispatch, rejectPromptQueueDispatch, authorityModelCapture, recoveryJob);
            if (enriched === null) return;
            dispatchRecord = lookupAdmittedDispatch(enriched);
            let authorityExec: ResolvedTurnExecution | null = null;
            if (authorityOn) {
              // resolveAuthorityExecOrReject's legacy boolean means "non-CCB"
              // (not literally Codex); ZCode is therefore classified true.
              authorityExec = await resolveAuthorityExecOrReject({ model: authorityModelCapture, classifiedCodex: true, log: logCapture, onReject: rejectPromptQueueDispatch, turn: zcodeTurnIdentity });
              if (
                authorityExec === null
                || authorityExec.engine !== 'zcode'
                || authorityExec.canonicalModel !== zcodeModelId
              ) {
                failDispatchPreForward(dispatchRecord, 'zcode_authority_rejected');
                return;
              }
            }
            const requestId = dispatchRecord ? dispatchRecord.billingRequestId : ensureRequestIdServerSide();
            if (!deps.mintZcodeRoute) {
              rejectPromptQueueDispatch('ZCODE_UNAVAILABLE');
              sendErrorFrame(userWs, 'ZCODE_UNAVAILABLE', 'ZCode is unavailable for this account', zcodeTurnIdentity);
              return;
            }
            let minted: { token: string; baseUrl: string };
            try {
              minted = await deps.mintZcodeRoute({
                containerId: cid,
                userId: uid,
                requestId,
                modelId: zcodeModelId,
              });
            } catch (err) {
              logCapture?.error('user-chat-bridge: ZCode relay mint failed', { err });
              rejectPromptQueueDispatch('ZCODE_UNAVAILABLE');
              sendErrorFrame(userWs, 'ZCODE_UNAVAILABLE', 'ZCode is temporarily unavailable', zcodeTurnIdentity);
              return;
            }
            pendingZcodeRelays.set(requestId, {
              token: minted.token,
              modelId: zcodeModelId,
              sessionId: peerCapture,
              traceId: traceCapture,
            });
            insertedRequestId = requestId;
            if (canary) {
              await insertPendingZcodeAudit(deps.pgPool, {
                requestId,
                userId: uid,
                containerId: cid,
                sessionId: peerCapture,
                modelId: zcodeModelId,
              });
              rememberZcodePending(pendingZcodeRequestIds, requestId);
              ensureZcodeStaleReconcile();
            }
            let authorityFields: Record<string, unknown> = {};
            if (authorityExec !== null) {
              const sealed = await sealAuthorityFieldsOrReject({ exec: authorityExec, billingRequestId: requestId, log: logCapture, onReject: rejectPromptQueueDispatch, turn: zcodeTurnIdentity });
              if (sealed === null) {
                failDispatchPreForward(dispatchRecord, 'zcode_authority_seal_rejected');
                deps.expireZcodeRoute?.(minted.token);
                pendingZcodeRelays.delete(requestId);
                await abortInserted("seal_rejected");
                return;
              }
              authorityFields = sealed;
            }
            const forwarded = {
              ...enriched,
              requestId,
              traceId: traceCapture,
              __oc_zcode_route: { baseUrl: minted.baseUrl, routeToken: minted.token },
              ...authorityFields,
              ...dispatchAuthorityField(dispatchRecord),
            };
            const encoded = JSON.stringify(forwarded); const len = Buffer.byteLength(encoded);
            if (len > maxFrameBytes) {
              failDispatchPreForward(dispatchRecord, 'ERR_FRAME_TOO_BIG');
              rejectPromptQueueDispatch('ERR_FRAME_TOO_BIG');
              deps.expireZcodeRoute?.(minted.token);
              pendingZcodeRelays.delete(requestId);
              await abortInserted("frame_too_big");
              return;
            }
            await forwardPreparedFrame(Buffer.from(encoded, 'utf8'), false, len);
          } catch (err) {
            logCapture?.error('user-chat-bridge: ZCode external admission failed', { err });
            failDispatchPreForward(dispatchRecord, 'zcode_external_admission_failed');
            rejectPromptQueueDispatch('ZCODE_UNAVAILABLE');
            await abortInserted("send_failed");
            if (!cleaned && userWs.readyState === WebSocket.OPEN) {
              sendErrorFrame(userWs, 'ZCODE_UNAVAILABLE', 'ZCode is temporarily unavailable', zcodeTurnIdentity);
            }
          }
        })();
        return;
      }
      if (
        isCodexInboundFrame &&
        isAnnotatedImageInboundFrame &&
        containerId !== undefined
      ) {
        const inboundParsedCapture = inboundParsedFrame;
        const turnTraceIdCapture = turnTraceIdForFrame;
        const turnLogCapture = turnLogForFrame;
        const authorityModelCapture = authorityModelForFrame;
        const annotatedTurnIdentity = inboundTurnIdentityForFrame;
        void (async () => {
          // M6:总括 try/catch —— 本 IIFE 无预扣/journal/槽,一切**意外**异常(签票 crypto /
          // JSON.stringify / forward 抛)必须收敛成「dispatch 终态化 + error 帧 + queue grant 取消」,
          // 禁 unhandled rejection。dispatchRecordA 声明在 try 外,供 catch 兜底终态化。
          let dispatchRecordA: AdmittedDispatch | undefined;
          try {
            if (turnTraceIdCapture === null || inboundParsedCapture === null) {
              rejectPromptQueueDispatch("ERR_INTERNAL");
              bridgeLog?.error("user-chat-bridge: annotated image frame missing trace invariant");
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendErrorFrame(userWs, "ERR_INTERNAL", "trace invariant violated", annotatedTurnIdentity);
                try { userWs.close(CLOSE_BRIDGE.INTERNAL, "trace invariant"); } catch { /* */ }
              }
              return;
            }
            const enrichedParsed = await attachMasterTurnState(
              inboundParsedCapture,
              turnLogCapture,
              turnTraceIdCapture,
              !isPromptQueueDispatch,
              rejectPromptQueueDispatch,
              authorityModelCapture,
              recoveryJob,
            );
            // null:attachMasterTurnState 已在内部拒轮(含 dispatch 终态化 + onReject);此处直接 return。
            if (enrichedParsed === null) return;
            dispatchRecordA = lookupAdmittedDispatch(enrichedParsed);
            if (cleaned) { failDispatchPreForward(dispatchRecordA, "bridge_cleaned"); return; }
            // 模型执行权威:epoch fence + descriptor(拒帧 → 直接 return,本路径尚无预扣)。
            let authorityExec: ResolvedTurnExecution | null = null;
            if (authorityOn) {
              authorityExec = await resolveAuthorityExecOrReject({
                model: authorityModelCapture,
                classifiedCodex: true,
                log: turnLogCapture,
                onReject: rejectPromptQueueDispatch,
                turn: annotatedTurnIdentity,
              });
              if (authorityExec === null) {
                failDispatchPreForward(dispatchRecordA, "authority_rejected");
                return;
              }
            }
            // Image 2 owns its exact 50-credit reservation inside the trusted
            // relay. Do not acquire a chat slot, open a Codex journal, or create
            // a chat Redis reservation for a turn the gateway intentionally
            // completes without starting Codex. The relay resolves the active
            // container binding/account independently.
            // durable dispatch:复用受理铸的稳定 billingRequestId 作 server requestId(接管稳定)。
            const requestId = dispatchRecordA ? dispatchRecordA.billingRequestId : ensureRequestIdServerSide();
            // 签发边界(MAJOR-2):重读 epoch → 一致才签。本路径的计费在可信 relay 内自持
            // (不开 journal、不占 chat 槽)→ 无需补偿,拒帧的代价是零。
            let authorityFields: Record<string, unknown> = {};
            if (authorityExec !== null) {
              const sealed = await sealAuthorityFieldsOrReject({
                exec: authorityExec,
                billingRequestId: requestId,
                log: turnLogCapture,
                onReject: rejectPromptQueueDispatch,
                turn: annotatedTurnIdentity,
              });
              if (sealed === null) { failDispatchPreForward(dispatchRecordA, "authority_seal_rejected"); return; }
              authorityFields = sealed;
            }
            if (cleaned) { failDispatchPreForward(dispatchRecordA, "bridge_cleaned"); return; }
            const rewrittenObj = {
              ...enrichedParsed,
              requestId,
              traceId: turnTraceIdCapture,
              // 注入签名执行权威 + 把 frame.model 归一为 canonical(容器侧断言
              // descriptor.canonicalModel === frame.model,不一致即拒)。
              ...authorityFields,
              // durable dispatch envelope(容器 durable inbox 准入 + at-most-once)。
              ...dispatchAuthorityField(dispatchRecordA),
            };
            const rewrittenStr = JSON.stringify(rewrittenObj);
            const rewrittenLen = Buffer.byteLength(rewrittenStr);
            if (rewrittenLen > maxFrameBytes) {
              rejectPromptQueueDispatch("ERR_FRAME_TOO_BIG");
              failDispatchPreForward(dispatchRecordA, "ERR_FRAME_TOO_BIG");
              turnLogCapture?.error("user-chat-bridge: rewritten annotated image frame too big", {
                rewrittenLen, max: maxFrameBytes,
              });
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendErrorFrame(userWs, "ERR_FRAME_TOO_BIG", `rewritten frame ${rewrittenLen} > max ${maxFrameBytes}`, annotatedTurnIdentity);
                try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
              }
              return;
            }
            // forwardPreparedFrame:queue lane 走它兜住 promptQueueResolved(cancel 边);browser
            // lane 无 dispatchRequest → 等价 forwardInboundFrame。dispatch 已 accepted 交容器,不终态化。
            await forwardPreparedFrame(Buffer.from(rewrittenStr, "utf8"), false, rewrittenLen);
          } catch (err) {
            bridgeLog?.error("user-chat-bridge: annotated image IIFE unexpected error", { err });
            rejectPromptQueueDispatch("ERR_INTERNAL");
            failDispatchPreForward(dispatchRecordA, "annotated_image_unexpected_exception");
            if (!cleaned && userWs.readyState === WebSocket.OPEN) {
              sendErrorFrame(userWs, "ERR_INTERNAL", "internal error", annotatedTurnIdentity);
            }
          }
        })();
        return;
      }
      if (
        isCodexInboundFrame &&
        containerId !== undefined &&
        (deps.codexBinding !== undefined || deps.createCodexRoute !== undefined)
      ) {
        const peerIdForAcquire = inboundPeerIdForFrame;
        const clientMessageIdForAcquire = inboundParsedFrame !== null &&
          isClientMessageId(inboundParsedFrame.clientMessageId)
          ? inboundParsedFrame.clientMessageId
          : null;
        const peerKeyForAcquire = codexPeerKey(peerIdForAcquire);
        if (shouldRejectCodexTurnForG7(
          activeCodexTurnsByPeer.has(peerKeyForAcquire),
          isPromptQueueDispatch,
        )) {
          // Same-session strict single-flight. Do not close the bridge: other
          // sessions on this connection remain usable and the exact failed turn
          // can be retried without disturbing their lifecycle state.
          turnLogForFrame?.info("user-chat-bridge: codex turn busy, rejecting frame");
          sendErrorFrame(
            userWs,
            "CODEX_TURN_BUSY",
            "previous codex turn still in progress, wait for completion",
            { peerId: peerIdForAcquire, clientMessageId: clientMessageIdForAcquire },
          );
          return;
        }
        if (isPromptQueueDispatch && activeCodexTurnsByPeer.has(peerKeyForAcquire)) {
          // A PG queue grant says nothing about a legacy turn that predates the
          // queue authority. Never label that live bridge owner "stale" or free
          // its account/route. This is an internal retryable grant failure (the
          // queued item remains durable), not the legacy user-facing G7 error.
          turnLogForFrame?.info("user-chat-bridge: queue dispatch waiting for live codex owner", {
            peerId: peerIdForAcquire,
          });
          rejectPromptQueueDispatch("EXECUTION_OWNER_BUSY");
          return;
        }
        // Reserve the peer synchronously before the first await. This is both the
        // same-session admission lock and the ABA fence for late async continuations.
        const codexTurnState: ActiveCodexTurnState = {
          stateId: randomUUID(),
          peerKey: peerKeyForAcquire,
          peerId: peerIdForAcquire,
          clientMessageId: clientMessageIdForAcquire,
          promptQueueGrantId: dispatchRequest?.grantId ?? null,
          engine: "codex",
          acquireInflight: true,
          acquiredAccountId: null,
          acquiredSlotId: null,
          apiRelayRouteToken: null,
          billingRequestId: null,
          turnForwarded: false,
          releaseTimer: null,
          slotHeartbeat: null,
        };
        activeCodexTurnsByPeer.set(peerKeyForAcquire, codexTurnState);
        const turnIdentity = {
          peerId: peerIdForAcquire,
          clientMessageId: clientMessageIdForAcquire,
        };
        const sendTurnErrorFrame = (code: string, message: string): void => {
          rejectPromptQueueDispatch(code);
          sendErrorFrame(userWs, code, message, turnIdentity);
        };
        const codexBinding = deps.codexBinding;
        const createCodexRoute = deps.createCodexRoute;
        const cid = containerId;
        const sessionMaxMs = readCodexSessionMaxMs();
        // Billing rollback owns journal/reservation separately; this helper owns
        // only the session admission state, account slot, timer and relay route.
        const releaseAcquiredSlotForFailure = (): void => {
          releaseCodexTurnState(codexTurnState, "failure");
        };
        // PR2 v1.0.66 — 把外层 onUserMessage 抓的 effectiveModel / parsed / agentId
        // 快照进 IIFE 局部,IIFE 跑期间 onUserMessage 不会再修改这几个 let(下一帧
        // 走 G7 busy 拒绝路径,不会到这里),但稳妥起见还是 capture。
        const effectiveModelCapture = effectiveModelForFrame;
        const engineDisplayName = isGrokEngineModel(effectiveModelCapture) ? "Grok Build" : "GPT";
        const inboundAgentIdCapture = inboundAgentIdForFrame;
        const inboundParsedCapture = inboundParsedFrame;
        const authorityModelCapture = authorityModelForFrame;
        // CG2a — capture canonical traceId 给 IIFE 局部用。inbound.message ⇒ isCodexInboundFrame=true
        // 路径强保证 turnTraceIdForFrame 非 null(invariant 由 IIFE 起手处显式校验)。
        const turnTraceIdCapture = turnTraceIdForFrame;
        // CG2b — capture turn-scoped logger;同步 set 一并 capture。
        const turnLogCapture = turnLogForFrame;
        void (async () => {
          let turnForwarded = false;
          // durable dispatch 受理记录(attach 后赋值);声明在 try 外供 finally 兜底终态化。
          let dispatchRecordB: AdmittedDispatch | undefined;
          try {
            // CG2a invariant — codex inbound 必经 inbound.message 分支 ⇒ trace + parsed 必非 null。
            // 这里前置校验(acquire 之前),invariant 破坏 → close 1011,无需 release。
            // 若放 acquire 之后再校验,要多一份 releaseAcquiredSlotForFailure() 清理负担。
            if (turnTraceIdCapture === null || inboundParsedCapture === null) {
              // invariant 命中时 turnLogCapture 也必为 null(同步生成),用 bridgeLog 兜底
              bridgeLog?.error("user-chat-bridge: codex frame missing trace invariant");
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendTurnErrorFrame("ERR_INTERNAL", "trace invariant violated");
                try { userWs.close(CLOSE_BRIDGE.INTERNAL, "trace invariant"); } catch { /* */ }
              }
              return;
            }
            const preparedInbound = await attachMasterTurnState(
              inboundParsedCapture,
              turnLogCapture,
              turnTraceIdCapture,
              !isPromptQueueDispatch,
              rejectPromptQueueDispatch,
              authorityModelCapture,
              recoveryJob,
            );
            if (preparedInbound === null || !isCurrentCodexTurnState(codexTurnState)) return;
            dispatchRecordB = lookupAdmittedDispatch(preparedInbound);
            // ── 模型执行权威:epoch fence + descriptor(方案 §1.2 R3-B2)─────────
            // **必须在 acquire / preCheck / journal 之前**:此刻拒帧的代价是零(没占槽、
            // 没预扣、没开 journal)。放到后面拒 = 要写一堆补偿回滚,而补偿路径正是漏账
            // 的常见来源。fence 失败(catalog unknown / DB 不可达 / 模型不可路由)一律拒。
            let authorityExec: ResolvedTurnExecution | null = null;
            if (authorityOn) {
              authorityExec = await resolveAuthorityExecOrReject({
                model: authorityModelCapture,
                classifiedCodex: true,
                log: turnLogCapture,
                onReject: rejectPromptQueueDispatch,
                turn: turnIdentity,
              });
              if (authorityExec === null) return;
              if (!isCurrentCodexTurnState(codexTurnState)) return;
            }
            let codexRoute: CodexApiRelayRoute | null = null;
            let officialOAuthGroupId: string | null = null;
            if (createCodexRoute !== undefined) {
              if (effectiveModelCapture === null) {
                throw new Error("codex route requested without effective model");
              }
              const decision = await createCodexRoute({
                containerId: cid,
                userId: uid,
                modelId: effectiveModelCapture,
                ...(inboundPeerIdForFrame ? { sessionId: inboundPeerIdForFrame } : {}),
              });
              if (!isCurrentCodexTurnState(codexTurnState)) {
                if (
                  decision !== null &&
                  decision.kind !== "official_oauth" &&
                  decision.kind !== "unavailable"
                ) {
                  expireCodexRouteToken(decision.token, "stale_route_creation");
                  if (decision.engine === 'grok' && decision.accountId && decision.slotId && codexBinding) {
                    try { codexBinding.release(BigInt(decision.accountId), decision.slotId); } catch { /* best effort */ }
                  }
                }
                return;
              }
              if (decision !== null) {
                if (decision.kind === "official_oauth") {
                  officialOAuthGroupId = decision.groupId;
                } else if (decision.kind === "unavailable") {
                  throw Object.assign(new Error(decision.reason), { name: "CodexRouteUnavailable" });
                } else {
                  codexRoute = decision;
                  codexTurnState.engine = decision.engine ?? "codex";
                  codexTurnState.apiRelayRouteToken = decision.token;
                }
              }
            }

            let acquired: { account_id: bigint; slotId: string } | null =
              codexRoute?.engine === 'grok' && codexRoute.accountId && codexRoute.slotId
                ? { account_id: BigInt(codexRoute.accountId), slotId: codexRoute.slotId }
                : null;
            if (codexRoute === null) {
              if (codexBinding === undefined) {
                throw Object.assign(new Error("no enabled Codex API relay group"), { name: "CodexRouteUnavailable" });
              }
              acquired = await codexBinding.acquire(cid, officialOAuthGroupId);
              if (!isCurrentCodexTurnState(codexTurnState)) {
                if (acquired !== null) {
                  try { codexBinding.release(acquired.account_id, acquired.slotId); } catch { /* */ }
                }
                return;
              }
              if (officialOAuthGroupId !== null && acquired === null) {
                throw Object.assign(new Error("selected Codex OAuth group unavailable"), { name: "CodexRouteUnavailable" });
              }
            }
            if (!isCurrentCodexTurnState(codexTurnState)) {
              // bridge 在 acquire/route 创建期间被关 — 立即 release 不留泄漏
              if (codexRoute !== null) {
                expireCodexRouteToken(codexRoute.token, "cleanup_during_route_creation");
              }
              if (acquired !== null && codexBinding !== undefined) {
                try { codexBinding.release(acquired.account_id, acquired.slotId); } catch { /* */ }
              }
              return;
            }
            if (acquired === null) {
              // legacy NULL 容器(决策 N3):不占 per-account 槽,billing 路径下面
              // 仍跑(accountIdForQuota=0n 占位)。The session state still remains
              // active so a legacy turn gets the same single-flight semantics.
            } else {
              codexTurnState.acquiredAccountId = acquired.account_id;
              codexTurnState.acquiredSlotId = acquired.slotId;
            }
            codexTurnState.acquireInflight = false;
            if (codexRoute?.engine === 'grok') {
              // Grok Build is a coding agent, so a valid turn must not be cut off
              // by Codex's legacy 10-minute fallback. Terminal/error/bridge cleanup
              // remains authoritative; this heartbeat only preserves its occupied
              // account slot against the generic orphan reaper while it is live.
              codexTurnState.slotHeartbeat = setInterval(() => {
                const accountId = codexTurnState.acquiredAccountId;
                const slotId = codexTurnState.acquiredSlotId;
                if (accountId !== null && slotId !== null) {
                  deps.codexBinding?.renew?.(accountId, slotId);
                }
              }, 60_000);
              codexTurnState.slotHeartbeat.unref?.();
            } else {
              codexTurnState.releaseTimer = setTimeout(() => {
                releaseCodexTurnState(codexTurnState, "timeout");
              }, sessionMaxMs);
              codexTurnState.releaseTimer.unref?.();
            }

            // PR2 v1.0.66 → M2 — codex 真扣费 path:preCheck → journal → snapshot
            //   (finalizer 延迟到 billing 帧构造)→ inflightCodexTurns Map 注册 →
            //   frame rewrite 注入 server-owned requestId → forward。
            //   失败任一步:释放已 acquire 的资源 + close ws 关连接。
            //
            //   codexBillingEnabled=false(测试 / 个人版上下文,三件套未注入)→ 走
            //   下方 else 分支:仍 rewrite 注入 traceId(CG2a 合同硬门),只是不动 requestId。
            const codexRouteFrame = codexRoute !== null && codexRoute.engine !== 'grok' ? {
              baseUrl: codexRoute.baseUrl,
              modelProvider: codexRoute.modelProvider,
              providerName: codexRoute.providerName ?? null,
              wireApi: codexRoute.wireApi ?? "responses",
              preferredAuthMethod: codexRoute.preferredAuthMethod ?? "apikey",
              disableResponseStorage: codexRoute.disableResponseStorage ?? true,
            } : officialOAuthGroupId !== null ? {
              kind: "official_oauth" as const,
            } : null;
            const grokRouteFrame = codexRoute?.engine === 'grok' ? {
              baseUrl: codexRoute.baseUrl,
              routeToken: codexRoute.token,
            } : null;
            let frameForwardData: RawData;
            const frameForwardIsBinary = false;
            let frameForwardLen: number;
            if (codexBillingEnabled) {
              // 三件套全注入(createUserChatBridge entry 已强校验)→ non-null assert 安全
              const pgPool = deps.pgPool!;
              const preCheckRedis = deps.preCheckRedis!;
              const pricingCache = deps.pricing!;

              if (effectiveModelCapture === null) {
                // 不该发生(isCodexInboundFrame=true 蕴含 effectiveModel 非空)
                turnLogCapture?.error("user-chat-bridge: codex billing without effective model");
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendTurnErrorFrame("CODEX_BILLING", "codex billing internal");
                  try { userWs.close(CLOSE_BRIDGE.INTERNAL, "codex billing"); } catch { /* */ }
                }
                releaseAcquiredSlotForFailure();
                return;
              }
              const effectiveModel = effectiveModelCapture;

              // authority turn 的执行、授权、基础价格必须来自同一个 fenced snapshot；
              // PricingCache 只服务 flag 关闭的 legacy 路径。
              const modelPricing = authorityExec !== null
                ? authorityExec.pricing
                : pricingCache.get(effectiveModel);
              if (!modelPricing) {
                // pricing 缓存 miss(authz 通过但 cache 未含此 model — race 窗口
                // / DB 配置漂移)。fail-closed:不放行 codex turn,免漏扣。
                turnLogCapture?.error("user-chat-bridge: codex pricing missing", {
                  model: effectiveModel,
                });
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendTurnErrorFrame("CODEX_BILLING", `pricing missing for ${effectiveModel}`);
                  try { userWs.close(CLOSE_BRIDGE.INTERNAL, "pricing missing"); } catch { /* */ }
                }
                releaseAcquiredSlotForFailure();
                return;
              }

              // agent_cost_overrides:frameAgentId 缺省 fallback 'codex'(codex
              // implied via gpt-* 前缀,canonical agentId 即 'codex')。
              const agentForCharge = inboundAgentIdCapture ?? "codex";
              let agentMul: string;
              try {
                agentMul = await getAgentCostMultiplier(pgPool, agentForCharge);
              } catch (err) {
                turnLogCapture?.error("user-chat-bridge: getAgentCostMultiplier failed", {
                  agentId: agentForCharge, err,
                });
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendTurnErrorFrame("CODEX_BILLING", "billing config unavailable");
                  try { userWs.close(CLOSE_BRIDGE.INTERNAL, "billing config"); } catch { /* */ }
                }
                releaseAcquiredSlotForFailure();
                return;
              }
              if (!isCurrentCodexTurnState(codexTurnState)) {
                releaseAcquiredSlotForFailure();
                return;
              }

              const composedMultiplier = composeMultiplier(modelPricing.multiplier, agentMul);
              const derivedPricing: ModelPricing = {
                ...modelPricing,
                multiplier: composedMultiplier,
              };

              // durable dispatch:复用受理铸的稳定 billingRequestId 作 server requestId
              // (接管跨 attempt 稳定;journal/票据/结算全绑同一值)。
              const requestId = dispatchRecordB ? dispatchRecordB.billingRequestId : ensureRequestIdServerSide();
              codexTurnState.billingRequestId = requestId;
              let verificationSponsorship;
              try {
                verificationSponsorship = await admitVerificationSponsorship(pgPool, {
                  requestId,
                  userId: uid,
                  model: effectiveModel,
                  sessionId: peerIdForAcquire,
                });
              } catch (err) {
                turnLogCapture?.error("user-chat-bridge: verification sponsorship admission failed", { err });
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendTurnErrorFrame("CODEX_BILLING", "billing verification unavailable");
                }
                releaseAcquiredSlotForFailure();
                return;
              }
              if (!isCurrentCodexTurnState(codexTurnState)) {
                releaseAcquiredSlotForFailure();
                return;
              }
              // 先铸 turnId 再落 journal；随后签票必须复用同一值，并把 billingRequestId
              // 绑到 requestId。这样进程崩溃后只读 journal 也能复原“哪张票对应哪笔账”。
              const authorityTurnId = authorityExec !== null
                ? authorityDeps!.signer.mintAuthorityTurnId()
                : null;
              let maxCost: bigint;
              try {
                maxCost = estimateMaxCost(CODEX_PRECHECK_TOKEN_ESTIMATE, derivedPricing);
              } catch (err) {
                turnLogCapture?.error("user-chat-bridge: estimateMaxCost failed", { err });
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendTurnErrorFrame("CODEX_BILLING", "billing internal");
                  try { userWs.close(CLOSE_BRIDGE.INTERNAL, "billing internal"); } catch { /* */ }
                }
                releaseAcquiredSlotForFailure();
                return;
              }

              let preCheckResult: Awaited<ReturnType<typeof preCheckWithCost>>;
              try {
                preCheckResult = await preCheckWithCost(preCheckRedis, {
                  userId: uid,
                  requestId,
                  maxCost,
                });
              } catch (err) {
                if (err instanceof InsufficientCreditsError) {
                  turnLogCapture?.info("user-chat-bridge: codex preCheck insufficient credits", {
                    balance: err.balance.toString(),
                    required: err.required.toString(),
                  });
                  if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                    sendTurnErrorFrame(
                      "ERR_INSUFFICIENT_CREDITS",
                      `insufficient credits: balance=${err.balance} required=${err.required}`,
                    );
                    try { userWs.close(CLOSE_BRIDGE.BILLING_POLICY, "insufficient_credits"); } catch { /* */ }
                  }
                } else {
                  turnLogCapture?.error("user-chat-bridge: preCheckWithCost failed", { err });
                  if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                    sendTurnErrorFrame("CODEX_BILLING", "preCheck unavailable");
                    try { userWs.close(CLOSE_BRIDGE.INTERNAL, "preCheck unavailable"); } catch { /* */ }
                  }
                }
                releaseAcquiredSlotForFailure();
                return;
              }
              if (!isCurrentCodexTurnState(codexTurnState)) {
                // 已 preCheck;主动 release 不让 lock 在 Redis 卡 5 分钟
                await releasePreCheck(preCheckRedis, preCheckResult.reservation).catch(() => {});
                releaseAcquiredSlotForFailure();
                return;
              }

              // M2:usage_records.account_id 恒写 SQL NULL(codexFinalizer v5 形态,
              // 弃 v3 的 0n 假账号)。这里的 accountIdForQuota **只**服务 rateLimits
              // 落 claude_accounts.quota_*(maybeUpdateAccountQuotaCodex 对 0n 跳过):
              // legacy(acquired===null)/ api_relay 路由用 0n 占位 = 无关联账号。
              const accountIdForQuota = acquired !== null ? acquired.account_id : 0n;

              try {
                const admitted = await startInflightJournal(pgPool, {
                  requestId,
                  userId: uid,
                  containerId: BigInt(cid),
                  model: effectiveModel,
                  precheckCredits: preCheckResult.maxCost,
                  ctxJson: {
                    agentId: agentForCharge,
                    codexAccountId:
                      accountIdForQuota === 0n
                        ? null
                        : accountIdForQuota.toString(),
                    ...(codexRoute?.engine === "grok" && acquired !== null
                      ? {
                          grokAccountId: acquired.account_id.toString(),
                          grokSlotId: acquired.slotId,
                        }
                      : {}),
                    source: "codex_bridge",
                    durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
                    // 已复合 agent override 的最终价格。跨 bridge 恢复必须用这份
                    // server-owned 快照，不能在结算时回读已换代的 cache/override。
                    billingPricing: serializeBillingPricing(derivedPricing),
                    ...(verificationSponsorship === null
                      ? {}
                      : { verificationSponsorship: serializeVerificationSponsorshipSnapshot(verificationSponsorship) }),
                    // P0 修复(2026-07-03)— 跨桥 settle 需要:billing 帧到达新桥
                    // (旧桥已关)时,journal ctx 是恢复 settle 的唯一权威上下文,
                    // traceId 让跨桥的 cost_charged 广播 / billing 日志仍钉回本
                    // turn 的 canonical trace。CG2c invariant 保证此处非 null。
                    traceId: turnTraceIdCapture,
                    // durable dispatch 身份:durableCodexBilling settle 侧写
                    // usage_records/journal 的 dispatch_id/attempt_no(RFC §2.2)。
                    ...(dispatchRecordB
                      ? { dispatchId: dispatchRecordB.dispatchId, attemptNo: dispatchRecordB.attemptNo }
                      : {}),
                    ...(authorityExec === null
                      ? {}
                      : {
                          authorityKind: "bridge_signed",
                          authorityTurnId,
                          billingRequestId: requestId,
                          executionRevision: authorityExec.executionRevision,
                          billingRevision: authorityExec.billingRevision,
                          securityEpoch: String(authorityExec.securityEpoch),
                        }),
                  },
                  // 落**列**(非仅 ctx):reconciler 财务联查按 dispatch_id 列直查(RFC §2.3)。
                  ...(dispatchRecordB
                    ? { dispatchId: dispatchRecordB.dispatchId, attemptNo: dispatchRecordB.attemptNo }
                    : {}),
                });
                if (!admitted) {
                  // journal 已存在。durable 路径 = lease 接管复用同 billingRequestId(RFC §7.7):
                  // 严格比对列(user/dispatch/attempt)+ ctx.model —— 全对且 inflight 才复用;
                  // aborted = 本 attempt 计费面已耗尽(旧桥主动 abort),终态化让用户显式重发;
                  // 其余(committed/finalizing/比对不一致)= 财务歧义 → manual_reconcile,绝不盲用。
                  let reuseAsTakenOver = false;
                  if (dispatchRecordB !== undefined) {
                    const existing = await readJournalForTakeover(pgPool, requestId).catch(() => null);
                    if (
                      existing !== null &&
                      existing.state === "inflight" &&
                      existing.userId === uid.toString() &&
                      existing.dispatchId === dispatchRecordB.dispatchId &&
                      existing.attemptNo === dispatchRecordB.attemptNo &&
                      existing.model === effectiveModel
                    ) {
                      reuseAsTakenOver = true;
                      turnLogCapture?.info("user-chat-bridge: journal takeover reuse", {
                        requestId, dispatchId: dispatchRecordB.dispatchId,
                      });
                    } else if (existing !== null && existing.state === "aborted") {
                      failDispatchPreForward(dispatchRecordB, "journal_aborted");
                    } else {
                      void casToManualReconcile(pgPool, {
                        dispatchId: dispatchRecordB.dispatchId,
                        conflictReason: "journal_takeover_mismatch",
                      }).catch(() => {});
                      dropAdmittedDispatch(dispatchRecordB.clientMessageId);
                    }
                  }
                  if (!reuseAsTakenOver) {
                    turnLogCapture?.error("user-chat-bridge: request journal conflict", {
                      requestId,
                    });
                    if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                      sendTurnErrorFrame("CODEX_BILLING", "journal unavailable");
                      try { userWs.close(CLOSE_BRIDGE.INTERNAL, "journal unavailable"); } catch { /* */ }
                    }
                    await releasePreCheck(preCheckRedis, preCheckResult.reservation).catch(() => {});
                    releaseAcquiredSlotForFailure();
                    return;
                  }
                }
              } catch (err) {
                turnLogCapture?.error("user-chat-bridge: startInflightJournal failed", {
                  requestId, err,
                });
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendTurnErrorFrame("CODEX_BILLING", "journal unavailable");
                  try { userWs.close(CLOSE_BRIDGE.INTERNAL, "journal unavailable"); } catch { /* */ }
                }
                await releasePreCheck(preCheckRedis, preCheckResult.reservation).catch(() => {});
                releaseAcquiredSlotForFailure();
                return;
              }
              if (!isCurrentCodexTurnState(codexTurnState)) {
                // journal 已落 inflight — 主动 abort + release reservation,免 reconciler 等 timeout
                await abortInflightJournal(
                  pgPool,
                  requestId,
                  permanentCodexWaiverReason("bridge_disconnect_before_finalize"),
                  "CLIENT_ABORT",
                ).catch(() => {});
                await releasePreCheck(preCheckRedis, preCheckResult.reservation).catch(() => {});
                releaseAcquiredSlotForFailure();
                return;
              }

              // M2 — inflight snapshot:finalizer 延迟到 billing 帧构造(engineSessionId
              // 权威来自帧);abandon 承接旧 finalizer.fail 语义
              // (abort journal + release reservation,不扣费)。snapState 单一状态机
              // 保证 getFinalizer/abandon 互斥幂等,与旧"构造期单 finalizer + _done
              // 守门"钱安全不变量等价。
              const reservationForTurn: ReservationHandle = preCheckResult.reservation;
              type SnapState =
                | { kind: "handle"; handle: CodexFinalizeHandle }
                | { kind: "abandoned"; promise: Promise<void> };
              let snapState: SnapState | null = null;
              const snap: CodexTurnSnapshot = {
                requestId,
                model: effectiveModel,
                // Issue A v1.0.108 — codex_billing 分支落 quota 用。
                accountId: accountIdForQuota,
                // CG2c — IIFE 起手 invariant 已校验 turnTraceIdCapture !== null,
                // 这里读出来 TS 推断为 string。本 turn 整个生命周期内固定不可变。
                traceId: turnTraceIdCapture,
                codexRouteToken: codexRoute?.token ?? null,
                releaseBridgeTurnState(reason: string): boolean {
                  if (!isCurrentCodexTurnState(codexTurnState)) {
                    if (codexTurnState.engine === "grok") retryPendingGrokLeaseRelease(requestId);
                    return false;
                  }
                  releaseCodexTurnState(codexTurnState, reason);
                  return true;
                },
                authority: authorityExec === null
                  ? null
                  : {
                      executionRevision: authorityExec.executionRevision,
                      projectionRevision: null,
                      securityEpoch: BigInt(authorityExec.securityEpoch),
                      kind: "bridge_signed",
                    },
                authorityTurnId,
                getFinalizer(engineSessionIdFromFrame: string): CodexFinalizeHandle | null {
                  if (snapState !== null) {
                    return snapState.kind === "handle" ? snapState.handle : null;
                  }
                  const handle = makeCodexFinalizer({
                    pgPool,
                    preCheckRedis,
                    userId: uid,
                    requestId,
                    engineSessionId: engineSessionIdFromFrame,
                    model: effectiveModel,
                    derivedPricing,
                    reservation: reservationForTurn,
                    authority: snap.authority,
                    // B7b:live codex settle 把 dispatch 身份写进 usage_records.dispatch_id/
                    // attempt_no(与 journal 列一致)。legacy turn(无 dispatch)→ null。
                    dispatchId: dispatchRecordB?.dispatchId ?? null,
                    attemptNo: dispatchRecordB?.attemptNo ?? null,
                    verificationSponsorship,
                  });
                  snapState = { kind: "handle", handle };
                  return handle;
                },
                async abandon(
                  reason: string,
                  failureCode = codexAbandonFailureCode(reason),
                ): Promise<void> {
                  if (snapState !== null) {
                    if (snapState.kind === "handle") {
                      // finalizer 已构造:委托其 fail(fail-after-commit 由 _done 守门,
                      // 已扣过费不会再 abort journal)。
                      await snapState.handle.fail(reason, failureCode);
                      return;
                    }
                    await snapState.promise.catch(() => {});
                    return;
                  }
                  const promise = (async (): Promise<void> => {
                    try {
                      await abortInflightJournal(
                        pgPool,
                        requestId,
                        permanentCodexWaiverReason(reason),
                        failureCode,
                      );
                    } catch {
                      // journal abort 失败 — durable replay 继续重试；始终无 evidence 时
                      // reconciler 最早在 24h SLA 后兜底免单。
                    } finally {
                      await releasePreCheck(preCheckRedis, reservationForTurn).catch(() => {});
                    }
                  })();
                  snapState = { kind: "abandoned", promise };
                  await promise;
                },
              };
              inflightCodexTurns.set(requestId, snap);

              // 从 journal/map 注册完成起，到物理 forward 被本桥接受为止，任何 return/throw
              // 都必须走同一补偿状态机。历史装配、签发、JSON 序列化、帧上限、socket 同步
              // send 任一失败都不能把 journal / reservation / codex slot 留在半态。
              let forwardCommitted = false;
              let abandonReason = "codex_forward_not_committed";
              try {

              // Frame rewrite:server-owned requestId 覆盖 client 任意值。容器侧
              // 把这个 requestId 透传到 outbound.codex_billing,master 用它从
              // inflightCodexTurns Map 找回 snapshot 落账。
              // CG2a — 同时注入 master canonical traceId(IIFE 起手 invariant 保证非 null)
              const enrichedParsed = preparedInbound;
              // ── 签发边界(MAJOR-2)────────────────────────────────────────────
              // 这里是 turn 里**最后一个还能无痛掉头**的点:票还没签、帧还没进容器。
              // 从起手 fence 到这一行之间已经跑完 route/acquire/preCheck/journal/历史装配
              // 全部 await —— 安全写完全可能落在中间。重读 epoch,不一致就**整单放弃**:
              // abort journal(否则悬空 = 漏账/错账,最早等 durable reconciler 24h
              // evidence SLA 兜底免单)+ 释放
              // preCheck 预扣 + 还 codex 槽,一步都不能少。
              let authorityFields: Record<string, unknown> = {};
              if (authorityExec !== null) {
                const sealed = await sealAuthorityFieldsOrReject({
                  exec: authorityExec,
                  billingRequestId: requestId,
                  ...(authorityTurnId === null ? {} : { authorityTurnId }),
                  log: turnLogCapture,
                  onReject: rejectPromptQueueDispatch,
                  turn: turnIdentity,
                  // seal 只报告拒因；真正的资源补偿统一由下方 finally 状态机执行。
                  compensate: (reason) => { abandonReason = reason; },
                });
                if (sealed === null) {
                  return;
                }
                authorityFields = sealed;
              }
              if (!isCurrentCodexTurnState(codexTurnState)) {
                abandonReason = "bridge_disconnect_before_forward";
                return;
              }
              const rewrittenObj = {
                ...enrichedParsed,
                requestId,
                traceId: turnTraceIdCapture,
                ...(codexRouteFrame !== null ? { __oc_codex_route: codexRouteFrame } : {}),
                ...(grokRouteFrame !== null ? { __oc_grok_route: grokRouteFrame } : {}),
                // 模型执行权威:签票绑定本 turn 的 server-owned requestId(billingRequestId),
                // 并把 frame.model 归一为 canonical(容器断言 canonicalModel === frame.model)。
                ...authorityFields,
                // durable dispatch envelope(容器 durable inbox 准入 + at-most-once)。
                ...dispatchAuthorityField(dispatchRecordB),
              };
              const rewrittenStr = JSON.stringify(rewrittenObj);
              const rewrittenLen = Buffer.byteLength(rewrittenStr);
              if (rewrittenLen > maxFrameBytes) {
                // rewriting 只加 ~100 bytes(`,"requestId":"<32hex>","traceId":"<32hex>"`)
                // — 几乎不可能越界。命中 = 用户帧本来就贴边,abandon(不扣费)+ close ws。
                turnLogCapture?.error("user-chat-bridge: rewritten codex frame too big", {
                  rewrittenLen, max: maxFrameBytes,
                });
                abandonReason = "rewritten_frame_too_big";
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendTurnErrorFrame(
                    "ERR_FRAME_TOO_BIG",
                    `rewritten frame ${rewrittenLen} > max ${maxFrameBytes}`,
                  );
                  try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
                }
                return;
              }
              // ws lib RawData = Buffer | ArrayBuffer | Buffer[];string 不匹配。
              // 转 Buffer 走文本帧(isBinary=false)— 接收端 .toString() 行为一致。
              frameForwardData = Buffer.from(rewrittenStr, "utf8");
              frameForwardLen = rewrittenLen;
              forwardCommitted = await forwardPreparedFrame(
                frameForwardData,
                frameForwardIsBinary,
                frameForwardLen,
              );
              turnForwarded = forwardCommitted;
              codexTurnState.turnForwarded = forwardCommitted;
              if (!forwardCommitted) abandonReason = "container_forward_rejected";
              if (forwardCommitted && dispatchRequest) {
                promptQueueDispatchCancellations.set(dispatchRequest.grantId, {
                  request: dispatchRequest,
                  cancel: async (reasonCode) => {
                    // The gateway accepted the grant but lost/released the exact
                    // PG claim before SessionManager activation. No provider work
                    // may run, so unwind every commercial resource immediately.
                    inflightCodexTurns.delete(requestId);
                    releaseCodexTurnState(codexTurnState, `prompt_queue_${reasonCode}`);
                    await snap.abandon(`prompt_queue_${reasonCode}`, "CLIENT_ABORT");
                  },
                });
              }
              } finally {
                if (!forwardCommitted) {
                  inflightCodexTurns.delete(requestId);
                  await snap.abandon(abandonReason).catch((err) => {
                    turnLogCapture?.error(
                      "user-chat-bridge: pre-forward billing compensation failed",
                      { requestId, abandonReason, err },
                    );
                  });
                  releaseAcquiredSlotForFailure();
                }
              }
              return;
            } else {
              // CG2a — billing 未启用(legacy NULL 容器无三件套 / 测试)路径仍要 rewrite
              // 注入 traceId(合同硬门);不动 requestId(client 提供的 requestId 保留 raw)。
              const enrichedParsed = preparedInbound;
              // 签发边界(MAJOR-2):本分支没开 journal / 没预扣,但**占了 codex 槽** ——
              // 拒帧必须还槽,否则该用户后续 codex turn 全被 G7 单飞门挡住。
              let authorityFields: Record<string, unknown> = {};
              if (authorityExec !== null) {
                const sealed = await sealAuthorityFieldsOrReject({
                  exec: authorityExec,
                  log: turnLogCapture,
                  onReject: rejectPromptQueueDispatch,
                  turn: turnIdentity,
                  compensate: () => releaseAcquiredSlotForFailure(),
                });
                if (sealed === null) return;
                authorityFields = sealed;
              }
              if (!isCurrentCodexTurnState(codexTurnState)) {
                releaseAcquiredSlotForFailure();
                return;
              }
              const rewrittenObj = {
                ...enrichedParsed,
                traceId: turnTraceIdCapture,
                ...(codexRouteFrame !== null ? { __oc_codex_route: codexRouteFrame } : {}),
                ...(grokRouteFrame !== null ? { __oc_grok_route: grokRouteFrame } : {}),
                // billing 未启用(legacy NULL 容器 / 测试):无 server requestId 可绑,
                // 仍必须签票 —— 容器侧(flag 开)对无 envelope 的帧一律拒。
                ...authorityFields,
                // durable dispatch envelope(记录存在才注;此分支通常无 durable capability)。
                ...dispatchAuthorityField(dispatchRecordB),
              };
              const rewrittenStr = JSON.stringify(rewrittenObj);
              const rewrittenLen = Buffer.byteLength(rewrittenStr);
              if (rewrittenLen > maxFrameBytes) {
                turnLogCapture?.error("user-chat-bridge: rewritten codex frame too big (no billing)", {
                  rewrittenLen, max: maxFrameBytes,
                });
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendTurnErrorFrame(
                    "ERR_FRAME_TOO_BIG",
                    `rewritten frame ${rewrittenLen} > max ${maxFrameBytes}`,
                  );
                  try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
                }
                releaseAcquiredSlotForFailure();
                return;
              }
              frameForwardData = Buffer.from(rewrittenStr, "utf8");
              frameForwardLen = rewrittenLen;
            }

            // 已 acquire(+ billing 注册若启用)完毕,继续同步 forward 路径
            // (等价于"放行 frame")。两条分支都已 rewrite 注入 traceId(CG2a 合同)。
            turnForwarded = await forwardPreparedFrame(
              frameForwardData,
              frameForwardIsBinary,
              frameForwardLen,
            );
            codexTurnState.turnForwarded = turnForwarded;
            if (turnForwarded && dispatchRequest) {
              promptQueueDispatchCancellations.set(dispatchRequest.grantId, {
                request: dispatchRequest,
                cancel: async (reasonCode) => {
                  releaseCodexTurnState(codexTurnState, `prompt_queue_${reasonCode}`);
                },
              });
            }
          } catch (err) {
            const errName = (err as { name?: string } | null | undefined)?.name ?? "";
            if (errName === "ContainerStaleBindingError") {
              // codexBinding.acquire 探测到 NULL 绑定但池子非空 — 已在 acquire 内
              // mark vanished + await stopAndRemoveV3Container 把 docker 实体清掉。
              // 本 turn 还没 acquire 任何 slot / 没注册 inflight billing(都在 try{}
              // 块里 acquire 之后),因此**不要**调 releaseAcquiredSlotForFailure
              // (no-op 但语义混淆)。直接通知前端 + 关连接 — 用户重发会触发
              // ensureRunning 重 provision,picker 落 per-container mount,然后正常工作。
              turnLogCapture?.info("user-chat-bridge: codex container stale, recycled", {
                err: (err as Error)?.message,
              });
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendTurnErrorFrame(
                  "CODEX_CONTAINER_RECYCLED",
                  "GPT 账号配置已变更,容器已自动重建,请刷新页面后重发",
                );
                try { userWs.close(CLOSE_BRIDGE.ENV_RECYCLED, "codex_container_recycled"); } catch { /* */ }
              }
            } else if (errName === "CodexRouteUnavailable") {
              turnLogCapture?.info("user-chat-bridge: codex api relay route unavailable");
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendTurnErrorFrame(
                  "CODEX_ROUTE_UNAVAILABLE",
                  `${engineDisplayName} 服务暂时不可用，请稍后重试。`,
                );
              }
            } else if (errName === "AccountPoolBusyError") {
              turnLogCapture?.info("user-chat-bridge: codex pool busy, fast-fail");
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendTurnErrorFrame(
                  "CODEX_POOL_BUSY",
                  "当前请求较多，请稍后重试。",
                );
              }
            } else {
              turnLogCapture?.warn("user-chat-bridge: codex acquire failed", { err });
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendTurnErrorFrame(
                  "CODEX_UNAVAILABLE",
                  `${engineDisplayName} 服务暂时不可用，请稍后重试。`,
                );
              }
            }
          } finally {
            codexTurnState.acquireInflight = false;
            if (!turnForwarded) {
              releaseCodexTurnState(codexTurnState, "not_forwarded");
              // durable dispatch:本 IIFE 一切 pre-forward 失败出口(route/acquire/preCheck/
              // journal/seal/frame-too-big/disconnect)在此单点 CAS terminal + 移除记录,
              // 避免逐点埋点漏项;成功 forward 的记录留给心跳(终态由 tape finalize 收敛)。
              failDispatchPreForward(dispatchRecordB, "codex_pre_forward_abandoned");
            }
          }
        })();
        return; // 同步路径不再 forward,等 async 完成后由 forwardInboundFrame 走
      }
      // CG2a — 非 codex 路径(claude-* 文本 / hello / repo_bind / 普通透传):若本帧是
      // inbound.message(已 sanitize parsed + 生成 canonical),把 traceId 注入再 forward;
      // 其他帧(非 JSON / binary / 非 inbound.message)turnTraceIdForFrame === null →
      // 不 rewrite,走原 raw 透传。
      // CG2b — 注意:trace 注入是契约,不能因为 deps.logger 缺失而失效。turnLogForFrame
      // 只用作 best-effort 日志(optional chain),不参与 trace gate;真正的 gate 仍是
      // inboundParsedFrame !== null && turnTraceIdForFrame !== null 这对同步生成的双胞胎。
      if (inboundParsedFrame !== null && turnTraceIdForFrame !== null) {
        const inboundParsedCapture = inboundParsedFrame;
        const turnTraceIdCapture = turnTraceIdForFrame;
        const turnLogCapture = turnLogForFrame;
        const authorityModelCapture = authorityModelForFrame;
        const classifiedCodexCapture = isCodexInboundFrame;
        const ccbTurnIdentity = inboundTurnIdentityForFrame;
        void (async () => {
          // M6:总括 try/catch —— CCB turn 无预扣/journal/槽(计费在 egress 逐请求结算),一切
          // **意外**异常必须收敛成「dispatch 终态化 + error 帧 + queue grant 取消」,禁 unhandled rejection。
          // dispatchRecordC 声明在 try 外供 catch 兜底。
          let dispatchRecordC: AdmittedDispatch | undefined;
          try {
            // 模型执行权威:epoch fence + descriptor。CCB turn 的计费在 egress 侧按请求
            // 结算(见方案 §4),此处拒帧无需任何回滚。
            //
            // classifiedCodex 传**同步分类结果**而不是 false:走到这条路径的 codex 帧
            // 是"没注 codexBinding/createCodexRoute"的降级形态(测试 / 个人版),它的
            // engine 确实是 codex —— 传 false 会把这类帧误判成 engine 漂移。
            let authorityExec: ResolvedTurnExecution | null = null;
            if (authorityOn) {
              authorityExec = await resolveAuthorityExecOrReject({
                model: authorityModelCapture,
                classifiedCodex: classifiedCodexCapture,
                log: turnLogCapture,
                onReject: rejectPromptQueueDispatch,
                turn: ccbTurnIdentity,
              });
              if (authorityExec === null) return;
            }
            const enrichedParsed = await attachMasterTurnState(
              inboundParsedCapture,
              turnLogCapture,
              turnTraceIdCapture,
              !isPromptQueueDispatch,
              rejectPromptQueueDispatch,
              authorityModelCapture,
              recoveryJob,
            );
            if (enrichedParsed === null) return;
            dispatchRecordC = lookupAdmittedDispatch(enrichedParsed);
            const authorityTurnId = authorityExec === null
              ? undefined
              : authorityDeps!.signer.mintAuthorityTurnId();
            if (authorityTurnId !== undefined && dispatchRecordC !== undefined) {
              try {
                if (!deps.pgPool) throw new Error("authority turn dispatch binding requires pgPool");
                await bindAuthorityTurnDispatch(deps.pgPool, {
                  authorityTurnId,
                  dispatchId: dispatchRecordC.dispatchId,
                  userId: uid,
                  sessionId: dispatchRecordC.sessionId,
                  dispatchModel: typeof enrichedParsed.model === "string" ? enrichedParsed.model : null,
                  canonicalModel: authorityExec!.canonicalModel,
                  attemptNo: dispatchRecordC.attemptNo,
                  ownerId: connId,
                  leaseEpoch: dispatchRecordC.leaseEpoch,
                });
              } catch (err) {
                turnLogCapture?.error("user-chat-bridge: authority turn dispatch binding failed", {
                  err,
                  dispatchId: dispatchRecordC.dispatchId,
                });
                rejectPromptQueueDispatch("DURABLE_DISPATCH_UNAVAILABLE");
                failDispatchPreForward(dispatchRecordC, "authority_turn_dispatch_unavailable");
                if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                  sendErrorFrame(
                    userWs,
                    "DURABLE_DISPATCH_UNAVAILABLE",
                    "durable dispatch attribution unavailable, retry this turn shortly",
                    ccbTurnIdentity,
                  );
                }
                return;
              }
            }
            // 签发边界(MAJOR-2):CCB turn 的计费在 egress 逐请求结算,此处无预扣/无 journal
            // → 无需补偿;但 epoch 重读一样不能省 —— 拿过时快照签出的票 lease 长达 50min,
            // 会让「刚被 admin 撤销的模型」在这条 turn 里继续跑到 egress 的下一次 fence 才拦下。
            let authorityFields: Record<string, unknown> = {};
            if (authorityExec !== null) {
              const sealed = await sealAuthorityFieldsOrReject({
                exec: authorityExec,
                // B7a:CCB turn 把 dispatch 的稳定 billingRequestId 签进 model-authority envelope,
                // egress gate 据此反查 dispatch 身份写 usage_records.dispatch_id/attempt_no(否则
                // CCB 计费行丢失 turn↔dispatch 关联)。legacy(无 dispatch 记录)→ undefined 不带。
                ...(dispatchRecordC ? { billingRequestId: dispatchRecordC.billingRequestId } : {}),
                ...(authorityTurnId === undefined ? {} : { authorityTurnId }),
                log: turnLogCapture,
                onReject: rejectPromptQueueDispatch,
                turn: ccbTurnIdentity,
              });
              if (sealed === null) { failDispatchPreForward(dispatchRecordC, "authority_seal_rejected"); return; }
              authorityFields = sealed;
            }
            if (cleaned) { failDispatchPreForward(dispatchRecordC, "bridge_cleaned"); return; }
            const rewrittenObj = {
              ...enrichedParsed,
              traceId: turnTraceIdCapture,
              ...authorityFields,
              // durable dispatch envelope(容器 durable inbox 准入 + at-most-once)。
              ...dispatchAuthorityField(dispatchRecordC),
            };
            const rewrittenStr = JSON.stringify(rewrittenObj);
            const rewrittenLen = Buffer.byteLength(rewrittenStr);
            if (rewrittenLen > maxFrameBytes) {
              turnLogCapture?.error("user-chat-bridge: rewritten inbound frame too big", {
                rewrittenLen, max: maxFrameBytes,
              });
              failDispatchPreForward(dispatchRecordC, "ERR_FRAME_TOO_BIG");
              if (!cleaned && userWs.readyState === WebSocket.OPEN) {
                sendErrorFrame(
                  userWs,
                  "ERR_FRAME_TOO_BIG",
                  `rewritten frame ${rewrittenLen} > max ${maxFrameBytes}`,
                  ccbTurnIdentity,
                );
                try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
              }
              return;
            }
            // forwardPreparedFrame:queue lane 兜住 promptQueueResolved;browser lane 等价
            // forwardInboundFrame。dispatch 已 accepted 交容器,forward 后不终态化。
            await forwardPreparedFrame(Buffer.from(rewrittenStr, "utf8"), false, rewrittenLen);
          } catch (err) {
            bridgeLog?.error("user-chat-bridge: ccb inbound IIFE unexpected error", { err });
            rejectPromptQueueDispatch("ERR_INTERNAL");
            failDispatchPreForward(dispatchRecordC, "ccb_inbound_unexpected_exception");
            if (!cleaned && userWs.readyState === WebSocket.OPEN) {
              sendErrorFrame(userWs, "ERR_INTERNAL", "internal error", ccbTurnIdentity);
            }
          }
        })();
        return;
      }
      const passthroughForward = forwardPreparedFrame(passthroughData, isBinary, passthroughLen);
      if (passthroughForward instanceof Promise) void passthroughForward;
    };

    const onUserMessage = (
      data: RawData,
      isBinary: boolean,
      receivedAtMs = Date.now(),
    ): void => {
      executeAdmittedTurn(data, isBinary, "browser", undefined, undefined, receivedAtMs);
    };

    /**
     * plan v3 G5 — 把"已通过 authz / codex acquire"的 inbound 帧实际推到容器侧。
     *
     * 抽出本函数是因为同一段 forward 逻辑要在两处复用:
     *   (1) onUserMessage 同步路径(非 codex 帧 / 已知 legacy NULL 容器 / 没注 codexBinding)
     *   (2) codex acquire async IIFE 成功分支
     *
     * 责任:
     *   - 设置 firstUserFrameAtMs(TTFT 起点;oversize / authz 拒绝路径已 return)
     *   - 60s debounce 内最多刷一次 last_ws_activity(防 chatty 用户)
     *   - containerWs OPEN → sendToContainer;否则 push 到 preopenQueue(直到容器 OPEN)
     *   - preopenQueue 超 maxBufferedBytes → backpressure 关连接
     *
     * 不重复 frame size / authz / codex 单飞校验:那些必须在帧到达 onUserMessage 时
     * 立刻判定(同步上下文),已在调用本函数前完成。本函数只关心"放行后的物理转发"。
     */
    function forwardInboundFrame(data: RawData, isBinary: boolean, len: number): boolean {
      if (markActivity && containerId !== undefined) {
        const now = Date.now();
        if (now - lastActivityRefreshAt >= ACTIVITY_REFRESH_INTERVAL_MS) {
          lastActivityRefreshAt = now;
          try { markActivity(containerId); } catch { /* swallow — bridge 不挂 */ }
        }
      }
      if (containerWs.readyState !== WebSocket.OPEN) {
        // 容器还没 OPEN(早到帧场景);ws.send 在 CONNECTING 状态下抛
        // → 暂存到 ws lib 的 send buffer 里 = 不可控。这里直接 buffer 起来,
        // OPEN 后冲刷;若超 buffer 上限 → backpressure
        if (bufferedUC + len > maxBufferedBytes) {
          // 背压=连接态瞬态信号:只走 close code,不发 turn 级 error 帧(重连+resume 自愈,
          // 不在会话正文钉卡)。
          try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
          // backpressure → force final;一般无 inflight,即便有也异常态不 drain
          cleanup("backpressure", true);
          return false;
        }
        bufferedUC += len;
        metrics.onBufferedBytes?.(uid, "user_to_container", bufferedUC);
        preopenQueue.push({ data, isBinary, len });
        return true;
      }
      return sendToContainer(data, isBinary, len);
    }

    const sendToContainer = (data: RawData, isBinary: boolean, len: number): boolean => {
      try {
        containerWs.send(data, { binary: isBinary }, (err) => {
          if (err) {
            bridgeLog?.warn("user-chat-bridge: container send error", { err });
          }
        });
        bytesUC += len;
        metrics.onUserFrame?.(uid, len, isBinary);
        return true;
      } catch (err) {
        bridgeLog?.warn("user-chat-bridge: container send threw", { err });
        try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent send failed"); } catch { /* */ }
        // 容器 send 抛 = 容器 socket 已不可用,billing 帧也来不了 → force final
        cleanup("container_error", true);
        return false;
      }
    };

    const preopenQueue: Array<{ data: RawData; isBinary: boolean; len: number }> = [];
    let loggedRejectedContainerIncident = false;

    const onContainerMessage = (data: RawData, isBinary: boolean): void => {
      const len = rawDataLen(data);
      if (len > maxFrameBytes) {
        bridgeLog?.warn("user-chat-bridge: container frame too big", {
          len, max: maxFrameBytes,
        });
        sendErrorFrame(userWs, "ERR_FRAME_TOO_BIG",
          `container frame ${len} > max ${maxFrameBytes}`);
        try { userWs.close(CLOSE_BRIDGE.TOO_BIG, "frame too big"); } catch { /* */ }
        // 容器协议错 → force final
        cleanup("frame_too_big", true);
        return;
      }
      // ── 容器 attestation 帧(方案 §7 步 3/4)────────────────────────────────
      // container→master 的内部控制帧,**绝不**透传给浏览器(与 outbound.codex_billing
      // 同款拦截:cheap string 预筛,不解 JSON 影响热路径)。必须在 TTFT 观测之前处理 ——
      // attest 是连接握手的一部分,不是"容器的第一帧响应"。
      if (!isBinary) {
        let attestPeek: string | null = null;
        if (typeof data === "string") attestPeek = data;
        else if (Buffer.isBuffer(data)) {
          try { attestPeek = data.toString("utf8"); } catch { attestPeek = null; }
        }
        if (attestPeek !== null && attestPeek.includes(`"${CONTAINER_ATTEST_FRAME_TYPE}"`)) {
          let parsedAttest: unknown = null;
          try { parsedAttest = JSON.parse(attestPeek); } catch { /* 非 JSON → 落回常规路径 */ }
          if (
            parsedAttest !== null && typeof parsedAttest === "object" &&
            (parsedAttest as { type?: unknown }).type === CONTAINER_ATTEST_FRAME_TYPE
          ) {
            onContainerAttest(parsedAttest as Record<string, unknown>);
            return;
          }
        }
        if (attestPeek !== null && attestPeek.includes('"outbound.external_engine_billing"')) {
          let external: unknown = null;
          try { external = JSON.parse(attestPeek); } catch { /* rejected below */ }
          if (isPlainRecord(external) && external.type === 'outbound.external_engine_billing') {
            const requestId = typeof external.requestId === 'string' && /^[0-9a-f]{32}$/.test(external.requestId) ? external.requestId : null;
            const status = external.status === 'success' || external.status === 'error' || external.status === 'unavailable' ? external.status : null;
            const terminalCode = external.terminalCode === 'USER_CANCELLED' || external.terminalCode === 'AUTH_UNAVAILABLE' || external.terminalCode === 'QUOTA_UNAVAILABLE' || external.terminalCode === 'ENGINE_ERROR' ? external.terminalCode : null;
            const durationMs = typeof external.durationMs === 'number' && Number.isFinite(external.durationMs) && external.durationMs >= 0 ? Math.floor(external.durationMs) : null;
            const usage = isPlainRecord(external.usage) ? external.usage : null;
            if (deps.pgPool && requestId && status && durationMs !== null && external.engine === 'zcode') {
              const pool = deps.pgPool;
              const pricing = deps.pricing;
              const relay = pendingZcodeRelays.get(requestId);
              if (relay) {
                deps.expireZcodeRoute?.(relay.token);
                pendingZcodeRelays.delete(requestId);
              }
              trackZcodeAuditWork((async () => {
                const outcome = await closeZcodeAuditWithRetry(pool, {
                  requestId,
                  userId: uid,
                  status,
                  terminalCode,
                  durationMs,
                  usage,
                });
                applyZcodeFinalizeOutcome(pendingZcodeRequestIds, requestId, outcome);
                if (outcome === "failed") {
                  bridgeLog?.warn("user-chat-bridge: ZCode audit close fail-closed", { requestId, outcome });
                }
                const canaryTerminal = outcome === "closed" || outcome === "already_terminal";
                if (!canaryTerminal && pricing && (relay?.modelId === "glm-5.3-zai" || outcome === "unknown")) {
                  try {
                    const settled = await settleZcodeCatalogUsage({
                      pool,
                      pricing,
                      userId: uid,
                      requestId,
                      modelId: "glm-5.3-zai",
                      sessionId: relay?.sessionId ?? null,
                      engineStatus: status,
                      terminalCode,
                      usage,
                    });
                    if (settled === null) {
                      bridgeLog?.warn("user-chat-bridge: ZCode catalog settle skipped, pricing missing", { requestId });
                    } else {
                      await publishZcodeCatalogSettle({
                        settled,
                        requestId,
                        userId: uid.toString(),
                        modelId: "glm-5.3-zai",
                        sessionId: relay?.sessionId ?? null,
                        traceId: relay?.traceId ?? null,
                        persist: deps.appendCostCredits,
                        publish: (event) => { broadcastToUser(uid, event); },
                        onPersistError: (err) => {
                          bridgeLog?.warn("user-chat-bridge: ZCode persist costCredits threw", {
                            requestId,
                            err,
                          });
                        },
                      });
                    }
                  } catch (err) {
                    bridgeLog?.warn("user-chat-bridge: ZCode catalog settle failed", { requestId, err });
                  }
                }
              })());
            } else if (deps.pgPool && requestId && status && durationMs !== null && external.engine === 'cursor') {
              const pool = deps.pgPool;
              const pricing = deps.pricing;
              void (async () => {
                try {
                  const updated = await pool.query<{ model_id: string; session_id: string | null }>(
                    `UPDATE cursor_external_usage_audit
                        SET status=$2, terminal_code=$3, duration_ms=$4, reported_usage=$5, completed_at=NOW()
                      WHERE request_id=$1 AND user_id=$6 AND status='pending'
                    RETURNING model_id, session_id`,
                    [requestId, status, terminalCode, durationMs, usage, uid],
                  );
                  let modelId = updated.rows[0]?.model_id ?? null;
                  let sessionId = updated.rows[0]?.session_id ?? null;
                  if (modelId === null) {
                    const existing = await pool.query<{ model_id: string; session_id: string | null }>(
                      `SELECT model_id, session_id FROM cursor_external_usage_audit
                        WHERE request_id=$1 AND user_id=$2`,
                      [requestId, uid],
                    );
                    modelId = existing.rows[0]?.model_id ?? null;
                    sessionId = existing.rows[0]?.session_id ?? sessionId;
                  }
                  let cursorAccountId: bigint | null = null;
                  try {
                    cursorAccountId = await resolveUsedCursorAccountId(external.cursorSlotResults);
                  } catch (resolveErr) {
                    bridgeLog?.warn('user-chat-bridge: Cursor account attribution failed', { requestId, err: resolveErr });
                  }
                  if (modelId !== null) {
                    try {
                      await applyLearnedCursorQuota({
                        modelId,
                        terminalCode,
                        slotResults: external.cursorSlotResults,
                      });
                    } catch (learnErr) {
                      bridgeLog?.warn('user-chat-bridge: Cursor quota-class learn failed', { requestId, err: learnErr });
                    }
                  }
                  if (modelId === null) {
                    bridgeLog?.warn('user-chat-bridge: Cursor settle skipped, audit model_id missing', { requestId });
                  } else if (!pricing) {
                    bridgeLog?.warn('user-chat-bridge: Cursor settle skipped, pricing cache missing', { requestId, modelId });
                  } else {
                    const settled = await settleCursorExternalUsage({
                      pool,
                      pricing,
                      userId: uid,
                      requestId,
                      modelId,
                      sessionId,
                      engineStatus: status,
                      terminalCode,
                      usage,
                      accountId: cursorAccountId,
                    });
                    if (settled === null) {
                      bridgeLog?.warn('user-chat-bridge: Cursor settle skipped, model pricing not in cache', { requestId, modelId });
                    } else if (
                      settled.debitedCredits !== null &&
                      settled.debitedCredits > 0n &&
                      deps.appendCostCredits
                    ) {
                      await deps.appendCostCredits(
                        requestId,
                        uid.toString(),
                        settled.debitedCredits.toString(),
                        sessionId,
                      );
                    }
                  }
                } catch (err) {
                  bridgeLog?.warn('user-chat-bridge: Cursor platform settle failed', { requestId, err });
                }
              })();
            } else {
              bridgeLog?.warn('user-chat-bridge: malformed external engine billing frame dropped');
            }
            return;
          }
        }
        // ── turn_dispatch_receipt(RFC §3.b)── 容器已持有该逻辑键的 inbox 行(重复
        // 到达/接管重发)。内部控制帧,绝不透传浏览器。消费 = dispatch CAS accepted +
        // 本连接放下转发所有权(容器已拥有执行,lease 心跳不再由本桥续)。
        if (attestPeek !== null && attestPeek.includes('"outbound.control.turn_dispatch_receipt"')) {
          let parsedReceipt: unknown = null;
          try { parsedReceipt = JSON.parse(attestPeek); } catch { /* 非 JSON → 落回常规路径 */ }
          if (
            parsedReceipt !== null && typeof parsedReceipt === "object" &&
            (parsedReceipt as { type?: unknown }).type === "outbound.control.turn_dispatch_receipt"
          ) {
            const receipt = parsedReceipt as { clientMessageId?: unknown; dispatchId?: unknown };
            const cmid = isClientMessageId(receipt.clientMessageId) ? receipt.clientMessageId : null;
            const rec = cmid !== null ? admittedDispatches.get(cmid) : undefined;
            if (
              rec !== undefined &&
              typeof receipt.dispatchId === "string" &&
              receipt.dispatchId === rec.dispatchId
            ) {
              const pool = deps.pgPool;
              if (pool) {
                if (rec.recoveryJob) {
                  void markRecoveryContainerReceipt(pool, {
                    dispatchId: rec.dispatchId,
                    dispatchAttemptNo: rec.attemptNo,
                    expectedDispatchLeaseEpoch: rec.leaseEpoch,
                  }).catch(() => {});
                } else {
                  void casAdmittedToAccepted(pool, {
                    dispatchId: rec.dispatchId,
                    expectedEpoch: rec.leaseEpoch,
                  }).catch(() => {});
                }
              }
              dropAdmittedDispatch(rec.clientMessageId);
            }
            return;
          }
        }
        // Durable Stop/permission runtime receipt. Commit the lifecycle edge
        // before notifying tabs; if PG is unavailable the lease expires and
        // the identical control is retried instead of being guessed applied.
        if (attestPeek !== null && attestPeek.includes('"outbound.control.receipt"')) {
          let parsedControl: unknown = null;
          try { parsedControl = JSON.parse(attestPeek); } catch { /* ordinary frame */ }
          if (
            isPlainRecord(parsedControl) &&
            parsedControl.type === "outbound.control.receipt" &&
            isControlId(parsedControl.controlId) &&
            (parsedControl.status === "applied" || parsedControl.status === "terminal")
          ) {
            if (!deps.pgPool) return;
            const receipt = parsedControl as {
              controlId: string
              status: "applied" | "terminal"
              errorCode?: unknown
            };
            void markTurnControlReceipt(deps.pgPool, {
              userId: uid,
              controlId: receipt.controlId,
              status: receipt.status,
              errorCode: typeof receipt.errorCode === "string" ? receipt.errorCode : null,
            }).then((committed) => {
              if (committed) broadcastToUser(uid, parsedControl);
            }).catch((error) => {
              bridgeLog?.warn("user-chat-bridge: durable control receipt commit failed", {
                controlId: receipt.controlId,
                error,
              });
            });
            return;
          }
        }
      }
      // Queue dispatch is a container→master control request, never a browser
      // broadcast. Convert it into one ordinary inbound.message and feed that
      // message through the exact same authority/route/precheck/journal helper
      // as a legacy turn. The private correlation comes back to the gateway only
      // after those gates have succeeded.
      if (!isBinary) {
        let dispatchText: string | null = null;
        if (typeof data === "string") dispatchText = data;
        else if (Buffer.isBuffer(data)) {
          try { dispatchText = data.toString("utf8"); } catch { dispatchText = null; }
        }
        if (dispatchText !== null) {
          let candidate: unknown = null;
          try { candidate = JSON.parse(dispatchText); } catch { /* ordinary non-JSON frame */ }
          const isActivatedEnvelope = isPlainRecord(candidate) &&
            candidate.type === PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE;
          if (isActivatedEnvelope && deps.promptQueueEnabled === true) {
            const activated = parsePromptQueueDispatchActivated(candidate);
            if (activated === null) {
              bridgeLog?.warn("user-chat-bridge: malformed prompt queue activation acknowledgement dropped");
              return;
            }
            const registered = promptQueueDispatchCancellations.get(activated.grantId);
            if (!registered || !samePromptQueueDispatch(activated, registered.request)) {
              bridgeLog?.warn("user-chat-bridge: stale or mismatched prompt queue activation acknowledgement dropped", {
                grantId: activated.grantId,
              });
              return;
            }
            // PG activation is the exact ownership boundary. From this point a
            // bridge disconnect must preserve ordinary cross-bridge billing;
            // only pre-activation registrations are eligible for compensation.
            promptQueueDispatchCancellations.delete(activated.grantId);
            return;
          }
          const isCancelEnvelope = isPlainRecord(candidate) &&
            candidate.type === PROMPT_QUEUE_DISPATCH_CANCEL_TYPE;
          if (isCancelEnvelope && deps.promptQueueEnabled === true) {
            const cancel = parsePromptQueueDispatchCancel(candidate);
            if (cancel === null) {
              bridgeLog?.warn("user-chat-bridge: malformed prompt queue dispatch cancel dropped");
              return;
            }
            const registered = promptQueueDispatchCancellations.get(cancel.grantId);
            if (!registered || !samePromptQueueDispatch(cancel, registered.request)) {
              bridgeLog?.warn("user-chat-bridge: stale or mismatched prompt queue cancel dropped", {
                grantId: cancel.grantId,
              });
              return;
            }
            // Delete before awaiting: duplicates and late terminal frames can
            // never invoke the accounting compensation twice.
            promptQueueDispatchCancellations.delete(cancel.grantId);
            trackPromptQueueCompensation(registered.cancel(cancel.reasonCode));
            return;
          }
          const isQueueEnvelope = isPlainRecord(candidate) &&
            candidate.type === PROMPT_QUEUE_DISPATCH_REQUEST_TYPE;
          // Flag-off means literal legacy behavior: even an exact queue-looking
          // container frame remains ordinary outbound traffic. A nested string
          // can never trigger the internal lane.
          if (!isQueueEnvelope || deps.promptQueueEnabled !== true) {
            // fall through to the pre-existing container→browser path
          } else {
          const request = parsePromptQueueDispatchRequest(candidate);
          if (request === null) {
            bridgeLog?.warn("user-chat-bridge: malformed prompt queue dispatch request dropped");
            return;
          }
          const canonicalSessionKey =
            `agent:${request.owner.agentId}:webchat:dm:${request.owner.peer.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
          if (request.owner.sessionKey !== canonicalSessionKey) {
            bridgeLog?.warn("user-chat-bridge: prompt queue dispatch owner mismatch", {
              sessionKey: request.owner.sessionKey,
            });
            return;
          }
          const execution = request.item.requestedExecution;
          const inbound = {
            type: "inbound.message",
            channel: "webchat",
            peer: request.owner.peer,
            agentId: request.owner.agentId,
            clientMessageId: request.item.clientMessageId,
            idempotencyKey: `prompt-queue:${request.grantId}`,
            content: request.item.content,
            ...(execution.model !== undefined ? { model: execution.model } : {}),
            ...(execution.modelSwitchId !== undefined ? { modelSwitchId: execution.modelSwitchId } : {}),
            ...(execution.effortLevel !== undefined ? { effortLevel: execution.effortLevel } : {}),
            ...(execution.teamMode !== undefined ? { teamMode: execution.teamMode } : {}),
            [PROMPT_QUEUE_GRANT_FIELD]: {
              grantId: request.grantId,
              itemId: request.item.itemId,
              contentHash: request.item.contentHash,
              epoch: request.claim.epoch,
              claimToken: request.claim.claimToken,
            },
          };
          executeAdmittedTurn(
            Buffer.from(JSON.stringify(inbound), "utf8"),
            false,
            "prompt_queue",
            request,
          );
          return;
          }
        }
      }
      // Incident, GoalState and durable media progress are master-authored namespaces.
      // Containers are tenant-controlled execution surfaces and must never forge
      // either an approval notice or the platform-authoritative PG GoalState.
      // Reject before TTFT accounting, outboundRing.storeStamped and live forwarding,
      // so a forged approved_recovery cannot reach the user now or on reconnect replay.
      const incidentCandidate = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : Buffer.concat(data).toString("utf8");
      let parsedMasterFrameCandidate: unknown = null;
      try { parsedMasterFrameCandidate = JSON.parse(incidentCandidate); } catch { /* non-JSON remains normal traffic */ }
      const masterOnlyFrameType =
        parsedMasterFrameCandidate !== null && typeof parsedMasterFrameCandidate === "object"
          ? (parsedMasterFrameCandidate as { type?: unknown }).type
          : null;
      if (
        masterOnlyFrameType === "sys.incident" || masterOnlyFrameType === "sys.goal_snapshot" ||
        masterOnlyFrameType === "sys.media_job"
      ) {
        if (!loggedRejectedContainerIncident) {
          loggedRejectedContainerIncident = true;
          bridgeLog?.warn("user-chat-bridge: rejected container-authored master-only frame", {
            type: masterOnlyFrameType,
          });
        }
        return;
      }
      // PR2 v1.0.66 — outbound.codex_billing 是 container→master 内部侧信道,
      // **绝不**透传给用户浏览器(用户不可见 billing,且帧含内部计费字段)。
      //
      // **必须在 userWs.readyState 检查之前**:
      //   - drain 期 userWs 已关(detachUserSide → unregister),但 inflightCodexTurns
      //     仍有 turn 等 billing 帧 settle。如果先 readyState gate 就 drop,用户跑路
      //     免费送 token(B.5 plan invariant)
      //   - 与 G6 早释放同一帧(outbound.message isFinal)无冲突 — 那个走 message
      //     type,billing 走 codex_billing type,互斥
      // cheap pre-filter:只对文本帧做 string includes,不解 JSON 影响热路径。
      if (!isBinary) {
        let billingPeek: string | null = null;
        if (typeof data === "string") billingPeek = data;
        else if (Buffer.isBuffer(data)) {
          try { billingPeek = data.toString("utf8"); } catch { billingPeek = null; }
        }
        if (billingPeek !== null && billingPeek.includes('"outbound.codex_billing"')) {
          let parsedBilling: unknown = null;
          try { parsedBilling = JSON.parse(billingPeek); } catch { /* 非 JSON 不该走到这,稳妥起见仍直返 */ }
          if (
            parsedBilling !== null && typeof parsedBilling === "object" &&
            (parsedBilling as { type?: unknown }).type === "outbound.codex_billing"
          ) {
            const billing = parsedBilling as {
              requestId?: unknown;
              turnKey?: unknown;
              parentTurnKey?: unknown;
              parentSessionId?: unknown;
              delegateAgentId?: unknown;
              engineSessionId?: unknown;
              status?: unknown;
              terminalCode?: unknown;
              errorReason?: unknown;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
                reasoning_output_tokens?: number;
              };
            };
            const reqId = typeof billing.requestId === "string" ? billing.requestId : null;
            if (reqId === null) {
              bridgeLog?.warn("user-chat-bridge: codex_billing missing requestId");
              return;
            }
            const billingTurnKey =
              typeof billing.turnKey === "string" && /^[0-9a-f]{64}$/.test(billing.turnKey)
                ? billing.turnKey
                : null;
            const billingParentTurnKey =
              typeof billing.parentTurnKey === "string" && /^[0-9a-f]{64}$/.test(billing.parentTurnKey)
                ? billing.parentTurnKey
                : null;
            const billingParentSessionId =
              typeof billing.parentSessionId === "string" &&
              billing.parentSessionId.length > 0 && billing.parentSessionId.length <= 256
                ? billing.parentSessionId
                : null;
            const billingDelegateAgentId =
              typeof billing.delegateAgentId === "string" &&
              /^[A-Za-z0-9_-]{1,64}$/.test(billing.delegateAgentId)
                ? billing.delegateAgentId
                : null;
            // —— 与 snapshot 无关的帧字段解析(主路径与跨桥 fallback 共用)——
            // M2 — engineSessionId fail-closed 校验(方案 §D 红线 2)。
            // settle 落 usage_records.session_id 的**唯一**权威 = 帧上的
            // engineSessionId(gateway 经 engineSessionId(sessionKey) 派生)。缺失
            // (旧容器镜像)/形状非法(伪造/漂移)→ **不扣费**(见下方两个消费点)。
            const engineSidRaw = billing.engineSessionId;
            const engineSid =
              typeof engineSidRaw === "string" && ENGINE_SESSION_ID_RE.test(engineSidRaw)
                ? engineSidRaw
                : null;
            const codexStatus: "success" | "error" =
              billing.status === "error" ? "error" : "success";
            const legacyErrorReason = typeof billing.errorReason === "string"
              ? billing.errorReason
              : undefined;
            const terminalCode = billing.terminalCode === "USER_CANCELLED" || billing.terminalCode === "CODEX_ERROR"
              ? billing.terminalCode
              : codexStatus === "error"
                ? legacyErrorReason === "codex turn interrupted" ? "USER_CANCELLED" : "CODEX_ERROR"
                : undefined;
            const u = billing.usage ?? {};
            // 防御性 number → 非负整数 BigInt:容器侧理论 emit 合法 number,但坏帧
            // (NaN / Infinity / 字符串 / 对象)若进来,raw `BigInt(Math.trunc(...))`
            // 会同步 throw 打崩 onContainerMessage。统一过 sanitizer 兜底归 0。
            const safeNum = (v: unknown): bigint => {
              if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
                return 0n;
              }
              return BigInt(Math.trunc(v));
            };
            // reasoning_output_tokens 折进 output_tokens — codex 内部把推理 token
            // 单独计,但代理商按总 output 收;cache_*_input_tokens 改名对齐 calculator。
            const usage: TokenUsage = {
              input_tokens: safeNum(u.input_tokens),
              output_tokens:
                safeNum(u.output_tokens) + safeNum(u.reasoning_output_tokens),
              cache_read_tokens: safeNum(u.cache_read_input_tokens),
              cache_write_tokens: safeNum(u.cache_creation_input_tokens),
            };
            const billingRl = (parsedBilling as { rateLimits?: unknown }).rateLimits;

            const snap = inflightCodexTurns.get(reqId);
            if (snap === undefined) {
              // billing 帧的 requestId 在本桥 inflight Map 里查不到。两类成因:
              //   - **同桥 duplicate**:同 reqId 的另一帧已进 settle/abandon(下方
              //     Map.delete + locallySettledCodexTurns.add 先行)→ 同步 info
              //     丢弃,不重复广播 cost_charged(旧语义保留);
              //   - **跨桥重连(P0 修复 2026-07-03)**:turn 在旧桥开启(journal
              //     inflight),用户断 WS 重连后容器把 billing 帧发到了新桥。旧实现
              //     只打日志丢帧 = 整 turn 免费(收入漏洞)。现在按 request_id 回查
              //     request_finalize_journal 裁决:inflight 行用 journal ctx 恢复
              //     settle；committed/finalizing 从 immutable attribution 恢复，
              //     finalizing 尚无可见证据时保持可重试；aborted 免单 + 告警。
              if (locallySettledCodexTurns.has(reqId)) {
                const retryingGrokLease = pendingGrokLeaseReleases.has(reqId);
                if (retryingGrokLease) retryPendingGrokLeaseRelease(reqId);
                bridgeLog?.info(retryingGrokLease
                  ? "user-chat-bridge: duplicate terminal billing retries pending durable Grok lease release"
                  : "user-chat-bridge: codex_billing duplicate for locally settled turn — dropped", {
                  requestId: reqId,
                });
                return;
              }
              handleCrossBridgeCodexBilling({
                requestId: reqId,
                engineSid,
                engineSidRaw,
                codexStatus,
                terminalCode,
                usage,
                billingRl,
                turnKey: billingTurnKey,
                parentTurnKey: billingParentTurnKey,
                parentSessionId: billingParentSessionId,
                delegateAgentId: billingDelegateAgentId,
              });
              return;
            }
            // **同步** delete:duplicate billing 帧第二次进这个分支 Map.get 拿
            // undefined,由上方 locallySettledCodexTurns 门控直接 return,不会再起
            // 一个 IIFE 重复广播 cost_charged。finalizer._done 守门只防 ledger 重复
            // debit,但两个 IIFE 各自 await commit 后都会读 result.debitedCredits>0
            // 各广播一次 — 用 Map.delete + 本地簿记早断。
            inflightCodexTurns.delete(reqId);
            locallySettledCodexTurns.add(reqId);
            // requestId resolves to this exact turn snapshot, so the internal
            // terminal billing frame can release even if a legacy gateway does
            // not echo peer/clientMessageId on its later user-facing final frame.
            snap.releaseBridgeTurnState?.("turn_billing_terminal");
            // CG2c — billing settle 路径的 log 钉到 turn 的 server-owned trace。
            // child 一次,后续 quota / commit / persist 三个分支都用 billingLog;
            // requestId 经 binding 提供,call-site 不再手写。**只读 snap.traceId,
            // 不解析 frame.traceId** —— 防容器侧伪造影响计费观测。
            const billingLog = bridgeLog?.child({
              traceId: snap.traceId,
              requestId: reqId,
            }) ?? null;
            // Issue A v1.0.108 — codex `account/rateLimits/updated` 通知 piggy-back
            // 到 billing 帧的 rateLimits 字段(runner 已转 Anthropic-shape)。
            // 与 ledger commit 解耦走独立 fire-and-forget,理由:
            //   - quota 是 best-effort 可见性,不应被 ledger commit 结果阻塞
            //   - 写在 commit 之前,避免 commit IIFE swallow exception 时 quota 也被吞
            //   - quota.ts 内部对 accountId === 0n / "0" 跳过(legacy 无关联账号)
            //   - quota.ts 30s SQL+JS 双层 throttle 兜底重复写
            if (
              billingRl &&
              typeof billingRl === "object" &&
              deps.pgPool
            ) {
              const r = billingRl as {
                util5h?: number;
                reset5h?: string;
                util7d?: number;
                reset7d?: string;
              };
              void maybeUpdateAccountQuotaCodex(
                deps.pgPool,
                snap.accountId,
                r,
              ).catch((err) => {
                billingLog?.debug("user-chat-bridge: codex quota write failed", {
                  err: (err as Error)?.message,
                });
              });
            }
            // engineSessionId fail-closed(解析已上移):缺失 / 形状非法 →
            // **不扣费**:abandon(abort journal + release reservation)+ error
            // 告警。宁可少收不可乱扣；逻辑 turn 免单的账务归因另用
            // turnKey / parentTurnKey 精确完成，不依赖该会话字段。
            if (engineSid === null) {
              billingLog?.error("user-chat-bridge: codex_billing engineSessionId missing/invalid — waiving turn (fail-closed)", {
                engineSessionId: typeof engineSidRaw === "string" ? engineSidRaw.slice(0, 80) : typeof engineSidRaw,
              });
              void (async () => {
                try {
                  await snap.abandon("codex_billing_engine_session_id_invalid");
                } catch (err) {
                  billingLog?.error("user-chat-bridge: codex abandon threw", {
                    err: (err as Error)?.message,
                  });
                } finally {
                  if (drainCause !== null) {
                    recordBillingRecovery(reqId, "abandoned", snap, 2);
                  }
                  expireCodexRouteToken(snap.codexRouteToken, "billing_engine_session_id_invalid");
                  checkDrainComplete();
                }
              })();
              return;
            }
            // codexStatus / stable terminalCode / usage 解析已上移(主路径与跨桥 fallback 共用)。
            // fire-and-forget settle:Map 已 delete,duplicate 帧不会再触发;commit
            // 内部 _done 守门兜底防 finalCleanup 同时调 fail 时重复 debit。
            // M2:settle 收口 = codexFinalizer → settleUsageAndLedger → spendTwoBucket
            // (双钱包:期内桶优先/钱包兜底);零输出免单在 finalizer 层;
            // usage_records.account_id 恒 NULL;session_id = engineSid(上方已校验)。
            void (async () => {
              try {
                const finalizer = snap.getFinalizer(engineSid);
                if (finalizer === null) {
                  // abandon 已跑过(Map.delete 纪律下不可达)— 不再 settle,防错账。
                  billingLog?.error("user-chat-bridge: codex billing after abandon — skip settle");
                  return;
                }
                const result = await finalizer.commit(
                  usage, codexStatus, {
                    turnKey: billingTurnKey,
                    parentTurnKey: billingParentTurnKey,
                    parentSessionId: billingParentSessionId,
                    delegateAgentId: billingDelegateAgentId,
                    terminalCode,
                  },
                );
                if (drainCause !== null) {
                  recordBillingRecovery(reqId, "recovered", snap, 2);
                }
                // Persist/fold the usage locator even when the actual debit is
                // zero. The settlement transaction already staged this exact
                // amount atomically with usage_records/ledger; folding here
                // makes the live GoalState snapshot advance immediately.
                const persistedUsageCredits =
                  result.attributionCredits !== null && result.attributionCredits !== undefined
                    ? result.attributionCredits
                    : result.debitedCredits !== null && result.debitedCredits > 0n
                      ? result.debitedCredits
                      : null;
                if (persistedUsageCredits !== null) {
                  if (deps.appendCostCredits) {
                    try {
                      await deps.appendCostCredits(
                        reqId,
                        uid.toString(),
                        persistedUsageCredits.toString(),
                        engineSid,
                        billingParentSessionId,
                        billingDelegateAgentId,
                        billingTurnKey,
                        billingParentTurnKey,
                      );
                    } catch (err) {
                      billingLog?.warn("user-chat-bridge: codex persist costCredits threw", {
                        err: (err as Error)?.message,
                      });
                    }
                  }
                }
                // Only a real positive debit produces cost_charged. Zero-token,
                // waived/error, idempotent, and skipped paths stay invisible as
                // charges even though their usage attribution is durable.
                if (
                  result.debitedCredits !== null &&
                  result.debitedCredits > 0n
                ) {
                  // CG2c — broadcast 帧带 traceId 让 outboundRing audit / 前端 trace
                  // 关联到 inbound canonical。snap.traceId 是 server-owned 唯一可信源。
                  // M2:balanceAfter = **双钱包总可用**(spendTwoBucket.totalAfter,
                  // period_credits + users.credits),对齐前端余额气泡口径。
                  broadcastToUser(uid, {
                    type: "outbound.cost_charged",
                    requestId: reqId,
                    traceId: snap.traceId,
                    model: snap.model,
                    costCredits: result.costCredits.toString(),
                    debitedCredits: result.debitedCredits.toString(),
                    balanceAfter: result.balanceAfter !== null
                      ? result.balanceAfter.toString()
                      : null,
                    clamped: result.clamped,
                  });
                }
              } catch (err) {
                if (drainCause !== null) {
                  recordBillingRecovery(reqId, "failed", snap, 2);
                }
                billingLog?.error("user-chat-bridge: codex finalizer commit threw", {
                  err: (err as Error)?.message,
                });
              } finally {
                expireCodexRouteToken(snap.codexRouteToken, "billing_settled");
                checkDrainComplete();
              }
            })();
            return;
          }
        }
      }
      // Permission prompt authority is durable before browser visibility. The
      // exact runtime-authored tool identity/input survives a browser or
      // Master restart; bridge disconnect is therefore no longer an implicit
      // denial signal at the commercial boundary.
      let permissionAuthorityCommit: Promise<void> | null = null;
      if (!isBinary && deps.pgPool) {
        let permissionText: string | null = null;
        if (typeof data === "string") permissionText = data;
        else if (Buffer.isBuffer(data)) {
          try { permissionText = data.toString("utf8"); } catch { permissionText = null; }
        }
        if (permissionText?.includes('"outbound.permission_request"')) {
          let parsedPermission: unknown = null;
          try { parsedPermission = JSON.parse(permissionText); } catch { /* generic frame */ }
          if (
            isPlainRecord(parsedPermission) &&
            parsedPermission.type === "outbound.permission_request" &&
            typeof parsedPermission.requestId === "string" &&
            typeof parsedPermission.toolName === "string" &&
            isPlainRecord(parsedPermission.peer) &&
            typeof parsedPermission.peer.id === "string" &&
            isPlainRecord(parsedPermission.inputJson)
          ) {
            permissionAuthorityCommit = persistPermissionAuthority(deps.pgPool, {
              userId: uid,
              requestId: parsedPermission.requestId,
              sessionId: parsedPermission.peer.id,
              clientMessageId: isClientMessageId(parsedPermission.clientMessageId)
                ? parsedPermission.clientMessageId
                : null,
              toolUseId: typeof parsedPermission.toolUseId === "string"
                ? parsedPermission.toolUseId
                : null,
              toolName: parsedPermission.toolName,
              input: parsedPermission.inputJson,
              askPayload: parsedPermission.toolName === "AskUserQuestion"
                ? parsedPermission.inputJson
                : null,
              expiresAt: resolvePermissionExpiresAt(parsedPermission.expiresAt),
            }).then(() => {});
          }
        }
      }

      // Phase 4 — outbound.control.session_repo_status 侧信道(容器→master→user):
      //   master 须**先**落 DB(applyStatusFrame:更新 status / token_invalid 触发
      //   revoke + clear sessions),再让帧流到 userWs 让前端 UI 反映状态。
      //
      //   设计要点:
      //   - **不进 outbound ring**:status 帧不带 sessionKey/frameSeq,自然通不过下方
      //     ring 写入条件;且重连重放无意义(状态以 DB 为权威源)。
      //   - 与 codex_billing 不同,status 帧**要**透传给 userWs(用户需看到
      //     "cloning" / "ready" / "error" 进度);所以这里只 side-effect,不 return。
      //   - DB 写失败(stale ack 等)→ updateGithubWorkspaceStatusIfVersion 返回
      //     {updated:false},applyStatusFrame swallow,状态帧仍透传(用户至少能看到
      //     "已被新版本覆盖"的语义,不会卡住)。
      //   - cheap pre-filter 同 billing,不解 JSON 影响热路径。
      if (!isBinary) {
        let statusPeek: string | null = null;
        if (typeof data === "string") statusPeek = data;
        else if (Buffer.isBuffer(data)) {
          try { statusPeek = data.toString("utf8"); } catch { statusPeek = null; }
        }
        // turn 收尾(isFinal 帧)→ 把 turn 宽限收窄到 POST_FINAL_GRACE_MS(只缩不延):既给
        // cost_charged(isFinal 之后才广播)留投递窗口,又不让已结束 turn 的连接(浏览器可能已离开)
        // 长期占用到 10min 硬上限。仅在 turn 在飞时收窄(turnActiveUntil>0)。cheap 子串预筛。
        if (turnActiveUntil > 0 && statusPeek !== null && statusPeek.includes('"isFinal":true')) {
          turnActiveUntil = Math.min(turnActiveUntil, Date.now() + POST_FINAL_GRACE_MS);
        }
        if (
          statusPeek !== null &&
          statusPeek.includes('"outbound.control.session_repo_status"')
        ) {
          let parsedStatus: unknown = null;
          try { parsedStatus = JSON.parse(statusPeek); } catch { /* 非 JSON 跳过 */ }
          if (parsedStatus !== null && typeof parsedStatus === "object") {
            const statusFrame = parseStatusFrame(parsedStatus);
            if (statusFrame !== null && deps.pgPool) {
              const pgPoolBound = deps.pgPool;
              // fire-and-forget:DB 写后 status 帧仍透传给 userWs(下方 send 路径)。
              ;(async () => {
                try {
                  const r = await applyStatusFrame(pgPoolBound, Number(uid), statusFrame);
                  // v1.0.94 — 诊断 instrument。状态帧从容器到 user 这段也要可见,
                  // 才能区分「容器没推 status」和「bridge 推了但 user 没收到」。
                  bridgeLog?.info("user-chat-bridge: repo_status_forwarded", {
                    sessionId: statusFrame.sessionId,
                    selectionVersion: statusFrame.selectionVersion,
                    status: statusFrame.status,
                    errorCode: statusFrame.errorCode,
                    dbUpdated: r.dbUpdated,
                    revoked: r.revoked,
                  });
                } catch (err) {
                  bridgeLog?.warn("user-chat-bridge: applyStatusFrame failed", {
                    sessionId: statusFrame.sessionId, err,
                  });
                }
              })();
            }
            // 不 return — status 帧继续走透传路径让前端 UI 看到状态变化
          }
        }
      }
      // Engine-neutral first-visible boundary: ignore ACK/status/billing/attestation and
      // stop the clock only when an outbound.message contains a user-visible block.
      const firstVisible = extractFirstVisibleAttribution(parsedMasterFrameCandidate);
      if (firstVisible && !firstVisibleTraceIds.has(firstVisible.traceId)) {
        if (firstVisibleTraceIds.size >= 512) firstVisibleTraceIds.clear();
        firstVisibleTraceIds.add(firstVisible.traceId);
        if (firstContainerFrameAtMs === null && firstUserFrameAtMs !== null) {
          firstContainerFrameAtMs = Date.now();
          metrics.onTtft?.(uid, ttftKind, (firstContainerFrameAtMs - firstUserFrameAtMs) / 1000);
        }
        recordTurnFirstVisible(
          deps.pgPool,
          (message, fields) => bridgeLog?.warn(message, fields),
          firstVisible,
        );
      }
      // Phase 0.4 — bridge ring write for stamped outbound frames.
      //
      // Containers stamp `sessionKey + frameSeq` on outbound frames inside
      // the embedded personal-master gateway (see openclaude/packages/gateway
      // server.ts deliver()). We capture that stamp here for late-reconnect
      // replay. Crucially this MUST run before the userWs.readyState gate
      // below — the whole point of buffering is to keep the frame around
      // while the client is briefly absent.
      //
      // Idempotency: when the same user has multiple tabs, the container's
      // deliver() iterates clientsByPeer and broadcasts the same frame to
      // each tab's bridge.containerWs. Each bridge instance shares this
      // process-singleton ring, so we'd see the same `(storeKey, seq)` write
      // multiple times. `storeStamped` skips silently when `seq <= prevLast`.
      //
      let durableStampedFrame: {
        storeKey: string;
        sessionId: string | null;
        clientMessageId: string | null;
        sessionKey: string;
        frameSeq: number;
        payload: string;
      } | null = null;
      if (containerId !== undefined && !isBinary) {
        let frameStr: string | null = null;
        if (typeof data === "string") frameStr = data;
        else if (Buffer.isBuffer(data)) {
          try { frameStr = data.toString("utf8"); } catch { frameStr = null; }
        }
        if (frameStr !== null) {
          let parsedOut: unknown = null;
          try { parsedOut = JSON.parse(frameStr); } catch { /* non-JSON: skip */ }
          if (parsedOut !== null && typeof parsedOut === "object") {
            const wire = parsedOut as {
              sessionKey?: unknown;
              frameSeq?: unknown;
              clientMessageId?: unknown;
              peer?: { id?: unknown };
            };
            if (
              typeof wire.sessionKey === "string" &&
              typeof wire.frameSeq === "number" &&
              Number.isSafeInteger(wire.frameSeq) &&
              wire.frameSeq > 0
            ) {
              const storeKey = `${uid.toString()}:${containerId.toString()}:${wire.sessionKey}`;
              durableStampedFrame = {
                storeKey,
                sessionId: wire.peer && typeof wire.peer === "object" &&
                  typeof wire.peer.id === "string"
                  ? wire.peer.id
                  : null,
                clientMessageId: isClientMessageId(wire.clientMessageId)
                  ? wire.clientMessageId
                  : null,
                sessionKey: wire.sessionKey,
                frameSeq: wire.frameSeq,
                payload: frameStr,
              };
            }
          }
        }
      }
      // Codex-native goal notifications are advisory. The runner stamps the
      // platform generation it last synchronized; master rejects stale
      // generations and writes only engine-owned diagnostics.
      if (!isBinary && deps.updateGoalEngineMetrics) {
        let text: string | null = null;
        if (typeof data === "string") text = data;
        else if (Buffer.isBuffer(data)) text = data.toString("utf8");
        if (text?.includes('"kind":"goal"')) {
          try {
            const frame = JSON.parse(text) as {
              type?: unknown;
              peer?: { id?: unknown };
              blocks?: Array<Record<string, unknown>>;
            };
            const sessionId = frame.peer?.id;
            if (frame.type === "outbound.message" && typeof sessionId === "string") {
              for (const block of frame.blocks ?? []) {
                if (
                  block.kind !== "goal" ||
                  typeof block.platformGoalId !== "string" ||
                  typeof block.platformStateRevision !== "number"
                ) continue;
                void deps.updateGoalEngineMetrics({
                  uid,
                  sessionId,
                  goalId: block.platformGoalId,
                  stateRevision: block.platformStateRevision,
                  ...(typeof block.status === "string" ? { engineStatus: block.status } : {}),
                  ...(typeof block.tokensUsed === "number" ? { tokensUsed: block.tokensUsed } : {}),
                  ...(typeof block.timeUsedSeconds === "number"
                    ? { timeUsedSeconds: block.timeUsedSeconds }
                    : {}),
                  ...(typeof block.updatedAt === "number"
                    ? { engineUpdatedAt: new Date(block.updatedAt * 1000).toISOString() }
                    : {}),
                }).catch((err) => {
                  bridgeLog?.warn("user-chat-bridge: goal engine metrics update failed", { err });
                });
              }
            }
          } catch { /* ordinary non-JSON or malformed goal frame */ }
        }
      }
      // Goal usage broadcasts are commit-driven by the PG tape/cost backend.
      // Do not guess durability with a one-shot terminal-frame timer: CCB cost
      // settlement and the GC late-fold can legitimately happen much later.
      // Terminal release is exact by peer + clientMessageId. Peer-only fallback
      // is restricted to genuinely legacy inbound turns that never had a client
      // id; otherwise a late id-less final from turn A could ABA-release a newer
      // turn B after A's requestId-scoped billing frame already released it.
      if (activeCodexTurnsByPeer.size > 0 && !isBinary) {
        let outText: string | null = null;
        if (typeof data === "string") outText = data;
        else if (Buffer.isBuffer(data)) {
          try { outText = data.toString("utf8"); } catch { outText = null; }
        }
        if (
          outText !== null &&
          (outText.includes('"isFinal":true') || outText.includes('"outbound.error"'))
        ) {
          let parsedOut: unknown = null;
          try { parsedOut = JSON.parse(outText); } catch { /* 非 JSON 透传 */ }
          if (parsedOut !== null && typeof parsedOut === "object") {
            const obj = parsedOut as {
              type?: unknown;
              isFinal?: unknown;
              peer?: { id?: unknown };
              clientMessageId?: unknown;
            };
            const peerId = obj.peer && typeof obj.peer === "object"
              ? (typeof obj.peer.id === "string" ? obj.peer.id : null)
              : null;
            const isFinalMsg = obj.type === "outbound.message" && obj.isFinal === true;
            const isErr = obj.type === "outbound.error";
            if ((isFinalMsg || isErr) && peerId !== null) {
              const state = activeCodexTurnsByPeer.get(codexPeerKey(peerId));
              const terminalClientMessageId = isClientMessageId(obj.clientMessageId)
                ? obj.clientMessageId
                : null;
              const exactClientMatch = state !== undefined &&
                terminalClientMessageId !== null &&
                state.clientMessageId === terminalClientMessageId;
              const legacyPeerFallback = state !== undefined &&
                terminalClientMessageId === null &&
                state.clientMessageId === null;
              if (state !== undefined && (exactClientMatch || legacyPeerFallback)) {
                releaseCodexTurnState(state, isFinalMsg ? "turn_final" : "turn_error");
              }
            }
          }
        }
      }
      const forwardCommittedFrame = (): void => {
        if (
          durableStampedFrame !== null
          && durableStampedFrame.clientMessageId === null
          && parseLeftoverHotWsPayload(durableStampedFrame.payload)
        ) {
          // Persist already ran (or was skipped). Leftover never enters the
          // hot browser subscription — same contract as GET live-frames.
          return;
        }
        if (durableStampedFrame !== null) {
          outboundRing.storeStamped(
            durableStampedFrame.storeKey,
            durableStampedFrame.frameSeq,
            Date.now(),
            durableStampedFrame.payload,
          );
        }
        const sessionId = durableStampedFrame?.sessionId ?? null;
        const recipients: WebSocket[] = [];
        const seenRecipients = new Set<WebSocket>();
        const addRecipient = (ws: WebSocket): void => {
          if (ws.readyState !== WebSocket.OPEN || seenRecipients.has(ws)) return;
          seenRecipients.add(ws);
          recipients.push(ws);
        };
        // Session-scoped fan-out: every hello subscriber for this uid+session.
        // The admitting socket is included only if it has subscribed or is
        // still the sole pre-hello recipient below.
        for (const ws of openUserWsForSession(uid.toString(), sessionId)) addRecipient(ws);
        // Pre-hello first-token window: the producing connection has not
        // registered a peer yet, so still deliver to the admitting socket.
        if (sessionId === null || recipients.length === 0) addRecipient(userWs);
        if (recipients.length === 0) return;

        for (const dest of recipients) {
          if (dest.bufferedAmount + len > maxBufferedBytes) {
            bridgeLog?.warn("user-chat-bridge: user-side backpressure", {
              buffered: dest.bufferedAmount, len,
            });
            try { dest.close(CLOSE_BRIDGE.TOO_BIG, "backpressure"); } catch { /* */ }
            if (dest === userWs) cleanup("backpressure");
            continue;
          }
          try {
            dest.send(data, { binary: isBinary }, (err) => {
              if (err) bridgeLog?.warn("user-chat-bridge: user send error", { err });
            });
            bytesCU += len;
            if (dest === userWs) bufferedCU = dest.bufferedAmount;
            metrics.onContainerFrame?.(uid, len, isBinary);
            metrics.onBufferedBytes?.(uid, "container_to_user", dest.bufferedAmount);
          } catch (err) {
            bridgeLog?.warn("user-chat-bridge: user send threw", { err });
            try { dest.close(CLOSE_BRIDGE.INTERNAL, "user send failed"); } catch { /* */ }
            if (dest === userWs) cleanup("internal_error");
          }
        }
      };

      const durableSessionId = durableStampedFrame?.sessionId ?? null;
      if (
        durableStampedFrame !== null &&
        durableSessionId !== null &&
        deps.persistOutboundFrame
      ) {
        const stamped = durableStampedFrame;
        // Fallback for old/non-browser peers that produce stamped output before
        // sending an inbound.hello subscription.
        retainOutboundPersistQueueKey(stamped.storeKey);
        outboundPersistQueues.enqueue(
          stamped.storeKey,
          stamped.frameSeq,
          async () => {
            if (permissionAuthorityCommit !== null) await permissionAuthorityCommit;
            await deps.persistOutboundFrame!({
              uid,
              sessionId: durableSessionId,
              clientMessageId: stamped.clientMessageId,
              agentContainerId: containerId!,
              sessionKey: stamped.sessionKey,
              frameSeq: stamped.frameSeq,
              payload: stamped.payload,
            });
            forwardCommittedFrame();
          },
          (error) => {
            bridgeLog?.error("user-chat-bridge: outbound durability commit failed", {
              sessionId: stamped.sessionId,
              clientMessageId: stamped.clientMessageId,
              containerId,
              sessionKey: stamped.sessionKey,
              frameSeq: stamped.frameSeq,
              err: (error as Error)?.message ?? String(error),
            });
            try { userWs.close(CLOSE_BRIDGE.INTERNAL, "output persistence unavailable"); } catch { /* */ }
          },
          (error) => {
            bridgeLog?.error("user-chat-bridge: skipping outbound frame after permanent live-stream conflict", {
              sessionId: stamped.sessionId,
              clientMessageId: stamped.clientMessageId,
              containerId,
              sessionKey: stamped.sessionKey,
              frameSeq: stamped.frameSeq,
              err: (error as Error)?.message ?? String(error),
            });
          },
        );
        return;
      }
      if (permissionAuthorityCommit !== null) {
        void permissionAuthorityCommit.then(forwardCommittedFrame).catch((error) => {
          bridgeLog?.error("user-chat-bridge: permission authority commit failed", {
            error: (error as Error)?.message ?? String(error),
          });
          try { userWs.close(CLOSE_BRIDGE.INTERNAL, "permission persistence unavailable"); } catch { /* */ }
        });
        return;
      }
      forwardCommittedFrame();
    };

    // ---------- container WS 生命周期 ----------

    containerWs.on("open", () => {
      clearTimeout(connectTimer);
      {
        const key = uid.toString();
        let set = uidToContainerWs.get(key);
        if (!set) { set = new Set(); uidToContainerWs.set(key, set); }
        set.add(containerWs);
      }
      bridgeLog?.debug("user-chat-bridge: container connected", {
        host: endpoint.host, port: endpoint.port,
      });
      // attestation 超时:容器 open 后应**立刻**发 attest 帧(gateway 在 ws connection
      // 建立时同步 send)。超时 = 旧 release(没这段代码)→ 拒连接 + stale recycle。
      // 计时起点放在 open 而不是 upgrade:连接还没建立就开始计时会把慢网络误判成旧容器。
      if (authorityOn && attestState === "pending" && attestTimer === null) {
        attestTimer = setTimeout(
          () => failAttestation("attestation_timeout"),
          authorityDeps?.attestTimeoutMs ?? DEFAULT_ATTEST_TIMEOUT_MS,
        );
      }
      // V3 cold-start UX 提示:本次 ensureRunning 走了 provision 分支 → 给前端发
      // 一帧 sidecar,前端把 typing indicator 文案换成"首次加载上下文较慢"。
      // 用 sys.* 命名空间避免与 ccb outbound.* 帧冲突;前端 default case 会忽略未知 type,
      // 加 case 是 additive。
      if (endpoint.coldStart === true && userWs.readyState === WebSocket.OPEN) {
        try {
          userWs.send(JSON.stringify({ type: "sys.cold_start" }));
        } catch { /* swallow — sidecar 提示失败不能影响 bridge */ }
      }
      // relay 真建立(containerWs open = bridge↔容器双向通)→ 给前端发"就绪"单一权威信号。
      // 冷暖都发(sys.cold_start 仅冷启)。这是 readiness 权威统一:前端把"relay 已就绪"只认
      // 这一个信号,据此立刻排空离线队列 —— 冷启时握手完成(前端 onopen)早于 relay 就绪,
      // 期间发的消息经 P7.8 进离线队列等待;收到 relay_ready 即发,不再靠 4503 reconnect 反弹。
      // sys.* 命名;前端 default case 忽略未知 type,加 case 是 additive。
      if (userWs.readyState === WebSocket.OPEN) {
        try {
          userWs.send(JSON.stringify({
            type: "sys.relay_ready",
            automaticRecoveryOwner: "master-v1",
          }));
        } catch { /* swallow */ }
      }
      void drainDurableControlsForUser(uid);
      // 冲刷 preopen queue
      for (const m of preopenQueue) sendToContainer(m.data, m.isBinary, m.len);
      preopenQueue.length = 0;
      bufferedUC = 0;
      metrics.onBufferedBytes?.(uid, "user_to_container", 0);
      // Phase 4 — auto-rebind active GitHub selections after container restart.
      //   触发场景:supervisor 重启容器后,新容器内 git workspace 已丢,但 DB 里
      //   还留着 ready/cloning/pending 的 selection。这里 open 时只 fetch row
      //   (无 token),token 留到 hello 阶段才取(覆盖 open→hello 之间 revoke 风险)。
      //   双触发:fetch 完成后调 tryAutoRebindFlush — 若 hello 已先到记 peers 那
      //   边就是真 flush;若还没到,等 hello 来再触发。
      //   pgPool 未注入(测试)→ 仍标记 fetchDone(避免 flush 永远等)。
      if (deps.pgPool) {
        const pgPoolBound = deps.pgPool;
        ;(async () => {
          try {
            const rows = await fetchActiveSelectionsForRebind(pgPoolBound, Number(uid));
            for (const row of rows) {
              pendingRebindMap.set(row.sessionId, row);
            }
          } catch (err) {
            bridgeLog?.warn("user-chat-bridge: fetch active selections failed", { err });
          } finally {
            autoRebindFetchDone = true;
            tryAutoRebindFlush();
          }
        })();
      } else {
        autoRebindFetchDone = true; // 测试 / 无 pg 路径:不阻塞 flush 语义
      }
    });

    containerWs.on("message", onContainerMessage);

    containerWs.on("error", (err: Error) => {
      bridgeLog?.warn("user-chat-bridge: container ws error", { err });
      sendErrorFrame(userWs, "ERR_CONTAINER", err.message);
      try { userWs.close(CLOSE_BRIDGE.INTERNAL, "agent error"); } catch { /* */ }
      // 容器 ws error → 容器侧已不可达,billing 也来不了 → force final
      cleanup("container_error", true);
    });

    containerWs.on("close", (code, reason) => {
      // 容器主动关 → 透传给用户 close,但 reserved code (1005/1006/1015) 不能 send
      const passCode = sanitizeCloseCode(code);
      const passReason = reason && reason.length > 0 && reason.length < 120
        ? reason.toString("utf8")
        : "agent closed";
      try { userWs.close(passCode, passReason); } catch { /* */ }
      // 容器 close → billing 帧渠道关了,drain 没意义 → force final
      // (cleanup 函数本身也会在 drain 期遇 container_close 触发 pre-empt)
      cleanup("container_close", true);
    });

    // ---------- user WS 生命周期 ----------

    userWs.on("message", onUserMessage);
    userWs.on("error", (err) => {
      bridgeLog?.warn("user-chat-bridge: user ws error", { err });
    });

    // ---------- 心跳(HIGH#5) ----------
    // 思路:"最后一次活跃" timestamp,每 heartbeatIntervalMs 醒来一次:
    //   - 距上次活跃 > heartbeatTimeoutMs → 判死链,terminate()
    //   - 否则发一个 ping(不等对端 pong 即可刷新 lastAlive,pong 来了也刷)
    // 任意下行/上行消息 / pong 都刷 lastAlive;这样正常聊天的连接根本走不到 terminate 路径。
    // lastAliveAt 已在连接状态区提前声明(onContainerMessage 复用)。
    const refreshAlive = (): void => { lastAliveAt = Date.now(); };
    userWs.on("pong", refreshAlive);
    userWs.on("message", refreshAlive); // 绑第二个 message handler 只刷时间戳,不干扰 onUserMessage
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        if (userWs.readyState !== WebSocket.OPEN) return;
        const idleMs = Date.now() - lastAliveAt;
        // turn 在飞宽限:CF/Caddy 不转发 ping/pong,长 turn 期间浏览器无上行刷 lastAlive。
        // 用户已发 inbound.message 即在等响应,turn 期间(含冷启 TTFT 静默 + 流式)不 reap。
        // turnActiveUntil 是绝对截止点(turn 起点 +硬上限,isFinal 收窄),**不被下行帧续期**,
        // 故"浏览器真断 + turn 卡死"的连接到点必回收(Codex 审 MEDIUM:硬上限是真硬)。
        const turnGraceActive = Date.now() < turnActiveUntil;
        if (idleMs > heartbeatTimeoutMs && !turnGraceActive) {
          bridgeLog?.info("user-chat-bridge: heartbeat timeout, terminating", { idleMs });
          try { userWs.terminate(); } catch { /* */ }
          // heartbeat 超时 = 用户失联,但容器仍可能在跑 codex turn,billing 帧还会
          // 到 → 走 drain(force=false),checkDrainComplete / drain timeout 兜底
          cleanup("client_close");
          return;
        }
        try { userWs.ping(); } catch { /* */ }
      }, heartbeatIntervalMs);
    }

    // plan v3 review v1 §F4 follow-up:周期重新拉 grants 让 admin 取消授权能在
    // 已开桥上生效。fire-and-forget;refresh 自己 swallow error,不会 reject。
    // P0 计费旁路封堵:agent→model 权威快照共用同一班 timer 刷新(新装/卸载
    // marketplace agent 在窗口内对已开桥生效;miss 时另有即时补触发)。
    if (modelCheckerHandle !== null || agentModelResolverHandle !== null) {
      modelCheckerRefreshTimer = setInterval(() => {
        // 注意:不绑 await/then;refresh 内部 swallow error,这里只是触发。
        modelCheckerHandle?.refresh();
        void agentModelResolverHandle?.refresh();
      }, GRANTS_REFRESH_INTERVAL_MS);
      // 不阻塞进程退出 —— bridge 不在则 timer 也无意义。
      modelCheckerRefreshTimer.unref?.();
    }
    userWs.on("close", (code, reason) => {
      // 把客户端关闭原因转给容器(透传 code/reason,容器侧也会触发 cleanup)
      // **注意**:不要在这里 close containerWs。drain 机制需要容器仍开着接收 billing
      // 帧 — 关 container 会让 codex turn 半道崩,billing 帧永远到不了 master。
      // drain timeout (DRAIN_BILLING_MS) / pre-empt (container_close from agent)
      // 会兜底关闭。
      const passCode = sanitizeCloseCode(code);
      const passReason = reason && reason.length > 0 && reason.length < 120
        ? reason.toString("utf8")
        : "client closed";
      // 仅在没有 codex inflight 且无在飞 durable dispatch 时才透传 close 给容器
      // (走 force final 路径);有其一时进 drain,container 留着让 turn 跑完 + 收 billing /
      // 保 lease,drain 收尾时由 finalCleanup 统一 terminate。
      if (inflightCodexTurns.size === 0 && admittedDispatches.size === 0) {
        try {
          if (containerWs.readyState === WebSocket.OPEN
            || containerWs.readyState === WebSocket.CONNECTING) {
            containerWs.close(passCode, passReason);
          }
        } catch { /* */ }
      }
      cleanup("client_close");
    });

    // 把"upgrade 期间早到的帧"先 emit 一遍 → 走正常 onUserMessage 流程。
    // TTFT 起点用第一条早到帧的 receivedAtMs(更准 — 用户发帧瞬间,而不是 replay 瞬间);
    // 后续帧 onUserMessage 内部的 firstUserFrameAtMs !== null 守卫会跳过覆盖。
    for (const m of earlyMessages) {
      onUserMessage(m.data, m.isBinary, m.receivedAtMs);
    }

    // ---------- cleanup 状态机(PR2 v1.0.66 drain refactor) ----------
    //
    // 状态:
    //   1. 正常运行:cleaned=false, drainTimer=null
    //   2. drain 期(仅 user_close + 有 inflight codex turn 触发):
    //      cleaned=false, drainTimer!=null, userDetached=true,
    //      container WS 仍开,onContainerMessage 仍处理 billing 帧
    //   3. 完结:cleaned=true,所有资源释放
    //
    // 入口:cleanup(triggerCause, force=false) — 参数化避免依赖外部 mutable cause。
    //   - drain 中再调:container 异常 / shutdown / force 路径 → 立即 finalCleanup
    //     其它(user_close 重入 / heartbeat)忽略,继续等 billing
    //   - 未 drain:non-client_close 或 force 或 inflight 空 → 立即 finalCleanup
    //                client_close + inflight 非空 → 进 drain
    //
    // detachUserSide(立即跑,drain / final 都用):unregister + uidToUserWs.delete +
    //   user-side timer 清 + non-client_close 路径强 terminate userWs(防 heartbeat
    //   timeout 留 socket)
    //
    // checkDrainComplete:billing settle 把 inflightCodexTurns.size→0 时调,提前 final
    function cleanup(triggerCause: BridgeCloseCause, force = false): void {
      if (cleaned) return;

      // 已在 drain 中
      if (drainTimer !== null) {
        if (
          force ||
          triggerCause === "container_close" ||
          triggerCause === "container_error" ||
          triggerCause === "shutdown"
        ) {
          bridgeLog?.info("user-chat-bridge: drain pre-empt", {
            triggerCause, leftover: inflightCodexTurns.size,
          });
          finalCleanup(triggerCause);
        }
        // 其它路径(user_close 重入 / heartbeat 抖动)在 drain 期忽略
        return;
      }

      // 还没进 drain
      // drain 适用条件:user-side 故障(client_close / backpressure / internal_error)
      // 同时有在飞 codex turn(等 billing)或在飞 durable dispatch(保 lease / 等终态)。
      // container_* / shutdown / frame_too_big / auth_failed 等路径不走 drain。
      const shouldDrain =
        !force &&
        (triggerCause === "client_close" ||
          triggerCause === "backpressure" ||
          triggerCause === "internal_error") &&
        (inflightCodexTurns.size > 0 || admittedDispatches.size > 0);

      if (!shouldDrain) {
        finalCleanup(triggerCause);
        return;
      }

      // 进 drain 路径(只有 user 主动 close + 有 codex inflight 才会)
      drainCause = triggerCause;
      detachUserSide(triggerCause);
      bridgeLog?.info("user-chat-bridge: enter drain", {
        inflightCount: inflightCodexTurns.size,
      });
      for (const [requestId, snap] of inflightCodexTurns) {
        recordBillingRecovery(requestId, "pending", snap);
      }
      // RFC §2.2 B1:有在飞 admitted dispatch → 取 max(billing, dispatch drain,默认 60s / 上限 120s);
      // 无 dispatch(纯 codex billing drain)→ 沿用 5s billing 窗口。
      const drainMs = admittedDispatches.size > 0
        ? Math.max(readDrainBillingMs(), readDispatchDrainMs())
        : readDrainBillingMs();
      drainTimer = setTimeout(() => {
        bridgeLog?.warn("user-chat-bridge: drain timeout", {
          leftover: inflightCodexTurns.size,
          admittedLeftover: admittedDispatches.size,
        });
        for (const [requestId, snap] of inflightCodexTurns) {
          recordBillingRecovery(requestId, "failed", snap);
        }
        finalCleanup(drainCause ?? "client_close");
      }, drainMs);
      drainTimer.unref?.();
    }

    /**
     * billing settle(inflightCodexTurns→0)或 dispatch 记录清空(dropAdmittedDispatch)时调,
     * 双 map 均空才提前结束 drain。不在 drain 期 / 任一 map 非空时 no-op。
     */
    function checkDrainComplete(): void {
      if (drainTimer !== null && inflightCodexTurns.size === 0 && admittedDispatches.size === 0) {
        clearTimeout(drainTimer);
        drainTimer = null;
        finalCleanup(drainCause ?? "client_close");
      }
    }

    /**
     * P0 收入漏洞修复(2026-07-03)— codex billing 帧撞上"本桥不认识的 requestId"
     * 时,按 request_finalize_journal(唯一权威源)回查裁决,而不是丢帧。
     *
     * 背景:inflightCodexTurns 是 per-连接闭包 Map,而 v5 断流续写语义下 codex
     * turn 跨 WS 重连存活 —— 用户中途断线重连后,容器把 outbound.codex_billing
     * 发到**新桥**,新桥 Map 查不到 → 旧实现只打日志 = 整 turn 免费。修复后按
     * journal state 裁决:
     *   - 'inflight'   → 用 journal ctx(model/agentId/codexAccountId/traceId,
     *     startInflightJournal 落笔)重构 finalizer 完成 settle —— 双钱包扣费、
     *     零输出免单、cost_charged 持久化+广播口径与主路径完全一致;
     *   - 'committed' / 'finalizing' → 从 immutable attribution 恢复 Goal usage；
     *     只有证据可见且 append/fold 成功后才本地抑制重复帧。finalizing 尚无
     *     可见证据时保持可重试，避免 commit-before-fold 崩溃窗漏归属;
     *   - 'aborted'    → **免单 + error 告警,不补收**。钱安全红线"宁少收不乱扣":
     *     aborted 行的 preCheck reservation 已释放、免单决策(engineSessionId
     *     fail-closed / reconciler_timeout / commit 失败等)已对外生效,此处补收
     *     会绕过既有免单口径;且 journal CAS 不允许 aborted→committed,强行
     *     settle 会让 ledger 与 journal 终态脱钩。本修复已同时移除 finalCleanup
     *     的 bridge_disconnect abort,常态下不应再出现 billing 撞 aborted ——
     *     出现即异常,error 级告警留人工核账(存量 bridge_disconnect abort 行为
     *     修复前已发生的损失,按"接受不可追回"口径处理,与 reconciler 一致);
     *   - 无行 → warn 丢弃(容器伪造 / 非本 master 生成的 requestId)。
     *
     * 并发/幂等防线(与主路径 Map.delete 单次门控同构):
     *   1. pendingJournalSettles 同步去重 —— 同 reqId duplicate 帧在 settle 在途
     *      期间直接丢弃;
     *   2. settleUsageAndLedger 的 (user_id, request_id) UNIQUE + journal CAS ——
     *      跨桥并发(旧桥 drain settle vs 新桥 fallback)由 DB 层兜底,后到的
     *      settle 拿 debitedCredits=null,不重复扣也不重复广播。
     *
     * 安全:journal.user_id 必须等于本桥 uid(容器 per-user,不等即伪造/串桥,
     * 直接拒绝);settle 参数全部取自 journal ctx(master 落笔),不信帧上的
     * model/agentId(与主路径"只信 snapshot"红线同构);preCheck reservation
     * handle 按 (userId, requestId) 重建 —— 与原桥 preCheckWithCost 返回的
     * handle 同值(ReservationHandle 本就只是这两个字段)。
     */
    function handleCrossBridgeCodexBilling(frame: {
      requestId: string;
      engineSid: string | null;
      engineSidRaw: unknown;
      codexStatus: "success" | "error";
      terminalCode: "USER_CANCELLED" | "CODEX_ERROR" | undefined;
      usage: TokenUsage;
      billingRl: unknown;
      turnKey: string | null;
      parentTurnKey: string | null;
      parentSessionId: string | null;
      delegateAgentId: string | null;
    }): void {
      const { requestId } = frame;
      if (!codexBillingEnabled) {
        // 计费未启用(个人版上下文 / 纯透传测试)— 无 journal 可查,保持旧日志语义。
        bridgeLog?.info("user-chat-bridge: codex_billing for unknown turn (billing disabled)", {
          requestId,
        });
        return;
      }
      // server-owned requestId 恒为 32-hex(ensureRequestIdServerSide;gateway 侧
      // billing guard 是同一 seam 合同)。形状不符 = 容器伪造/坏帧,不值得打 DB。
      if (!/^[0-9a-f]{32}$/.test(requestId)) {
        bridgeLog?.warn("user-chat-bridge: codex_billing unknown turn with malformed requestId — dropped", {
          requestId: requestId.slice(0, 64),
        });
        return;
      }
      if (pendingJournalSettles.has(requestId)) {
        bridgeLog?.info("user-chat-bridge: codex_billing duplicate while cross-bridge settle in flight — dropped", {
          requestId,
        });
        return;
      }
      pendingJournalSettles.add(requestId);
      // 三件套非空由 codexBillingEnabled(boot-time 全有或全无强校验)保证。
      const pgPool = deps.pgPool!;
      const preCheckRedisBound = deps.preCheckRedis!;
      const pricingCache = deps.pricing!;
      void (async (): Promise<void> => {
        try {
          const res = await pgPool.query<{
            state: string;
            user_id: string;
            ctx: unknown;
            error_msg: string | null;
          }>(
            `SELECT state, user_id::text AS user_id, ctx, error_msg
               FROM request_finalize_journal
              WHERE request_id = $1`,
            [requestId],
          );
          const row = res.rows[0];
          if (row === undefined) {
            bridgeLog?.warn("user-chat-bridge: codex_billing for unknown turn — no journal row, dropped", {
              requestId,
            });
            return;
          }
          if (row.user_id !== uid.toString()) {
            // 容器只服务单用户;journal 行归属他人 = 伪造 requestId / 串桥,拒绝。
            bridgeLog?.error("user-chat-bridge: codex_billing journal user mismatch — refusing settle", {
              requestId,
              journalUserId: row.user_id,
            });
            return;
          }
          const ctx = (row.ctx !== null && typeof row.ctx === "object"
            ? row.ctx
            : {}) as Record<string, unknown>;
          const grokAccountId = typeof ctx.grokAccountId === "string" && /^[1-9]\d*$/.test(ctx.grokAccountId)
            ? BigInt(ctx.grokAccountId)
            : null;
          const grokSlotId = typeof ctx.grokSlotId === "string" && ctx.grokSlotId.length > 0
            ? ctx.grokSlotId
            : null;
          if (grokAccountId !== null && grokSlotId !== null && deps.releaseGrokRouteLease !== undefined) {
            // A terminal billing frame is the logical-turn boundary. Do this
            // before journal-state branching so committed/finalizing/waived
            // replays also clean the exact surviving lease. A transient DB
            // failure leaves the journal/tape retryable and the route occupied.
            await deps.releaseGrokRouteLease(grokAccountId, grokSlotId);
          }
          if (row.state === "committed" || row.state === "finalizing") {
            // Settlement may have committed immediately before the old process
            // died, leaving its exact pending locator unfurled and its live goal
            // snapshot unbroadcast. Recovering the immutable amount never
            // re-debits; appendCostCredits either folds it or republishes the
            // already-advanced GoalState snapshot without revision churn.
            let attributionRepaired = false;
            try {
              const recoveredCredits = await loadUsageAttributionCredits(
                pgPool,
                uid,
                requestId,
              );
              if (recoveredCredits !== null && deps.appendCostCredits) {
                await deps.appendCostCredits(
                  requestId,
                  uid.toString(),
                  recoveredCredits.toString(),
                  frame.engineSid,
                  frame.parentSessionId,
                  frame.delegateAgentId,
                  frame.turnKey,
                  frame.parentTurnKey,
                );
                attributionRepaired = true;
              }
            } catch (err) {
              bridgeLog?.warn("user-chat-bridge: settled journal goal attribution recovery failed", {
                requestId,
                state: row.state,
                err: (err as Error)?.message,
              });
            }
            bridgeLog?.info(attributionRepaired
              ? "user-chat-bridge: codex_billing for already-settled journal — attribution refreshed"
              : "user-chat-bridge: settled journal attribution not yet visible — replay remains eligible", {
              requestId,
              state: row.state,
            });
            // `finalizing` can be observed before the settlement transaction is
            // visible. Only suppress later frames after immutable attribution
            // was read and its fold/rebroadcast completed successfully.
            if (attributionRepaired) locallySettledCodexTurns.add(requestId);
            return;
          }
          if (row.state === "aborted") {
            // Historical code also wrote `aborted` for transient settle errors.
            // Only an explicit permanent marker is a waiver decision. Prefer
            // permanent usage truth, otherwise reopen the unproven row so the
            // exact frame can settle now (the immutable tape remains fallback).
            const settled = await pgPool.query<{ present: boolean }>(
              `SELECT EXISTS(
                 SELECT 1 FROM usage_records WHERE user_id=$1 AND request_id=$2
               ) AS present`,
              [uid.toString(), requestId],
            );
            if (settled.rows[0]?.present === true) {
              locallySettledCodexTurns.add(requestId);
              return;
            }
            if (isPermanentCodexWaiver(row.error_msg)) {
              bridgeLog?.info("user-chat-bridge: codex_billing hit proven permanent waiver — idempotent ignore", {
                requestId,
              });
              return;
            }
            const reopened = await pgPool.query(
              `UPDATE request_finalize_journal
                  SET state='inflight', error_msg=NULL, failure_code=NULL,
                      final_credits=NULL, updated_at=NOW()
                WHERE request_id=$1 AND user_id=$2 AND state='aborted'
                  AND NOT EXISTS (
                    SELECT 1 FROM usage_records ur
                     WHERE ur.user_id=$2 AND ur.request_id=$1
                  )`,
              [requestId, uid.toString()],
            );
            if (reopened.rowCount !== 1) {
              bridgeLog?.warn("user-chat-bridge: codex_billing could not reopen unproven aborted journal — immutable tape will retry", {
                requestId,
              });
              return;
            }
            bridgeLog?.warn("user-chat-bridge: reopened unproven aborted journal for exact billing replay", {
              requestId,
            });
          }
          // state === 'inflight' — 跨桥恢复 settle。
          const model = typeof ctx.model === "string" ? ctx.model : null;
          const agentId = typeof ctx.agentId === "string" ? ctx.agentId : "codex";
          const ctxTraceId = typeof ctx.traceId === "string" ? ctx.traceId : null;
          const reservation: ReservationHandle = {
            userId: uid.toString(),
            requestId,
          };
          const billingLog = bridgeLog?.child({
            ...(ctxTraceId !== null ? { traceId: ctxTraceId } : {}),
            requestId,
          }) ?? null;
          // 配置类不可恢复错误 → 与主路径 abandon 同语义:免单(abort journal)
          // + 释放软预扣 + error 告警。宁可少收不可乱扣。
          const waive = async (reason: string): Promise<void> => {
            await abortInflightJournal(
              pgPool,
              requestId,
              permanentCodexWaiverReason(reason),
              codexAbandonFailureCode(reason),
            ).catch(() => {});
            await releasePreCheck(preCheckRedisBound, reservation).catch(() => {});
          };

          // journal 的创建代次由**持久字段**裁决，不能看接收 billing 帧的这个新 bridge
          // 当前 flag。否则 enable 后会把存量 legacy journal 当 authority 拒掉；disable 后又会
          // 把存量 authority journal 当 legacy，用新 PricingCache 结算另一代价格。
          const journalAuthority = ctx.authorityKind === "bridge_signed";
          const authorityMetadataPresent = [
            "authorityTurnId",
            "billingRequestId",
            "executionRevision",
            "billingRevision",
            "securityEpoch",
          ].some((key) => Object.prototype.hasOwnProperty.call(ctx, key));
          if (
            (ctx.authorityKind !== undefined && !journalAuthority) ||
            (!journalAuthority && authorityMetadataPresent)
          ) {
            billingLog?.error(
              "user-chat-bridge: cross-bridge journal authority classification invalid — waiving turn",
              { authorityKind: ctx.authorityKind },
            );
            await waive("cross_bridge_authority_classification_invalid");
            return;
          }

          let recoveredAuthority: import("../billing/proxyBilling.js").BillingAuthorityStamp | null = null;
          if (journalAuthority) {
            const bindingOk =
              typeof ctx.authorityTurnId === "string" &&
              /^[0-9a-f]{32}$/.test(ctx.authorityTurnId) &&
              ctx.billingRequestId === requestId &&
              typeof ctx.executionRevision === "string" &&
              /^[0-9a-f]{64}$/.test(ctx.executionRevision) &&
              typeof ctx.billingRevision === "string" &&
              /^[0-9a-f]{64}$/.test(ctx.billingRevision) &&
              typeof ctx.securityEpoch === "string" &&
              /^\d+$/.test(ctx.securityEpoch);
            if (!bindingOk) {
              bridgeLog?.error(
                "user-chat-bridge: cross-bridge journal authority binding invalid — waiving turn",
                { requestId },
              );
              await abortInflightJournal(
                pgPool,
                requestId,
                permanentCodexWaiverReason("cross_bridge_authority_binding_invalid"),
                "INTERNAL_ERROR",
              ).catch(() => {});
              await releasePreCheck(preCheckRedisBound, reservation).catch(() => {});
              return;
            }
            recoveredAuthority = {
              executionRevision: ctx.executionRevision as string,
              projectionRevision: null,
              securityEpoch: BigInt(ctx.securityEpoch as string),
              kind: "bridge_signed",
            };
          }
          if (frame.engineSid === null) {
            billingLog?.error("user-chat-bridge: cross-bridge codex_billing engineSessionId missing/invalid — waiving turn (fail-closed)", {
              engineSessionId: typeof frame.engineSidRaw === "string"
                ? frame.engineSidRaw.slice(0, 80)
                : typeof frame.engineSidRaw,
            });
            await waive("codex_billing_engine_session_id_invalid");
            return;
          }
          if (model === null) {
            billingLog?.error("user-chat-bridge: cross-bridge codex_billing journal ctx missing model — waiving turn");
            await waive("cross_bridge_journal_ctx_model_missing");
            return;
          }
          let derivedPricing = parseBillingPricing(ctx.billingPricing, model);
          if (derivedPricing === null && journalAuthority) {
            // authority journal 缺/坏精确定价时绝不回退异步 cache：那会把同一笔 turn
            // 跨到另一 billing generation。钱安全方向取免单 + 响亮日志。
            billingLog?.error(
              "user-chat-bridge: cross-bridge authority billing pricing invalid — waiving turn",
              { model, billingRevision: ctx.billingRevision },
            );
            await waive("cross_bridge_authority_billing_pricing_invalid");
            return;
          }
          if (derivedPricing === null && ctx.billingPricing !== undefined) {
            // 本版本起 legacy journal 也会持久化最终价格；字段存在但畸形说明 journal
            // 已损坏，不能伪装成“上线前旧 journal”回退当前 cache。只有字段完全缺失的
            // pre-deployment legacy 行保留兼容回退。
            billingLog?.error(
              "user-chat-bridge: cross-bridge persisted billing pricing invalid — waiving turn",
              { model },
            );
            await waive("cross_bridge_billing_pricing_invalid");
            return;
          }
          if (derivedPricing === null) {
            // 仅兼容本版本上线前遗留、完全没有 billingPricing 字段的 legacy inflight
            // journal；新 journal（含 legacy）都持久化最终价格，不会走这条分支。
            const modelPricing = pricingCache.get(model);
            if (!modelPricing) {
              billingLog?.error("user-chat-bridge: cross-bridge codex_billing pricing missing — waiving turn", {
                model,
              });
              await waive("cross_bridge_pricing_missing");
              return;
            }
            let agentMul: string;
            try {
              agentMul = await getAgentCostMultiplier(pgPool, agentId);
            } catch (err) {
              // 瞬态 DB 错误:**不** abort —— journal 保持 inflight，durable tape 继续重试；
              // 始终无 evidence 才在 ≥24h SLA 后由 reconciler 免单终态化，不把临时故障
              // 固化成免单。
              billingLog?.error("user-chat-bridge: cross-bridge getAgentCostMultiplier failed — journal left inflight for reconciler", {
                agentId,
                err: (err as Error)?.message,
              });
              return;
            }
            derivedPricing = {
              ...modelPricing,
              multiplier: composeMultiplier(modelPricing.multiplier, agentMul),
            };
          }
          // rateLimits piggyback(best-effort,与主路径同语义;accountId 权威取
          // journal ctx.codexAccountId —— null = legacy / api_relay 无关联账号)。
          if (frame.billingRl && typeof frame.billingRl === "object") {
            const accStr = typeof ctx.codexAccountId === "string" ? ctx.codexAccountId : null;
            if (accStr !== null && /^[0-9]{1,19}$/.test(accStr)) {
              void maybeUpdateAccountQuotaCodex(
                pgPool,
                BigInt(accStr),
                frame.billingRl as {
                  util5h?: number;
                  reset5h?: string;
                  util7d?: number;
                  reset7d?: string;
                },
              ).catch((err) => {
                billingLog?.debug("user-chat-bridge: cross-bridge codex quota write failed", {
                  err: (err as Error)?.message,
                });
              });
            }
          }
          // B7b:cross-bridge recovery settle 也要写 dispatch 身份到 usage_records
          // (与 durableCodexBilling 同源:从 journal ctx 读出 dispatchId/attemptNo)。
          const crossBridgeDispatchId =
            typeof ctx.dispatchId === "string" ? ctx.dispatchId : null;
          const crossBridgeAttemptNo =
            typeof ctx.attemptNo === "number" && Number.isInteger(ctx.attemptNo)
              ? ctx.attemptNo
              : null;
          const finalizer = makeCodexFinalizer({
            pgPool,
            preCheckRedis: preCheckRedisBound,
            userId: uid,
            requestId,
            engineSessionId: frame.engineSid,
            model,
            derivedPricing,
            reservation,
            authority: recoveredAuthority,
            verificationSponsorship: parseVerificationSponsorshipSnapshot(ctx.verificationSponsorship),
            dispatchId: crossBridgeDispatchId,
            attemptNo: crossBridgeAttemptNo,
          });
          const result = await finalizer.commit(
            frame.usage, frame.codexStatus, {
              turnKey: frame.turnKey,
              parentTurnKey: frame.parentTurnKey,
              parentSessionId: frame.parentSessionId,
              delegateAgentId: frame.delegateAgentId,
              terminalCode: frame.terminalCode,
            },
          );
          // settle 已收口 → 后续同桥 duplicate 帧同步丢弃(与主路径簿记同构)。
          locallySettledCodexTurns.add(requestId);
          recordBillingRecovery(requestId, "recovered", {
            model,
            traceId: ctxTraceId ?? requestId,
          }, 2);
          billingLog?.info("user-chat-bridge: codex cross-bridge settle done (recovered turn billing)", {
            model,
            debitedCredits: result.debitedCredits?.toString() ?? null,
            costCredits: result.costCredits.toString(),
          });
          // Usage attribution fold is independent from whether a charge was
          // debited. pending_usage_patches remains the crash-safe fallback.
          const persistedUsageCredits =
            result.attributionCredits !== null && result.attributionCredits !== undefined
              ? result.attributionCredits
              : result.debitedCredits !== null && result.debitedCredits > 0n
                ? result.debitedCredits
                : null;
          if (persistedUsageCredits !== null) {
            if (deps.appendCostCredits) {
              try {
                await deps.appendCostCredits(
                  requestId,
                  uid.toString(),
                  persistedUsageCredits.toString(),
                  frame.engineSid,
                  frame.parentSessionId,
                  frame.delegateAgentId,
                  frame.turnKey,
                  frame.parentTurnKey,
                );
              } catch (err) {
                billingLog?.warn("user-chat-bridge: cross-bridge persist costCredits threw", {
                  err: (err as Error)?.message,
                });
              }
            }
          }
          // 广播口径与主路径一致:仅 debit>0 才广播。
          if (result.debitedCredits !== null && result.debitedCredits > 0n) {
            broadcastToUser(uid, {
              type: "outbound.cost_charged",
              requestId,
              traceId: ctxTraceId,
              model,
              costCredits: result.costCredits.toString(),
              debitedCredits: result.debitedCredits.toString(),
              balanceAfter: result.balanceAfter !== null
                ? result.balanceAfter.toString()
                : null,
              clamped: result.clamped,
            });
          }
        } catch (err) {
          // 瞬态 settle/finalize 错误保持 journal 可恢复；immutable turn tape 会
          // 用同一精确帧重试。这里只记录低延迟 live path 的失败。
          bridgeLog?.error("user-chat-bridge: codex cross-bridge settle failed", {
            requestId,
            err: (err as Error)?.message,
          });
          recordBillingRecovery(requestId, "failed", undefined, 2);
        } finally {
          pendingJournalSettles.delete(requestId);
        }
      })();
    }

    /**
     * 立即让出 user 侧资源(registry 配额、uidToUserWs、user-side timer)。
     *
     * idempotent — drain 进入时跑一次,finalCleanup 也无脑跑(no-op)。
     *
     * **重要**:对非 client_close 路径(heartbeat timeout / force)且 userWs 还活着,
     * 强 terminate;否则 socket 漂在那 60s+ 不释放系统资源(Codex 审计 BLOCKER)。
     * client_close 路径 userWs 已经 close,不重复 terminate。
     */
    function detachUserSide(triggerCause: BridgeCloseCause): void {
      if (userDetached) return;
      userDetached = true;
      for (const key of retainedOutboundPersistQueueKeys) {
        outboundPersistQueues.release(key);
      }
      retainedOutboundPersistQueueKeys.clear();
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (modelCheckerRefreshTimer !== null) {
        clearInterval(modelCheckerRefreshTimer);
        modelCheckerRefreshTimer = null;
      }
      // attestation 门的超时 timer:连接一走就必须清(否则 timer 到点后对一条已关的
      // 连接触发 recycle —— 把用户容器无辜换掉)。
      if (attestTimer !== null) {
        clearTimeout(attestTimer);
        attestTimer = null;
      }
      attestQueue.length = 0;
      attestQueuedBytes = 0;
      clearTimeout(connectTimer);
      // heartbeat timeout / shutdown / force 路径下 userWs 可能还 OPEN —— terminate
      if (
        triggerCause !== "client_close" &&
        userWs.readyState !== WebSocket.CLOSED &&
        userWs.readyState !== WebSocket.CLOSING
      ) {
        try { userWs.terminate(); } catch { /* */ }
      }
      unregister();
      unregisterUserWsSessions(userWs);
      {
        const key = uid.toString();
        const set = uidToUserWs.get(key);
        if (set) {
          set.delete(userWs);
          if (set.size === 0) uidToUserWs.delete(key);
        }
      }
      {
        const key = uid.toString();
        const set = uidToContainerWs.get(key);
        if (set) {
          set.delete(containerWs);
          if (set.size === 0) uidToContainerWs.delete(key);
        }
      }
      if (recoveryExecutor !== null) {
        const key = uid.toString();
        const executors = uidToRecoveryExecutors.get(key);
        if (executors) {
          executors.delete(recoveryExecutor);
          if (executors.size === 0) uidToRecoveryExecutors.delete(key);
        }
        recoveryExecutor = null;
      }
    }

    /**
     * 真 teardown:释放全部资源 + emit metric/log。idempotent(cleaned 守门)。
     *
     * 调用时机:
     *   - 非 drain 路径直接 final
     *   - drain 超时 / drain 期被 container_close/error/shutdown/force 抢占
     *   - drain 期 inflightCodexTurns 全 settle 完 → checkDrainComplete 触发
     */
    function finalCleanup(finalCause: BridgeCloseCause): void {
      if (cleaned) return;
      cleaned = true;
      cause = finalCause;
      if (drainTimer !== null) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      // durable dispatch 心跳只在 finalCleanup 停(drain 期间必须续 lease,故不在
      // detachUserSide 里清)。残留 admitted 记录不 CAS terminal:桥关 ≠ turn 死,
      // 心跳一停 lease 到期后由 turnDispatchReconciler 裁决(与上面 inflight 同纪律)。
      if (dispatchHeartbeatTimer !== null) {
        clearInterval(dispatchHeartbeatTimer);
        dispatchHeartbeatTimer = null;
      }

      // keyring 普查:连接终结 = 这个容器的这条连接不再在册。留着不摘 = 轮换步骤② 的
      // 覆盖率会被已经断开的连接稀释(永远收敛不到 100%,或反过来把已下线的旧 env
      // 容器算进"已覆盖")。幂等。
      authorityCensus?.drop(connId);

      // user 侧 detach(idempotent)
      detachUserSide(finalCause);

      // An exact queue registration exists only between container forward and
      // the PG activation acknowledgement. A container/bridge restart in this
      // interval proves that no provider submit owns the grant, so compensate
      // slot/route, Redis reservation and journal immediately. Registrations
      // removed by dispatch_activated retain the ordinary cross-bridge billing
      // semantics documented below.
      const unactivatedQueueDispatches = [...promptQueueDispatchCancellations.values()];
      promptQueueDispatchCancellations.clear();
      for (const registered of unactivatedQueueDispatches) {
        trackPromptQueueCompensation(
          registered.cancel("BRIDGE_CLOSED_BEFORE_ACTIVATION"),
        );
      }

      // P0 修复(2026-07-03)— **桥关 ≠ turn 终止,finalCleanup 不再 abort 残留
      // inflight turn**。v5 断流续写语义下(turn 跨 WS 重连存活 + ring 重放),用户
      // 断线/重连/displacement/master 平滑重启后,容器侧 codex turn 继续跑;旧实现
      // 在这里把残留 snapshot 全部 abandon(abort journal + release reservation),
      // billing 帧随后到达**新桥**时撞上 aborted journal → 整 turn 免费(收入漏洞,
      // e2e 实测复现)。桥对"容器侧 turn 是否存活"不可知,裁决权交给权威源:
      //   - billing 帧到达任意桥(旧桥 drain 窗口 / 新桥 journal 回查)→ settle;
      //   - turn 真死(容器崩 / billing 帧永失)→ finalizeJournalReconciler 先让
      //     immutable tape 持久重试；有 usage_records 就补 committed。若 durable
      //     inflight 到独立 evidence SLA(默认 ≥24h,
      //     COMMERCIAL_FINALIZE_DURABLE_WAIVER_AGE_MS)仍无 usage，才写显式永久免单；
      //     finalizing owner 绝不按时间 abort。legacy 行仍走 ≥30min timeout；
      //   - preCheck 软预扣不在此处提前释放:settle 时由 finalizer release,否则
      //     Redis TTL(300s)自然回收。代价 = 低余额用户断线后至多 5min 内新 turn
      //     可能被软预扣挡住 —— 但该 turn 确实仍在消耗,语义正确且有界。
      // 已 settle 的 turn 由 Map.delete 纪律先行摘除;这里只清本地帧路由簿记,
      // **不动 journal 权威状态**。
      if (inflightCodexTurns.size > 0) {
        bridgeLog?.info("user-chat-bridge: bridge closed with surviving codex turns — journal left inflight (cross-bridge settle / reconciler will adjudicate)", {
          finalCause,
          leftover: inflightCodexTurns.size,
          requestIds: [...inflightCodexTurns.keys()],
        });
      }
      inflightCodexTurns.clear();
      if (pendingZcodeRelays.size > 0) {
        for (const relay of pendingZcodeRelays.values()) {
          deps.expireZcodeRoute?.(relay.token);
        }
        pendingZcodeRelays.clear();
      }
      if (deps.pgPool && pendingZcodeRequestIds.size > 0) {
        ensureZcodeStaleReconcile();
        const leftover = [...pendingZcodeRequestIds];
        trackZcodeAuditWork(
          closePendingZcodeAudits(deps.pgPool, {
            userId: uid,
            requestIds: leftover,
            terminalCode: zcodeCleanupTerminal(finalCause),
            pending: pendingZcodeRequestIds,
          }).then(() => undefined),
        );
      }
      // durable dispatch 本地簿记清空(权威在 turn_dispatches;reconciler 兜底 open 行)。
      admittedDispatches.clear();

      // Release every session-scoped admission state. Awaiting acquire/route
      // continuations carry the state identity fence and release any resource
      // they receive after this map has been cleared. A route already handed to
      // the container belongs to the surviving turn, not to this browser bridge:
      // keep it active across reconnect and let its container+user-bound TTL own
      // cleanup if no later terminal frame reaches this bridge.
      for (const state of [...activeCodexTurnsByPeer.values()]) {
        // A forwarded Grok turn can outlive this browser bridge. Keep its account slot
        // leased to the relay; terminal handling or the generic slot reaper releases it.
        const preserveGrokSlot = state.engine === "grok" && state.turnForwarded;
        releaseCodexTurnState(state, "bridge_cleanup", !state.turnForwarded, preserveGrokSlot);
      }
      try { connectAbort.abort(); } catch { /* */ }
      try {
        // 注意:CLOSING 状态也强 terminate(),不依赖对端 echo,
        // 否则有可能 close 帧丢失或 send 异常导致连接卡死
        if (containerWs.readyState !== WebSocket.CLOSED) {
          containerWs.terminate();
        }
      } catch { /* */ }

      const closeCode = userWs.readyState === WebSocket.CLOSED
        ? (userWs as unknown as { _closeCode?: number })._closeCode ?? CLOSE_BRIDGE.NORMAL
        : CLOSE_BRIDGE.NORMAL;
      const closeReason = userWs.readyState === WebSocket.CLOSED
        ? String((userWs as unknown as { _closeMessage?: string })._closeMessage ?? "")
        : "";

      metrics.onClose?.({
        uid,
        connId,
        durationMs: Date.now() - startedAt,
        closeCode,
        closeReason,
        bytesUserToContainer: bytesUC,
        bytesContainerToUser: bytesCU,
        cause: finalCause,
      });
      bridgeLog?.info("user-chat-bridge: closed", {
        durationMs: Date.now() - startedAt,
        bytesUC, bytesCU, cause: finalCause,
      });
    }
  }

  async function shutdown(reason = "server shutting down"): Promise<void> {
    clearInterval(ringPruneTimer);
    clearInterval(controlDrainTimer);
    clearInterval(recoveryDrainTimer);
    registry.closeAll(reason);
    await outboundPersistQueues.drain();
    await new Promise<void>((resolve) => {
      try { wss.close(() => resolve()); } catch { resolve(); }
    });
    while (pendingPromptQueueCompensations.size > 0 || pendingZcodeAuditWork.size > 0) {
      await Promise.allSettled([
        ...pendingPromptQueueCompensations,
        ...pendingZcodeAuditWork,
      ]);
    }
  }

  /**
   * 把 payload 以 JSON text 帧发送给 uid 名下所有 OPEN 状态的 user WS。
   * 非 OPEN 状态的 ws 直接跳过(不是错误)。send 本身异常单独 catch,不连累其他 ws。
   */
  function broadcastToUser(uid: bigint, payload: unknown): number {
    const set = uidToUserWs.get(uid.toString());
    // 可观测:cost_charged 投递命中情况(per-turn 低频)。set 为空=该 uid 当前无注册 user WS
    // (cost 帧投不出,前端无 live 积分徽章)。排查"积分有时不显示"用得到。
    if ((payload as { type?: string } | null)?.type === "outbound.cost_charged") {
      // 可观测(per-turn 低频):cost_charged 投递命中。recipients=0 表示该 uid 当前无注册 user WS
      // (cost 帧投不出 → 前端无 live 积分徽章)——排查"积分有时不显示"的关键信号。
      log?.info("user-chat-bridge: cost_charged broadcast", {
        uid: uid.toString(),
        recipients: set ? set.size : 0,
        registeredUids: uidToUserWs.size,
      });
    }
    if (!set || set.size === 0) return 0;
    let text: string;
    try { text = JSON.stringify(payload); }
    catch (err) {
      log?.warn("user-chat-bridge: broadcastToUser stringify failed", {
        uid: uid.toString(), err,
      });
      return 0;
    }
    let sent = 0;
    for (const ws of set) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(text, { binary: false }, (err) => {
          if (err) log?.warn("user-chat-bridge: broadcastToUser send error", {
            uid: uid.toString(), err,
          });
        });
        sent += 1;
      } catch (err) {
        log?.warn("user-chat-bridge: broadcastToUser send threw", {
          uid: uid.toString(), err,
        });
      }
    }
    return sent;
  }

  function syncGoalToContainers(uid: bigint, goal: unknown): number {
    const set = uidToContainerWs.get(uid.toString());
    if (!set || set.size === 0) return 0;
    let text: string;
    try { text = JSON.stringify({ type: "inbound.goal_sync", goal }); }
    catch { return 0; }
    let sent = 0;
    for (const ws of set) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(text); sent += 1; } catch { /* next connection */ }
    }
    return sent;
  }

  /**
   * V5 自愈体系(§5)— 全站广播。把 payload 以 JSON text 帧发给**所有**在线 uid 名下所有
   * OPEN user WS。非 OPEN 跳过;单 ws send 异常单独 catch,不连累其他连接。返回成功连接数。
   * stringify 只做一次(payload 全站同一份);stringify 失败返 0。
   */
  function broadcastAll(payload: unknown): number {
    let text: string;
    try { text = JSON.stringify(payload); }
    catch (err) {
      log?.warn("user-chat-bridge: broadcastAll stringify failed", { err });
      return 0;
    }
    let sent = 0;
    for (const set of uidToUserWs.values()) {
      for (const ws of set) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        try {
          ws.send(text, { binary: false }, (err) => {
            if (err) log?.warn("user-chat-bridge: broadcastAll send error", { err });
          });
          sent += 1;
        } catch (err) {
          log?.warn("user-chat-bridge: broadcastAll send threw", { err });
        }
      }
    }
    return sent;
  }

  /**
   * V5 自愈体系(§5)— 定向广播。只给 uids 集合中在线用户的 OPEN user WS 发 payload
   * (audience=user_ids / surface_cohort)。uid 以字符串给出(uidToUserWs key 口径)。
   * 非 OPEN / 未在线 uid 跳过;单 ws 异常单独 catch。返回成功连接数;stringify 失败返 0。
   */
  function broadcastToUsers(uids: string[], payload: unknown): number {
    let text: string;
    try { text = JSON.stringify(payload); }
    catch (err) {
      log?.warn("user-chat-bridge: broadcastToUsers stringify failed", { err });
      return 0;
    }
    let sent = 0;
    for (const uid of uids) {
      const set = uidToUserWs.get(uid);
      if (!set || set.size === 0) continue;
      for (const ws of set) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        try {
          ws.send(text, { binary: false }, (err) => {
            if (err) log?.warn("user-chat-bridge: broadcastToUsers send error", { uid, err });
          });
          sent += 1;
        } catch (err) {
          log?.warn("user-chat-bridge: broadcastToUsers send threw", { uid, err });
        }
      }
    }
    return sent;
  }

  function onlineUserSubset(uids: string[]): string[] {
    const out: string[] = [];
    for (const uid of new Set(uids)) {
      const set = uidToUserWs.get(uid);
      if (set && [...set].some((ws) => ws.readyState === WebSocket.OPEN)) out.push(uid);
    }
    return out;
  }

  return {
    handleUpgrade,
    shutdown,
    registry,
    broadcastToUser,
    syncGoalToContainers,
    broadcastAll,
    broadcastToUsers,
    onlineUserSubset,
  };
}

// ---------- 测试 re-exports ------------------------------------------------
// 供单测直接拿到内部 helpers,不走 ws upgrade 全链路就能验逻辑

export {
  rawDataLen as _rawDataLen,
  encode4503Reason as _encode4503Reason,
  readDispatchDrainMs as _readDispatchDrainMs,
  readDrainBillingMs as _readDrainBillingMs,
};
