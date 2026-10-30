import type { ContextRebuiltWire } from "./frames";
import type { ChatSession } from "./model";
import { contextRebuiltNotice } from "./pure";

/**
 * `sys.context_rebuilt` → 时间线上的一条系统提示(W3)。
 *
 * 去重按 `noticeId`:同一段重建(同一次换引擎、同一次原生续接失败)不管重连重放几次、同一回合里
 * 发几帧,只提示一次。旧服务没有 noticeId,退回原来的 frameSeq / ts。已经提示过返回 null。
 * 行 id 前缀不变(`sys-ctxrebuild-`),持久化和 server-wins 合并仍按 client-owned system 行保留。
 */
export function contextRebuiltRow(
  sess: Pick<ChatSession, "id" | "messages">,
  frame: ContextRebuiltWire,
  now: () => number = Date.now,
): { id: string; text: string } | null {
  const identity =
    typeof frame.noticeId === "string" && frame.noticeId
      ? `n${frame.noticeId}`
      : typeof frame.frameSeq === "number" && Number.isFinite(frame.frameSeq)
        ? `f${frame.frameSeq}`
        : typeof frame.ts === "number" && Number.isFinite(frame.ts)
          ? `t${frame.ts}`
          : `x${now()}`;
  const id = `sys-ctxrebuild-${sess.id}-${identity}`;
  if (sess.messages.some((m) => m.id === id)) return null;
  const count =
    typeof frame.messageCount === "number" && Number.isFinite(frame.messageCount) && frame.messageCount > 0
      ? Math.floor(frame.messageCount)
      : sess.messages.length;
  return { id, text: contextRebuiltNotice(count, frame.reason) };
}
