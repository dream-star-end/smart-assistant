// errorProjections —— turn_dispatch_error_projections 的单一投影 helper(RFC-v5-durable-turn
// -dispatch §2.5)。
//
// 一条 dispatch 落 terminal(not_accepted / executed_error)且判定「未计费、可安全告知失败」时,
// reconciler 写一条投影行;它在会话读侧被渲染成一张 error 卡(免单 tone),回答用户「这条消息
// 没能产出回复」。late true tape 到达 → 撤销(revoked_at)而非删除(钱安全 I5:内容仍完整 materialize)。
//
// 单一 helper 供三读边界共用(full get / sync 增量 / archive 分页):
//   - 虚拟行 id = `oc-dispatch-err:<dispatch_id>`(稳定,client reducer 按 id 归属/去重);
//   - 排序键 = (anchor_seq, 1, dispatch_id):锚在 user 行的 _seq 上,ordinal=1 使其紧随 user 行;
//   - **引擎历史注入(_masterHistoricalMessages)绝不含投影**——失败提示永不进模型上下文。

import type { Queryable } from './turnDispatchStore.js'

/** 虚拟行 id 前缀;client 与 master 同源(web-react reducer 按此前缀识别 dispatch-lost 卡)。 */
export const DISPATCH_ERROR_MESSAGE_PREFIX = 'oc-dispatch-err:'

export interface ErrorProjectionRow {
  dispatchId: string
  userId: bigint
  sessionId: string
  clientMessageId: string
  errorCode: string
  anchorSeq: bigint
  createdAt: Date
  revokedAt: Date | null
}

interface RawProjectionRow {
  dispatch_id: string
  user_id: string
  session_id: string
  client_message_id: string
  error_code: string
  anchor_seq: string
  created_at: Date
  revoked_at: Date | null
}

function mapRow(r: RawProjectionRow): ErrorProjectionRow {
  return {
    dispatchId: r.dispatch_id,
    userId: BigInt(r.user_id),
    sessionId: r.session_id,
    clientMessageId: r.client_message_id,
    errorCode: r.error_code,
    anchorSeq: BigInt(r.anchor_seq),
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  }
}

export interface InsertErrorProjectionInput {
  dispatchId: string
  userId: bigint
  sessionId: string
  clientMessageId: string
  errorCode: string
  anchorSeq: bigint
}

/**
 * 写投影(幂等 PK)。reconciler terminal-未通知分支在确认「无 journal / aborted 零 usage」后调。
 * ON CONFLICT DO NOTHING —— 重复扫描不会翻倍,也不会复活已 revoked 行(revoked 场景另走 UPDATE)。
 */
export async function insertErrorProjection(
  q: Queryable,
  input: InsertErrorProjectionInput,
): Promise<boolean> {
  const res = await q.query(
    `INSERT INTO turn_dispatch_error_projections
       (dispatch_id, user_id, session_id, client_message_id, error_code, anchor_seq)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dispatch_id) DO NOTHING`,
    [
      input.dispatchId,
      input.userId.toString(),
      input.sessionId,
      input.clientMessageId,
      input.errorCode,
      input.anchorSeq.toString(),
    ],
  )
  return (res.rowCount ?? 0) === 1
}

/** 撤销投影(late true tape 到达:内容会完整 materialize,失败卡必须收回)。幂等。 */
export async function revokeErrorProjection(
  q: Queryable,
  dispatchId: string,
  now = Date.now(),
): Promise<boolean> {
  const res = await q.query(
    `UPDATE turn_dispatch_error_projections
        SET revoked_at = $2
      WHERE dispatch_id = $1 AND revoked_at IS NULL`,
    [dispatchId, new Date(now)],
  )
  return (res.rowCount ?? 0) === 1
}

/** 读某会话的 active(未撤销)投影,按 anchor_seq 升序(与 user 行同序)。 */
export async function readActiveErrorProjections(
  q: Queryable,
  userId: bigint,
  sessionId: string,
): Promise<ErrorProjectionRow[]> {
  const res = await q.query<RawProjectionRow>(
    `SELECT dispatch_id, user_id, session_id, client_message_id, error_code,
            anchor_seq, created_at, revoked_at
       FROM turn_dispatch_error_projections
      WHERE user_id = $1 AND session_id = $2 AND revoked_at IS NULL
      ORDER BY anchor_seq ASC, dispatch_id ASC`,
    [userId.toString(), sessionId],
  )
  return res.rows.map(mapRow)
}

/** 免单 tone 兜底文案;web-react errorPresentation 按 code 可覆盖更贴切的措辞。 */
const DEFAULT_DISPATCH_LOST_TEXT =
  '这条消息没能产出回复(任务未执行完成)。你没有被计费,请重新发送。'

/**
 * 投影行 → 会话读侧虚拟消息。id 稳定、role=assistant 的 error 卡;`_dispatchLost` 让 web-react
 * 归入免单 tone。`_seq`=anchor_seq 使其落在 user 行同位,`_dispatchErrorOrdinal`=1 紧随其后。
 * 结构对齐 losslessTurnTape 的 error assistant record(_isError/_errorCode/_clientMessageId)。
 */
export function projectionToVirtualMessage(row: ErrorProjectionRow): Record<string, unknown> {
  return {
    id: `${DISPATCH_ERROR_MESSAGE_PREFIX}${row.dispatchId}`,
    role: 'assistant',
    text: DEFAULT_DISPATCH_LOST_TEXT,
    ts: row.createdAt.getTime(),
    _seq: Number(row.anchorSeq),
    _dispatchErrorOrdinal: 1,
    _isError: true,
    _dispatchLost: true,
    // 去枚举化重试判据(RFC §5 M5):projection 恒是「受理未执行/终态失败」证据,不管
    // error_code 具体是 DISPATCH_NOT_ACCEPTED / DISPATCH_LOST / 内部 failureCode,前端一律据
    // 此持久标记铸新 clientMessageId,无需枚举内部码。
    _dispatchTerminal: true,
    _errorCode: row.errorCode,
    _clientMessageId: row.clientMessageId,
  }
}
