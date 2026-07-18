// §9 / durable-turn 依赖用例(2 大会话折叠、5 错误投影)的种子/注入助手。
// 铁律:仅在**预发**且 OC_E2E_PG_URL 就绪 + 迁移 0170 表存在时可用;任一缺失或注入
// 失败 → 抛 SeedUnavailable,spec 捕获后 test.skip(不制造假失败)。schema 依据:
//   0170(turn_dispatches / turn_dispatch_error_projections / tape_chat_projection)
//   0147(client_session_turn_tapes)/ 0134(client_sessions)。
// 注:此类 DB 注入无法在无 §9 环境验证,落地 §9 预发后按实际 schema 复核(README 已标注)。

import { randomBytes } from 'node:crypto';
import { config } from './env';
import { probeSection9, runSql, queryScalar } from './pg';

export class SeedUnavailable extends Error {}

function hex64(): string {
  return randomBytes(32).toString('hex');
}
function uuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function q(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** §9 能力门:不可用即抛 SeedUnavailable(带 reason)。 */
export function requireSection9(): void {
  const cap = probeSection9();
  if (!cap.available) throw new SeedUnavailable(cap.reason);
}

/** client_sessions 的 user_id 形态 = 'c:<numericUserId>'(可用 OC_E2E_PG_USER_ID 覆盖)。 */
function pgUserId(numericUserId: string): string {
  return process.env.OC_E2E_PG_USER_ID?.trim() || `c:${numericUserId}`;
}

/**
 * 种子:一个含多卷投影、其中至少一卷返回折叠卡的大会话。
 * building 卷读侧一律折叠(§9.1)→ 稳定产出"本轮完整输出 N MB"折叠卡;
 * 另置一 complete 卷(带 rows)用于展开断言。
 */
export function seedLargeSession(numericUserId: string, sessionId: string): void {
  requireSection9();
  const uid = pgUserId(numericUserId);
  const now = Date.now();
  const buildingTape = hex64();
  const completeTape = hex64();
  const bigBytes = 192 * 1024 * 1024;

  // 会话主行(deleted_at NULL)。
  runSql(
    `INSERT INTO client_sessions (id,user_id,agent_id,title,created_at,last_at,messages,message_count,updated_at,next_seq)
     VALUES (${q(sessionId)},${q(uid)},'main','e2e-large-session',${now},${now},'[]',0,${now},10)
     ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id, deleted_at=NULL`,
  );

  for (const [tape, bytes, status] of [
    [buildingTape, bigBytes, 'completed'],
    [completeTape, 4096, 'completed'],
  ] as const) {
    runSql(
      `INSERT INTO client_session_turn_tapes
         (session_id,user_id,tape_id,agent_id,turn_index,status,turn_key,tape_sha256,total_bytes,part_count,created_at,finalized_at)
       VALUES (${q(sessionId)},${q(uid)},${q(tape)},'main',${tape === buildingTape ? 0 : 1},${q(status)},${q(hex64())},${q(tape)},${bytes},1,${now},${now})
       ON CONFLICT (session_id,user_id,tape_id) DO NOTHING`,
    );
  }

  // building 卷:读侧折叠(半成品永不冒充完整)。
  runSql(
    `INSERT INTO tape_chat_projection (session_id,user_id,tape_id,rows,state,next_part,tape_sha256,total_bytes,row_count)
     VALUES (${q(sessionId)},${q(uid)},${q(buildingTape)},'[]'::jsonb,'building',0,${q(buildingTape)},${bigBytes},1)
     ON CONFLICT (session_id,user_id,tape_id) DO UPDATE SET state='building', total_bytes=EXCLUDED.total_bytes`,
  );
  // complete 卷:带一条 assistant 文本行,供展开断言。
  const completeRows = JSON.stringify([
    { role: 'assistant', kind: 'text', text: 'e2e 展开可见的完整输出内容', _clientMessageId: `m-${completeTape.slice(0, 8)}` },
  ]);
  runSql(
    `INSERT INTO tape_chat_projection (session_id,user_id,tape_id,rows,state,next_part,tape_sha256,total_bytes,row_count)
     VALUES (${q(sessionId)},${q(uid)},${q(completeTape)},${q(completeRows)}::jsonb,'complete',1,${q(completeTape)},4096,1)
     ON CONFLICT (session_id,user_id,tape_id) DO UPDATE SET state='complete', rows=EXCLUDED.rows`,
  );
}

/**
 * 注入:一条 terminal(not_accepted)dispatch + active error projection(dispatch_lost)。
 * 读侧投影为虚拟错误行 id='oc-dispatch-err:<dispatch_id>' → 前端渲染"消息未开始处理/已确认未计费"卡。
 * 另注入一条 revoked 投影,断言其**不显示**(钱安全:内容仍完整,不冒充丢失)。
 * 返回可见与被撤销的 clientMessageId。
 */
export function seedErrorProjection(
  numericUserId: string,
  sessionId: string,
  anchor: { visibleCmid: string; visibleSeq: number; revokedCmid: string; revokedSeq: number },
): { visibleDispatchId: string; revokedDispatchId: string } {
  requireSection9();
  const uid = pgUserId(numericUserId);
  const visibleDispatchId = uuid();
  const revokedDispatchId = uuid();

  const insertDispatch = (dispatchId: string, cmid: string) =>
    runSql(
      `INSERT INTO turn_dispatches
         (dispatch_id,user_id,session_id,client_message_id,agent_id,request_hash,billing_request_id,status,outcome,terminal_at,admitted_at)
       VALUES (${q(dispatchId)},${numericUserId},${q(sessionId)},${q(cmid)},'main',${q(hex64())},${q('e2e-' + cmid)},'terminal','not_accepted',NOW(),NOW())
       ON CONFLICT (dispatch_id) DO NOTHING`,
    );

  insertDispatch(visibleDispatchId, anchor.visibleCmid);
  insertDispatch(revokedDispatchId, anchor.revokedCmid);

  runSql(
    `INSERT INTO turn_dispatch_error_projections (dispatch_id,user_id,session_id,client_message_id,error_code,anchor_seq)
     VALUES (${q(visibleDispatchId)},${numericUserId},${q(sessionId)},${q(anchor.visibleCmid)},'dispatch_lost',${anchor.visibleSeq})
     ON CONFLICT (dispatch_id) DO NOTHING`,
  );
  runSql(
    `INSERT INTO turn_dispatch_error_projections (dispatch_id,user_id,session_id,client_message_id,error_code,anchor_seq,revoked_at)
     VALUES (${q(revokedDispatchId)},${numericUserId},${q(sessionId)},${q(anchor.revokedCmid)},'dispatch_lost',${anchor.revokedSeq},NOW())
     ON CONFLICT (dispatch_id) DO NOTHING`,
  );

  return { visibleDispatchId, revokedDispatchId };
}

/** 清理注入(会话删除会经 FK 级联 tapes/projection;dispatch 单独清)。 */
export function cleanupSeed(sessionId: string): void {
  if (!config().pgUrl) return;
  try {
    runSql(`DELETE FROM turn_dispatches WHERE session_id=${q(sessionId)}`);
    runSql(`DELETE FROM tape_chat_projection WHERE session_id=${q(sessionId)}`);
    queryScalar('SELECT 1');
  } catch {
    /* best-effort */
  }
}
