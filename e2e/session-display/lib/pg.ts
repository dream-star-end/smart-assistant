// 可选 DB 通道:仅用于依赖 §9(读物化投影)/durable-turn 的用例(种子大会话、注入
// error projection)。铁律:只在**预发**且显式提供 OC_E2E_PG_URL 时启用;缺省 → 相关
// 用例 skip-with-reason,绝不碰生产 DB,绝不无凭据猜连。
//
// 用 psql CLI(本机已装)执行,避免给 e2e 引入 pg 驱动依赖。

import { execFileSync } from 'node:child_process';
import { config } from './env';

export interface Section9Capability {
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
 * §9 部署能力探测:需 OC_E2E_PG_URL + 迁移 0170 表存在(turn_dispatches / tape_chat_projection)。
 * 任一缺失 → available:false + 明确 reason(供 test.skip 打印)。
 */
export function probeSection9(): Section9Capability {
  const cfg = config();
  if (!cfg.pgUrl) {
    return { available: false, reason: '未提供 OC_E2E_PG_URL:无 DB 注入通道,§9 依赖用例跳过(预发部署 0170 后注入连接串即启用)' };
  }
  try {
    const out = psql(
      "SELECT to_regclass('public.turn_dispatches') IS NOT NULL AND to_regclass('public.tape_chat_projection') IS NOT NULL",
      { tuplesOnly: true },
    ).trim();
    if (out === 't') return { available: true, reason: '§9 表就绪(迁移 0170 已 apply)' };
    return { available: false, reason: '§9 迁移 0170 未 apply(turn_dispatches / tape_chat_projection 缺失):投影/durable-turn 未部署,跳过' };
  } catch (err) {
    return { available: false, reason: `§9 探测失败(psql 连接/权限):${(err as Error).message.slice(0, 160)}` };
  }
}

/** 执行任意 SQL(种子/注入用)。仅在 probeSection9().available 为真且显式允许时调用。 */
export function runSql(sql: string): string {
  return psql(sql);
}

export function queryScalar(sql: string): string {
  return psql(sql, { tuplesOnly: true }).trim();
}
