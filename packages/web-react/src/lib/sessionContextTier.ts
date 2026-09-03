/**
 * Cursor Opus/Fable 上下文档位(contextTier: 300k / 1m)的**会话级**持久化。
 *
 * 权威语义(与 lib/teamMode 同模式):
 *  - 每个会话独立记忆,键 `oc_v5_context_tier:<sessionId>`,存显式 `"300k"`/`"1m"`。
 *  - 全局键 `oc_v5_context_tier` 镜像用户最近一次选择,供**新会话**继承;会话一旦有了
 *    per-session 键即以其为准,不受其它会话切换影响。
 *  - 两个键都缺 → DEFAULT_CURSOR_CONTEXT_TIER(300k,产品默认档)。
 *  - sessionId 为空(空会话态):只读/只写全局默认;首条消息创建会话后由 App 把当前
 *    intent 落地为该会话的 per-session 键。
 *
 * 后端:contextTier 是 inbound.message 顶层 turn 级字段,master 据此逐 turn 收窄签名
 * descriptor.contextWindow(protocol projectContextWindowForCursorTier);非 Opus/Fable
 * 模型忽略该字段。本模块只管前端持久化与继承规则。
 */
import {
  type CursorContextTier,
  DEFAULT_CURSOR_CONTEXT_TIER,
  isCursorContextTier,
} from "@openclaude/protocol";

export const CONTEXT_TIER_GLOBAL_KEY = "oc_v5_context_tier";

export function contextTierSessionKey(sessionId: string): string {
  return `${CONTEXT_TIER_GLOBAL_KEY}:${sessionId}`;
}

/**
 * 读某会话的上下文档位:per-session 键优先,缺失回退全局偏好,再缺失回退产品默认(300k)。
 * localStorage 不可用 / 值非法 → 默认档。
 */
export function readContextTierForSession(sessionId: string | undefined): CursorContextTier {
  try {
    if (sessionId) {
      const v = localStorage.getItem(contextTierSessionKey(sessionId));
      if (isCursorContextTier(v)) return v;
    }
    const g = localStorage.getItem(CONTEXT_TIER_GLOBAL_KEY);
    return isCursorContextTier(g) ? g : DEFAULT_CURSOR_CONTEXT_TIER;
  } catch {
    return DEFAULT_CURSOR_CONTEXT_TIER;
  }
}

/**
 * 写上下文档位:落地 per-session 键(仅当有 sessionId)+ 更新全局偏好默认值。
 * best-effort,失败不抛(内存选择仍生效)。
 */
export function writeContextTier(sessionId: string | undefined, tier: CursorContextTier): void {
  try {
    if (sessionId) localStorage.setItem(contextTierSessionKey(sessionId), tier);
    localStorage.setItem(CONTEXT_TIER_GLOBAL_KEY, tier);
  } catch {
    // Storage 只是最佳努力;写失败不影响内存状态。
  }
}

/** 删除某会话的 per-session 键(会话删除时顺手清)。best-effort。 */
export function clearContextTierForSession(sessionId: string): void {
  try {
    localStorage.removeItem(contextTierSessionKey(sessionId));
  } catch {
    // best-effort
  }
}
