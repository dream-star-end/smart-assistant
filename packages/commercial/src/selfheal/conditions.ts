/**
 * v5 自愈体系(RFC-v5-selfheal-ops)切片① — 检测状态单写权威 adapter。
 *
 * 所有检测器(alertRules / providerHealth / shell v5-monitor.sh / 被动事件)统一经
 * **一个** PG function `write_alert_condition(...)` 写 `admin_alert_rule_state`
 * (=alert_conditions 语义;0133 additive 泛化,物理表名/主键不变)。TS 侧唯一入口
 * 就是本 `writeCondition`;shell 侧 `psql -c "SELECT write_alert_condition(...)"`。
 * 消除 TS/shell 双实现(优于历史 v5-alert-fanout.sql 双源同改的债)。
 *
 * incident 是 condition 的**只读派生投影**(reconciler 单向),绝不反向写 condition。
 *
 * 语义(function 内实现,见 0133):
 *   同 phase           → 刷新 snapshot/observed_at + observation_seq++;不清 ack、不动 last_transition_at
 *   同 phase 且 level 变 → 额外 condition_rev++(触发 incident update)
 *   firing 真翻转      → 更新 firing + last_transition_at=NOW + 清 ack + condition_rev++
 *   latched            → occurrence_count += delta,last_seen_at=NOW
 */

import type { PoolClient } from "pg";
import { query } from "../db/queries.js";

export type ConditionMode = "probe" | "latched" | "spike";
export type ConditionLevel = "info" | "warning" | "critical";

const VALID_LEVELS: ReadonlySet<string> = new Set(["info", "warning", "critical"]);

/** 把任意入参归一化到合法 level;非法/缺省 → 'warning'(与 PG function COALESCE 默认一致)。 */
export function coerceConditionLevel(v: unknown): ConditionLevel {
  return typeof v === "string" && VALID_LEVELS.has(v) ? (v as ConditionLevel) : "warning";
}

export interface WriteConditionInput {
  mode: ConditionMode;
  firing: boolean;
  /** 缺省 → 'warning'(function 内 COALESCE)。 */
  level?: ConditionLevel | null;
  /** 检测快照(结构化,进 incident materialize + admin 视图)。缺省 → 保持旧 snapshot。 */
  snapshot?: Record<string, unknown> | null;
  /** 观测时刻;缺省 → NOW()。freshness fence(verify)读它。 */
  observedAt?: Date | null;
  /** dedupe_key;缺省保持旧值。 */
  dedupeKey?: string | null;
  /** latched 累积增量(occurrence)。 */
  occurrenceDelta?: number;
}

export interface WriteConditionResult {
  /** 写入前的 firing(NOT FOUND 视为 false)。 */
  previousFiring: boolean;
  /** firing 是否真翻转(消费方据此决定 enqueue 告警 / 投影 incident)。 */
  transitioned: boolean;
  /** 写入后的 condition_rev(phase|level 语义变化才 ++)。 */
  conditionRev: number;
}

interface WriteConditionRow {
  previous_firing: boolean;
  transitioned: boolean;
  out_condition_rev: string | number;
}

/**
 * 单写权威:调 PG function 原子 upsert condition,返回翻转/rev 信息。
 * 传 `client` 则在其事务内执行(与调用方业务写同一 tx);否则走 pool autocommit。
 */
export async function writeCondition(
  conditionKey: string,
  input: WriteConditionInput,
  client?: PoolClient,
): Promise<WriteConditionResult> {
  const sql = `SELECT previous_firing, transitioned, out_condition_rev
                 FROM write_alert_condition($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`;
  const params = [
    conditionKey,
    input.mode,
    input.firing,
    coerceConditionLevel(input.level),
    JSON.stringify(input.snapshot ?? {}),
    input.observedAt ?? null,
    input.dedupeKey ?? null,
    Number.isFinite(input.occurrenceDelta) ? Math.trunc(input.occurrenceDelta as number) : 0,
  ];
  const r = client
    ? await client.query<WriteConditionRow>(sql, params)
    : await query<WriteConditionRow>(sql, params);
  const row = r.rows[0];
  return {
    previousFiring: Boolean(row?.previous_firing),
    transitioned: Boolean(row?.transitioned),
    conditionRev: Number(row?.out_condition_rev ?? 0),
  };
}
