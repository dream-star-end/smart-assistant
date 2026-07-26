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
 * 06 的分页夹具规格:总行数必须 > 首屏 100 行(readClientTimelinePage 首页上限),
 * 否则 timelineHasMore 恒 false,UI 的分页控件根本不出现。
 */
export const PAGED_SEED = {
  /** 会话主行(热尾巴)里的消息条数。260 → 首屏 100 + 2 页,3 次点击到底。 */
  hotRows: 260,
} as const;
export const PAGED_SEED_TOTAL_ROWS = PAGED_SEED.hotRows;
/** 行 id / 行文本里的序号零填充,便于按文本还原顺序、按 id 做 union 判定。 */
export function pagedSeedMessageId(seq: number): string {
  return `e2e-page-${String(seq).padStart(6, '0')}`;
}

/**
 * 种子:一个**必须翻页**的真实会话(PAGED_SEED_TOTAL_ROWS 条 server 权威消息)。
 *
 * 为什么需要它(2026-07-26 门禁审计):06 的 UI 逐页断言原本包在
 * `if (archivedSid && total > 0)` 里,而 v5-evals 是纯验证账号、每条用例结束即删会话,
 * 永远凑不出带归档的会话 —— 该分支从落地起一次没执行过(实测整条用例 2.47s),
 * 却是 INC-20260721-LAZY-TIMELINE-LOSS 指名的 live 证据。有了这个夹具,分支变成必跑:
 * 首屏只给 100 行,`timelineHasMore=true` + `timelineCursor` 必然下发,
 * UI 的 history-page-loader 必然出现,并且必须在有限次点击内收敛到「已到最早记录」。
 *
 * 行内容刻意可解析(pagedSeedMessageId + 文本带同一序号):跨页重复行 / 丢行 / 游标不收敛
 * 都能在 id union 上直接判定,不依赖虚拟列表当下挂载了哪些 DOM 节点。
 * JSON 在 PG 内用 generate_series 拼装,不把几百条消息塞进 psql argv。
 *
 * 【为什么不注入 client_session_archive_chunks(2026-07-26 实测)】
 * 本想让夹具跨"热尾巴 → 归档 chunk"边界,更贴近 INC-20260721 的真实形态。造出来后在
 * 本地 fixture PG(schema 从 public 克隆,列型一致)上用生产读路径
 * `createPgSessionsBackend(...).readClientTimelinePage` 实跑,首页即抛:
 *     error 22003: value "9007199254740991" is out of range for type integer
 *     at readUnifiedTimelineOuterCandidates (pgSessionsBackend.ts:4383)
 * 根因:该查询把首页游标 `Number.MAX_SAFE_INTEGER` 当**绑定参数**喂给
 * `first_seq < $3`,而 first_seq 是 INTEGER → PG 按 int4 解析参数直接越界;
 * 紧邻的 `last_seq < $4::bigint` 恰好写了 cast,所以只有 $3 中弹。
 * 影响面 = 任何 archived_through_seq > 0 的会话(该 while 循环只在有归档时进入):
 * 其 timeline 读会抛 → GET /api/sessions/:id 落 500,长会话直接打不开。
 * 修复属存储层(不在本批文件所有权内),已作为 P0 上报;修好后把归档形态加回来只需
 * 在这里补 chunk 注入(SQL 已验证可用,见交付说明)。在那之前**不注入归档**:
 * 让 06 红在一个别人负责的存储 bug 上,只会让门变成噪音。
 */
export function seedPagedArchivedSession(numericUserId: string, sessionId: string): void {
  requireDirectTimeline();
  const uid = pgUserId(numericUserId);
  const now = Date.now();
  const total = PAGED_SEED_TOTAL_ROWS;
  // 单行 JSON 构造器(seq → 消息对象)。user/assistant 交替,保证两类行选择器都命中。
  const rowJson = (seqExpr: string) => `
    jsonb_build_object(
      'id','e2e-page-'||lpad(${seqExpr}::text,6,'0'),
      'role',CASE WHEN ${seqExpr} % 2 = 1 THEN 'user' ELSE 'assistant' END,
      'text','e2e-paging row '||lpad(${seqExpr}::text,6,'0'),
      'ts',${now} - (${total} - ${seqExpr}) * 1000,
      '_source','server',
      '_seq',${seqExpr},
      '_orderSeq',${seqExpr}
    )`;

  runSql(
    `INSERT INTO client_sessions
       (id,user_id,agent_id,title,created_at,last_at,messages,message_count,updated_at,next_seq,
        archived_through_seq,archived_count)
     SELECT ${q(sessionId)},${q(uid)},'main','e2e-paged-session',${now - total * 1000},${now},
            (SELECT jsonb_agg(${rowJson('i')} ORDER BY i)::text
               FROM generate_series(1,${total}) AS g(i)),
            ${total},${now},${total + 1},0,0
     ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id, messages=EXCLUDED.messages,
       message_count=EXCLUDED.message_count, next_seq=EXCLUDED.next_seq,
       archived_through_seq=EXCLUDED.archived_through_seq, archived_count=EXCLUDED.archived_count,
       deleted_at=NULL`,
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

/**
 * 清理注入(会话删除会经 FK 级联 tapes;dispatch 与归档两张无 FK 的表单独清)。
 * 只对 e2e- 前缀的注入会话调用;归档行不清会在验证账号里长期堆着。
 */
export function cleanupSeed(sessionId: string): void {
  if (!config().pgUrl) return;
  try {
    runSql(`DELETE FROM turn_dispatches WHERE session_id=${q(sessionId)}`);
    runSql(`DELETE FROM client_session_archive_chunks WHERE session_id=${q(sessionId)}`);
    runSql(`DELETE FROM client_session_archived_ids WHERE session_id=${q(sessionId)}`);
    queryScalar('SELECT 1');
  } catch {
    /* best-effort */
  }
}
