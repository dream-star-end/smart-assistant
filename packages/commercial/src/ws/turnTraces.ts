// turn_traces 登记 — traceId(响应底部请求ID)的唯一持久落点。
//
// bridge 在 inbound.message 铸造 canonical traceId(userChatBridge CG2a)后调用本函数
// fire-and-forget 落一行;运维拿用户报的请求ID一条 SQL 定位 user/session/时间:
//   select * from turn_traces where trace_id = '<id>';
// 失败绝不影响 turn 主链路:观测面挂了不能拖垮对话面,只 warn 一条。
import type { Pool } from "pg";

export interface TurnTraceRow {
  traceId: string;
  userId: bigint;
  sessionKey: string;
  agentId?: string | null;
  model?: string | null;
  // durable turn dispatch(RFC §2):纯展示,记 dispatch 身份/请求 id 供运维定位,不参与任何判定。
  dispatchId?: string | null;
  requestId?: string | null;
}

export function recordTurnTrace(
  pool: Pool | undefined,
  warn: ((msg: string, fields?: Record<string, unknown>) => void) | undefined,
  row: TurnTraceRow,
): void {
  if (!pool) return;
  void pool
    .query(
      `INSERT INTO turn_traces (trace_id, user_id, session_key, agent_id, model, dispatch_id, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (trace_id) DO NOTHING`,
      [
        row.traceId,
        row.userId.toString(),
        row.sessionKey,
        row.agentId ?? null,
        row.model ?? null,
        row.dispatchId ?? null,
        row.requestId ?? null,
      ],
    )
    .catch((err) => warn?.("turn-trace record failed", { err: String(err) }));
}

/**
 * MIN1:trace 登记发生在**分类阶段**(同步,dispatch 尚未受理),此时 dispatch_id/request_id
 * 还没铸;受理成功后本函数 **fire-and-forget** 补填这两个纯展示列(RFC §2 I3)。绝不动受理主链,
 * 失败只 warn(观测挂了不能拖垮对话)。COALESCE 兜底:trace 行若尚未落(极端时序),UPDATE
 * 命中 0 行无害,下次进会话仍可靠 dispatch/usage 表定位。
 */
export function updateTurnTraceDispatch(
  pool: Pool | undefined,
  warn: ((msg: string, fields?: Record<string, unknown>) => void) | undefined,
  input: { traceId: string; dispatchId: string; requestId: string },
): void {
  if (!pool) return;
  void pool
    .query(
      `UPDATE turn_traces
          SET dispatch_id = COALESCE(dispatch_id, $2),
              request_id  = COALESCE(request_id, $3)
        WHERE trace_id = $1`,
      [input.traceId, input.dispatchId, input.requestId],
    )
    .catch((err) => warn?.("turn-trace dispatch backfill failed", { err: String(err) }));
}
