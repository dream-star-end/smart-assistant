import { controlPlaneIdentity } from "../admin/observabilityIdentity.js";
import { query } from "../db/queries.js";

const WINDOW_DAYS = 30;
const MIN_COMPLETED = 20;
const MIN_LINK_RATE = 0.95;
const MIN_VERSION_RATE = 0.9;
const MIN_FIRST_VISIBLE_RATE = 0.8;
const MIN_NUDGE_EXPOSURES = 10;
const MIN_EXPLICIT_RATINGS = 3;
const MIN_SKILL_SHADOW_EVENTS = 5;

export type TelemetryReadiness = {
  ready: boolean;
  blockers: string[];
  metrics: Record<string, number | null>;
};

function rate(value: number, total: number): number | null {
  return total > 0 ? value / total : null;
}

export async function evaluateTelemetryReadiness(
  userId: bigint | number | string,
): Promise<TelemetryReadiness> {
  const result = await query<{
    completed: string;
    linked: string;
    control_versioned: string;
    runtime_versioned: string;
    bundle_versioned: string;
    client_versioned: string;
    first_visible: string;
    nudge_exposures: string;
    explicit_ratings: string;
    tool_reports_6h: string;
    skill_shadow_7d: string;
    metric_fresh_seconds: string | null;
  }>(
    `WITH completed AS (
       SELECT d.dispatch_id
         FROM turn_dispatches d
        WHERE d.user_id=$1::bigint AND d.outcome='completed'
          AND d.terminal_at >= NOW() - ($2::text || ' days')::interval
     ), trace_stats AS (
       SELECT COUNT(DISTINCT c.dispatch_id)::text AS completed,
              COUNT(DISTINCT t.dispatch_id)::text AS linked,
              COUNT(DISTINCT c.dispatch_id) FILTER (
                WHERE t.control_plane_release IS NOT NULL AND t.control_plane_commit IS NOT NULL
              )::text AS control_versioned,
              COUNT(DISTINCT c.dispatch_id) FILTER (
                WHERE t.runtime_source_commit IS NOT NULL AND t.runtime_boot_hash IS NOT NULL
              )::text AS runtime_versioned,
              COUNT(DISTINCT c.dispatch_id) FILTER (WHERE t.bundle_rev IS NOT NULL)::text AS bundle_versioned,
              COUNT(DISTINCT c.dispatch_id) FILTER (WHERE t.client_build IS NOT NULL)::text AS client_versioned,
              COUNT(DISTINCT c.dispatch_id) FILTER (WHERE t.first_visible_at IS NOT NULL)::text AS first_visible
         FROM completed c
         LEFT JOIN turn_traces t ON t.dispatch_id=c.dispatch_id
     )
     SELECT ts.*,
       (SELECT COUNT(*)::text FROM response_rating_nudges n
         WHERE n.user_id=$1::bigint AND n.exposed_at >= NOW()-($2::text||' days')::interval
       ) AS nudge_exposures,
       (SELECT COUNT(*)::text FROM response_rating r
         WHERE r.user_id=$1::bigint AND NOT ('implicit'=ANY(r.tags))
           AND r.created_at >= NOW()-($2::text||' days')::interval
       ) AS explicit_ratings,
       (SELECT COUNT(*)::text FROM agent_tool_rollup_reports ar
         WHERE ar.user_id=$1::bigint AND ar.created_at >= NOW()-INTERVAL '6 hours'
       ) AS tool_reports_6h,
       (SELECT COUNT(*)::text FROM skill_retrieval_shadow_events se
         WHERE se.user_id=$1::bigint AND se.created_at >= NOW()-INTERVAL '7 days'
       ) AS skill_shadow_7d,
       (SELECT EXTRACT(EPOCH FROM (NOW()-MAX(m.updated_at)))::text
          FROM telemetry_metric_rollups m
       ) AS metric_fresh_seconds
     FROM trace_stats ts`,
    [String(userId), String(WINDOW_DAYS)],
  );
  const row = result.rows[0];
  const completed = Number(row?.completed ?? 0);
  const linked = Number(row?.linked ?? 0);
  const controlVersioned = Number(row?.control_versioned ?? 0);
  const runtimeVersioned = Number(row?.runtime_versioned ?? 0);
  const bundleVersioned = Number(row?.bundle_versioned ?? 0);
  const clientVersioned = Number(row?.client_versioned ?? 0);
  const firstVisible = Number(row?.first_visible ?? 0);
  const nudgeExposures = Number(row?.nudge_exposures ?? 0);
  const explicitRatings = Number(row?.explicit_ratings ?? 0);
  const toolReports = Number(row?.tool_reports_6h ?? 0);
  const skillShadow = Number(row?.skill_shadow_7d ?? 0);
  const metricFreshSeconds = row?.metric_fresh_seconds === null
    ? null : Number(row?.metric_fresh_seconds);
  const metrics = {
    completed,
    trace_dispatch_rate: rate(linked, completed),
    control_version_rate: rate(controlVersioned, completed),
    runtime_version_rate: rate(runtimeVersioned, completed),
    bundle_version_rate: rate(bundleVersioned, completed),
    client_version_rate: rate(clientVersioned, completed),
    first_visible_rate: rate(firstVisible, completed),
    nudge_exposures: nudgeExposures,
    explicit_ratings: explicitRatings,
    tool_reports_6h: toolReports,
    skill_shadow_7d: skillShadow,
    metric_fresh_seconds: Number.isFinite(metricFreshSeconds) ? metricFreshSeconds : null,
  };
  const blockers: string[] = [];
  if (completed < MIN_COMPLETED) blockers.push("completed_sample");
  if ((metrics.trace_dispatch_rate ?? 0) < MIN_LINK_RATE) blockers.push("trace_dispatch_coverage");
  if ((metrics.control_version_rate ?? 0) < MIN_VERSION_RATE) blockers.push("control_version_coverage");
  if ((metrics.runtime_version_rate ?? 0) < MIN_VERSION_RATE) blockers.push("runtime_version_coverage");
  if ((metrics.bundle_version_rate ?? 0) < MIN_VERSION_RATE) blockers.push("bundle_version_coverage");
  if ((metrics.client_version_rate ?? 0) < MIN_VERSION_RATE) blockers.push("client_version_coverage");
  if ((metrics.first_visible_rate ?? 0) < MIN_FIRST_VISIBLE_RATE) blockers.push("first_visible_coverage");
  if (nudgeExposures < MIN_NUDGE_EXPOSURES) blockers.push("rating_exposure_sample");
  if (explicitRatings < MIN_EXPLICIT_RATINGS) blockers.push("explicit_rating_sample");
  if (toolReports < 1) blockers.push("tool_report_freshness");
  if (skillShadow < MIN_SKILL_SHADOW_EVENTS) blockers.push("skill_shadow_sample");
  if (metricFreshSeconds === null || !Number.isFinite(metricFreshSeconds) || metricFreshSeconds > 15 * 60) {
    blockers.push("metric_rollup_freshness");
  }
  const ready = blockers.length === 0;
  const version = controlPlaneIdentity();
  await query(
    `INSERT INTO telemetry_readiness_evidence
       (user_id,window_started_at,window_ended_at,ready,metrics,blockers,control_plane_release)
     VALUES ($1::bigint,NOW()-($2::text||' days')::interval,NOW(),$3,$4::jsonb,$5::text[],$6)`,
    [String(userId), String(WINDOW_DAYS), ready, JSON.stringify(metrics), blockers, version.release],
  );
  return { ready, blockers, metrics };
}
