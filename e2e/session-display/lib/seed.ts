// direct-timeline / durable-turn 依赖用例(2 大会话惰性读取、5 verified 状态)的种子/注入助手。
// 铁律:仅在**预发**且 OC_E2E_PG_URL 就绪 + 迁移 0176 已完成时可用;任一缺失或注入
// 失败 → 抛 SeedUnavailable,spec 捕获后 test.skip(不制造假失败)。schema 依据:
//   0176(client_session_turn_tapes metadata / direct dispatch status)
//   0147(client_session_turn_tape_records)/ 0134(client_sessions)。

import { randomBytes } from 'node:crypto';
import { config } from './env';
import { probeDirectTimeline, runSql, queryScalar } from './pg';

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

/** direct-timeline 能力门:不可用即抛 SeedUnavailable(带 reason)。 */
export function requireDirectTimeline(): void {
  const cap = probeDirectTimeline();
  if (!cap.available) throw new SeedUnavailable(cap.reason);
}

/** client_sessions 的 user_id 形态 = 'c:<numericUserId>'(可用 OC_E2E_PG_USER_ID 覆盖)。 */
function pgUserId(numericUserId: string): string {
  return process.env.OC_E2E_PG_USER_ID?.trim() || `c:${numericUserId}`;
}

/**
 * 种子:一个 finalized tape。最终答复是真实记录并在首屏直出；2 MiB 工具记录
 * 只返回不可变元数据，用户展开过程后再从 payload 端点读取原文。
 */
export function seedLargeSession(numericUserId: string, sessionId: string): void {
  requireDirectTimeline();
  const uid = pgUserId(numericUserId);
  const now = Date.now();
  const tape = hex64();
  const turnKey = hex64();
  const userMessageId = `e2e-user-${tape.slice(0, 12)}`;
  const toolId = `e2e-tool-${tape.slice(0, 12)}`;
  const answerId = `e2e-answer-${tape.slice(0, 12)}`;
  const bigBytes = 2 * 1024 * 1024;
  const hotMessages = JSON.stringify([
    { id: userMessageId, role: 'user', text: 'e2e 大会话真实过程', ts: now - 2, _source: 'server', _seq: 1, _orderSeq: 1 },
    {
      id: answerId,
      role: 'assistant',
      text: '',
      ts: now,
      _source: 'server',
      _seq: 2,
      _orderSeq: 2,
      _clientMessageId: userMessageId,
      _turnTapeId: tape,
      _turnTapeSha256: tape,
      _turnTapeComplete: true,
      _turnTapeRecordCount: 2,
      _turnTapePhysicalRecordCount: 2,
      _turnTapeLogicalRecordCount: 2,
    },
  ]);

  // 会话主行只存 user + tape anchor，不复制过程正文。
  runSql(
    `INSERT INTO client_sessions (id,user_id,agent_id,title,created_at,last_at,messages,message_count,updated_at,next_seq)
     VALUES (${q(sessionId)},${q(uid)},'main','e2e-large-session',${now},${now},${q(hotMessages)},2,${now},3)
     ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id, messages=EXCLUDED.messages,
       message_count=EXCLUDED.message_count, next_seq=EXCLUDED.next_seq, deleted_at=NULL`,
  );

  runSql(
    `INSERT INTO client_session_turn_tapes
       (session_id,user_id,tape_id,agent_id,turn_index,status,turn_key,tape_sha256,total_bytes,
        part_count,billing_anchor_id,created_at,finalized_at,client_message_id,
        physical_record_count,logical_record_count,record_payload_bytes)
     VALUES (${q(sessionId)},${q(uid)},${q(tape)},'main',0,'completed',${q(turnKey)},${q(tape)},
       ${bigBytes},1,${q(answerId)},${now},${now},${q(userMessageId)},2,2,0)`,
  );

  // 真实工具 payload 在数据库内构造，避免把 2 MiB 字符串塞进 psql argv。
  runSql(
    `WITH exact(payload) AS (
       SELECT convert_to(jsonb_build_object(
         'id',${q(toolId)},'role','tool','text','','ts',${now - 1},
         'toolName','Bash','inputJson',jsonb_build_object('command','e2e-long-output'),
         'output',repeat('x',${bigBytes}) || 'E2E_TOOL_FINAL_MARKER','_completed',true
       )::text,'UTF8')
     )
     INSERT INTO client_session_turn_tape_records
       (session_id,user_id,tape_id,msg_id,ordinal,role,ts,content_sha256,payload)
     SELECT ${q(sessionId)},${q(uid)},${q(tape)},${q(toolId)},0,'tool',${now - 1},
            encode(public.digest(payload,'sha256'),'hex'),payload FROM exact`,
  );
  runSql(
    `WITH exact(payload) AS (
       SELECT convert_to(jsonb_build_object(
         'id',${q(answerId)},'role','assistant','text','e2e 首屏可见的真实最终答复','ts',${now},
         '_clientMessageId',${q(userMessageId)}
       )::text,'UTF8')
     )
     INSERT INTO client_session_turn_tape_records
       (session_id,user_id,tape_id,msg_id,ordinal,role,ts,content_sha256,payload)
     SELECT ${q(sessionId)},${q(uid)},${q(tape)},${q(answerId)},1,'assistant',${now},
            encode(public.digest(payload,'sha256'),'hex'),payload FROM exact`,
  );
  runSql(
    `UPDATE client_session_turn_tapes t
        SET record_payload_bytes=(SELECT SUM(octet_length(r.payload))
                                    FROM client_session_turn_tape_records r
                                   WHERE r.session_id=t.session_id AND r.user_id=t.user_id AND r.tape_id=t.tape_id)
      WHERE t.session_id=${q(sessionId)} AND t.user_id=${q(uid)} AND t.tape_id=${q(tape)}`,
  );
}

/**
 * 注入一条已验证且已通知的 terminal(not_accepted) 状态，及一条已被 late tape
 * 推翻为 manual_reconcile 的状态。浏览器直接读 turn_dispatches，不制造消息替身。
 */
export function seedTurnStatuses(
  numericUserId: string,
  sessionId: string,
  anchor: { visibleCmid: string; visibleSeq: number; resolvedCmid: string; resolvedSeq: number },
): { visibleDispatchId: string; resolvedDispatchId: string } {
  requireDirectTimeline();
  const visibleDispatchId = uuid();
  const resolvedDispatchId = uuid();

  const insertDispatch = (dispatchId: string, cmid: string, seq: number, resolved: boolean) =>
    runSql(
      `INSERT INTO turn_dispatches
         (dispatch_id,user_id,session_id,client_message_id,agent_id,request_hash,billing_request_id,
          status,outcome,failure_code,conflict_reason,client_notified,anchor_seq,terminal_at,admitted_at)
       VALUES (${q(dispatchId)},${numericUserId},${q(sessionId)},${q(cmid)},'main',${q(hex64())},${q('e2e-' + cmid)},
         ${resolved ? "'manual_reconcile'" : "'terminal'"},'not_accepted','dispatch_lost',
         ${resolved ? "'late_tape'" : 'NULL'},true,${seq},NOW(),NOW())
       ON CONFLICT (dispatch_id) DO NOTHING`,
    );

  insertDispatch(visibleDispatchId, anchor.visibleCmid, anchor.visibleSeq, false);
  insertDispatch(resolvedDispatchId, anchor.resolvedCmid, anchor.resolvedSeq, true);

  return { visibleDispatchId, resolvedDispatchId };
}

/** 清理注入(会话删除会经 FK 级联 tapes;dispatch 单独清)。 */
export function cleanupSeed(sessionId: string): void {
  if (!config().pgUrl) return;
  try {
    runSql(`DELETE FROM turn_dispatches WHERE session_id=${q(sessionId)}`);
    queryScalar('SELECT 1');
  } catch {
    /* best-effort */
  }
}
