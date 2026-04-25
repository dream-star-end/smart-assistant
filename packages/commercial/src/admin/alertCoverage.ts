/**
 * Plan v10 P3 — 告警事件覆盖矩阵。
 *
 * 给 admin alerts tab 顶部那个"事件覆盖矩阵"提供数据:每个 EVENT_META 行
 * 配上"几条 channel 订阅 / 几条 channel 真能投递 / 最近一次入队时间"。
 *
 * 跟 admin/alertChannels.ts 的纯 channel 列表区分:那个是 channel 视角,
 * 这里是 event 视角(EVENT_META 是真理源,channel.event_types 来订阅)。
 *
 * 数据流:
 *   1. EVENT_META  —— 内存常量
 *   2. admin_alert_channels WHERE enabled=true —— 一次 SELECT
 *   3. admin_alert_outbox 30d DISTINCT ON event_type —— 走 idx_aao_event_time
 *   4. JS 端 join,O(EVENT_META.length × channels.length),都是常量小集合
 *
 * 不查 DB 缓存:admin tab 调用频次很低(人工开页),per-call ~2 query 可接受。
 */

import { query } from "../db/queries.js";
import { EVENT_META, type EventMeta, type Severity } from "./alertEvents.js";

/**
 * Severity 排序。channel.severity_min 是"门槛":事件 severity ≥ 门槛才会发。
 * 比如 channel 设 severity_min=warning,info 事件被拦,warning/critical 通过。
 */
const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export interface EventCoverageRow {
  event_type: string;
  group: EventMeta["group"];
  severity: Severity;
  description: string;
  trigger: EventMeta["trigger"];
  /** 订阅了该事件类型的启用 channel 数(不分 severity) */
  subscriber_count: number;
  /** 在 subscriber 中,severity 达标 + (iLink 已激活 | 其他类型直通)→ 真能投递的 channel 数 */
  deliverable_count: number;
  /** 该事件最近 30d 入队 outbox 的时间;从未入过 = null */
  last_fired_at: string | null;
  /** 该事件最近 30d 入队的 severity(可能与默认 severity 不同) */
  last_severity: Severity | null;
}

interface ChannelLite {
  channel_type: string;
  severity_min: Severity;
  /**
   * jsonb 里存的 string[]。schema = `event_types jsonb NOT NULL DEFAULT '[]'`,
   * 业务约定:**空 array = 订阅全部**。
   *
   * 非 array(脏数据)在 ChannelLite 里**不出现** —— 见 getEventCoverage()
   * 里的过滤,被丢弃不参与 join。原因:`[]` 已被业务占用为"全订阅"语义,
   * 把非 array 也兜底成 `[]` 会让一条脏 channel 静默统计成"订阅全部 20 个
   * 事件",直接掩盖"没人收"的告警目标(Codex review #1 阻断点)。
   */
  event_types: string[];
  activation_status: string;
}

/**
 * 计算事件覆盖矩阵。返回 EVENT_META 顺序的行(按 group 在前端再分块)。
 *
 * 设计选择 — DISTINCT ON vs MAX():
 *   想拿"最近一次"的 (created_at, severity) 元组,DISTINCT ON 一次 scan 命中
 *   idx_aao_event_time(event_type, created_at DESC) 拿首行;MAX(created_at)
 *   拿不到对应 severity,要回扫第二次或者改 LATERAL,反而更慢。
 *
 * 30 天窗口:超过 30d 没触发的事件视为"从未触发"展示给 admin 已足够,
 * 同时让 outbox 扫描有边界(outbox 现在不分区,但保留态度)。
 */
export async function getEventCoverage(): Promise<EventCoverageRow[]> {
  // 1. 拉启用 channel
  const ch = await query<{
    channel_type: string;
    severity_min: Severity;
    event_types: unknown;
    activation_status: string;
  }>(
    `SELECT channel_type, severity_min, event_types, activation_status
       FROM admin_alert_channels
      WHERE enabled = TRUE`,
  );
  // 过滤掉 event_types 不是 array 的脏行 —— 这些行 schema 违规(列是
  // `jsonb NOT NULL DEFAULT '[]'`,理论上不可能),但即便出现,也不能
  // 兜底成 `[]`(那等于"订阅全部"),会让 admin 看到虚高 subscriber_count
  // 而错过"没人收"的告警目标。直接丢弃,等价于"未配置事件 → 不参与 join"。
  const channels: ChannelLite[] = [];
  for (const r of ch.rows) {
    if (!Array.isArray(r.event_types)) continue;
    channels.push({
      channel_type: r.channel_type,
      severity_min: r.severity_min,
      event_types: r.event_types as string[],
      activation_status: r.activation_status,
    });
  }

  // 2. 拉 30d 内每个 event_type 最近一次 outbox 行
  const ob = await query<{
    event_type: string;
    last_fired_at: Date;
    last_severity: Severity;
  }>(
    `SELECT DISTINCT ON (event_type)
            event_type,
            created_at AS last_fired_at,
            severity   AS last_severity
       FROM admin_alert_outbox
      WHERE created_at > NOW() - INTERVAL '30 days'
      ORDER BY event_type, created_at DESC`,
  );
  const lastFired = new Map<string, { at: Date; severity: Severity }>();
  for (const r of ob.rows) {
    lastFired.set(r.event_type, { at: r.last_fired_at, severity: r.last_severity });
  }

  // 3. 遍历 EVENT_META,JS 端 join
  return EVENT_META.map((evt) => {
    let subscriber_count = 0;
    let deliverable_count = 0;
    for (const c of channels) {
      // event_types 空 array = 订阅全部(业务约定,前端 UI 也是这么提示的)
      const subscribed = c.event_types.length === 0 || c.event_types.includes(evt.event_type);
      if (!subscribed) continue;
      subscriber_count++;
      const sevOk = SEVERITY_RANK[evt.severity] >= SEVERITY_RANK[c.severity_min];
      // iLink 必须 activation_status=active 才能投递;telegram / 其他类型直通
      // (telegram channel_type 在 0034 加,无 activation 字段语义)
      const activeOk =
        c.channel_type === "ilink_wechat" ? c.activation_status === "active" : true;
      if (sevOk && activeOk) deliverable_count++;
    }
    const lf = lastFired.get(evt.event_type);
    return {
      event_type: evt.event_type,
      group: evt.group,
      severity: evt.severity,
      description: evt.description,
      trigger: evt.trigger,
      subscriber_count,
      deliverable_count,
      last_fired_at: lf ? lf.at.toISOString() : null,
      last_severity: lf ? lf.severity : null,
    };
  });
}
