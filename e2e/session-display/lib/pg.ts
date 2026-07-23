// 可选 DB 通道:仅用于依赖 direct-timeline/durable-turn 的用例(种子大会话、注入
// verified turn status)。铁律:只在**预发**且显式提供 OC_E2E_PG_URL 时启用;缺省 → 相关
// 用例 skip-with-reason,绝不碰生产 DB,绝不无凭据猜连。
//
// 用 psql CLI(本机已装)执行,避免给 e2e 引入 pg 驱动依赖。

import { execFileSync } from 'node:child_process';
import { config } from './env';

export interface DirectTimelineCapability {
  available: boolean;
  reason: string;
}

function psql(sql: string, opts: { tuplesOnly?: boolean } = {}): string {
  const url = config().pgUrl;
  if (!url) throw new Error('[pg] OC_E2E_PG_URL 未设置');
  const args = ['-v', 'ON_ERROR_STOP=1', '-X'];
  if (opts.tuplesOnly) args.push('-tA');
  args.push('-c', sql, url);
  return execFileSync('psql', args, { encoding: 'utf8', timeout: 20_000 });
}

/**
 * direct-timeline 部署能力探测:需 OC_E2E_PG_URL + 迁移 0176 的 tape 元数据列。
 * 任一缺失 → available:false + 明确 reason(供 test.skip 打印)。
 */
export function probeDirectTimeline(): DirectTimelineCapability {
  const cfg = config();
  if (!cfg.pgUrl) {
    return { available: false, reason: '未提供 OC_E2E_PG_URL:无 DB 注入通道,direct-timeline 依赖用例跳过' };
  }
  try {
    const out = psql(
      `SELECT to_regclass('public.turn_dispatches') IS NOT NULL
          AND to_regclass('public.client_session_turn_tape_records') IS NOT NULL
          AND EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='client_session_turn_tapes'
                   AND column_name='physical_record_count'
              )`,
      { tuplesOnly: true },
    ).trim();
    if (out === 't') return { available: true, reason: 'direct-timeline 就绪(迁移 0176 已 apply)' };
    return { available: false, reason: '迁移 0176 未完整 apply：跳过 direct-timeline 用例' };
  } catch (err) {
    return { available: false, reason: `direct-timeline 探测失败(psql 连接/权限):${(err as Error).message.slice(0, 160)}` };
  }
}

/** 执行任意 SQL(种子/注入用)。仅在 probeDirectTimeline().available 为真且显式允许时调用。 */
export function runSql(sql: string): string {
  return psql(sql);
}

export function queryScalar(sql: string): string {
  return psql(sql, { tuplesOnly: true }).trim();
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** 发布门最终权威：该用例 exact session 产生了 turn，且每个 durable dispatch 都是固定模型。 */
export function assertSessionDispatchModel(userId: string, sessionId: string, model: string): void {
  if (!/^[1-9][0-9]*$/.test(userId)) throw new Error(`[pg] invalid user id ${userId}`);
  const raw = queryScalar(`
    SELECT COALESCE(json_agg(json_build_object(
      'dispatch_id',dispatch_id::text,
      'model',model,
      'attempt_no',attempt_no
    ) ORDER BY admitted_at)::text,'[]')
      FROM turn_dispatches
     WHERE user_id=${userId} AND session_id=${sqlText(sessionId)}
  `);
  const rows = JSON.parse(raw) as Array<{ dispatch_id: string; model: string | null; attempt_no: number }>;
  if (rows.length === 0) {
    throw new Error(`[pg] fixed-model guard: session ${sessionId} 没有实际 dispatch`);
  }
  const drift = rows.filter((row) => row.model !== model);
  if (drift.length > 0) {
    throw new Error(
      `[pg] fixed-model guard: session ${sessionId} expected=${model} drift=${JSON.stringify(drift)}`,
    );
  }
}
