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
}

export function recordTurnTrace(
  pool: Pool | undefined,
  warn: ((msg: string, fields?: Record<string, unknown>) => void) | undefined,
  row: TurnTraceRow,
): void {
  if (!pool) return;
  void pool
    .query(
      `INSERT INTO turn_traces (trace_id, user_id, session_key, agent_id, model)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (trace_id) DO NOTHING`,
      [row.traceId, row.userId.toString(), row.sessionKey, row.agentId ?? null, row.model ?? null],
    )
    .catch((err) => warn?.("turn-trace record failed", { err: String(err) }));
}
