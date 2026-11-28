/**
 * v5 出站帧 → 消息模型**翻译 reducer**门面（OCV5-490 / OCV5-928）。
 *
 * 与 vanilla 的唯一架构差异：**零 DOM / 零 timer / 零 setState**。reducer 只做
 * `session.messages` 就地 mutation + 维护游标/指针/守卫；所有跨切面副作用
 * 通过 `FrameEffects` 回调上交给 ChatSocket。
 *
 * 具体实现按帧协议域拆分至 `./reducers/*`，本文件 100% 保持原有显式具名导出契约。
 */
import { AUTO_CONTINUE_PROMPT } from "./pure";
import { normalizeDelegateCards } from "./reducers/delegateReducer";
import { friendlyDelegateResultPreview } from "./reducers/delegateToolParser";
import {
  advanceFrameSeqCursorTo,
  currentFrameSeqAcceptOrder,
  isFrozenLiveTarget,
  resetAgentFrameSeqCursorsForSession,
  resetFrameSeqCursor,
} from "./reducers/frameSeqCursor";
import {
  expireGenPlaceholdersAgainstServerRows,
  failGenPlaceholders,
  normalizeGoalCards,
  planTurnStart,
  resolveGenPlaceholders,
} from "./reducers/goalPlanGenReducer";
import {
  applyCallUsage,
  applyContextCompacted,
  applyContextPressure,
  applyTurnStatus,
  applyTurnUsage,
} from "./reducers/liveUsageEstimator";
import { applyOutboundMessage } from "./reducers/outboundMessageReducer";
import {
  applyPermissionRequest,
  applyPermissionSettled,
  applyPermissionSnapshot,
  isSettledPermissionRequestId,
  rememberSettledPermissionRequestId,
  SETTLED_PERMISSION_REQUEST_IDS_MAX,
} from "./reducers/permissionReducer";
import {
  applyCostCharged,
  applyCostWaived,
  applyLegacyBridgeError,
  applyOutboundError,
  applyResumeFailed,
  enterDeferredRecoverySoftState,
  paintDeferredTerminalError,
  shouldSuppressStaleOutboundError,
  TURN_COST_REMINDER_CREDITS,
} from "./reducers/turnErrorAndCostReducer";
import type {
  DeferredTerminalErrorPaint,
  FrameEffects,
  ProblemCardMaterializeCause,
  ProblemCardPath,
  ProblemCardReport,
} from "./reducers/types";

export {
  AUTO_CONTINUE_PROMPT,
  SETTLED_PERMISSION_REQUEST_IDS_MAX,
  TURN_COST_REMINDER_CREDITS,
  advanceFrameSeqCursorTo,
  applyCallUsage,
  applyContextCompacted,
  applyContextPressure,
  applyCostCharged,
  applyCostWaived,
  applyLegacyBridgeError,
  applyOutboundError,
  applyOutboundMessage,
  applyPermissionRequest,
  applyPermissionSettled,
  applyPermissionSnapshot,
  applyResumeFailed,
  applyTurnStatus,
  applyTurnUsage,
  currentFrameSeqAcceptOrder,
  enterDeferredRecoverySoftState,
  expireGenPlaceholdersAgainstServerRows,
  failGenPlaceholders,
  friendlyDelegateResultPreview,
  isFrozenLiveTarget,
  isSettledPermissionRequestId,
  normalizeDelegateCards,
  normalizeGoalCards,
  paintDeferredTerminalError,
  planTurnStart,
  rememberSettledPermissionRequestId,
  resetAgentFrameSeqCursorsForSession,
  resetFrameSeqCursor,
  resolveGenPlaceholders,
  shouldSuppressStaleOutboundError,
};

export type {
  DeferredTerminalErrorPaint,
  FrameEffects,
  ProblemCardMaterializeCause,
  ProblemCardPath,
  ProblemCardReport,
};
