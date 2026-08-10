import type { IncomingMessage, ServerResponse } from 'node:http'

import { listRuleStates } from '../../admin/alertOutbox.js'
import { requireAdmin } from '../../admin/requireAdmin.js'
import { query } from '../../db/queries.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { sendJson } from '../util.js'

type SloRow = {
  window_key: 'last_15m' | 'last_1h' | 'last_24h'
  success: number
  failure: number
  affected_users: number
  p50: string | null
  p95: string | null
}

export async function handleAdminOpsOverview(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret)
  const [slo, rules, incidents] = await Promise.all([
    query<SloRow>(
      `WITH windows(window_key,span_ms) AS (
         VALUES ('last_15m',900000::bigint),
                ('last_1h',3600000::bigint),
                ('last_24h',86400000::bigint)
       )
       SELECT w.window_key,
              COUNT(*) FILTER (WHERE t.status='completed')::int AS success,
              COUNT(*) FILTER (WHERE t.status='crashed')::int AS failure,
              COUNT(DISTINCT t.user_id) FILTER (WHERE t.status='crashed')::int AS affected_users,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY (t.finalized_at-t.created_at)
              ) FILTER (WHERE t.status='completed' AND t.finalized_at IS NOT NULL)::text AS p50,
              percentile_cont(0.95) WITHIN GROUP (
                ORDER BY (t.finalized_at-t.created_at)
              ) FILTER (WHERE t.status='completed' AND t.finalized_at IS NOT NULL)::text AS p95
         FROM windows w
         LEFT JOIN client_session_turn_tapes t
           ON t.created_at >= (EXTRACT(EPOCH FROM NOW())*1000)::bigint-w.span_ms
         LEFT JOIN users u ON t.user_id='c:'||u.id::text
          AND u.signal_traffic_class='production_user'
        WHERE t.user_id IS NULL OR u.id IS NOT NULL
        GROUP BY w.window_key,w.span_ms ORDER BY w.span_ms`,
    ),
    listRuleStates(),
    query<{
      id: string; condition_key: string; status: string; severity: string;
      opened_at: Date; updated_at: Date;
    }>(
      `SELECT id::text,condition_key,status,severity,opened_at,updated_at
         FROM incidents WHERE status<>'resolved' ORDER BY severity DESC,opened_at ASC LIMIT 200`,
    ),
  ])
  const windows = Object.fromEntries(slo.rows.map((row) => [row.window_key, {
    success: row.success,
    failure: row.failure,
    affected_users: row.affected_users,
    latency_ms: { p50: row.p50 === null ? null : Number(row.p50), p95: row.p95 === null ? null : Number(row.p95) },
  }]))
  sendJson(res, 200, {
    generated_at: new Date().toISOString(),
    slo: { source: 'durable', windows },
    current_actions: {
      firing_alerts: rules.filter((row) => row.classification === 'firing'),
      stale_alerts: rules.filter((row) => row.stale),
      recovered_alerts: rules.filter((row) => row.classification === 'recovered'),
      open_incidents: incidents.rows.map((row) => ({
        ...row,
        opened_at: row.opened_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
      })),
    },
  })
}
