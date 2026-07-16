-- Read-only live report for V5 skill retrieval shadow telemetry.
--
-- Usage:
--   psql "$DATABASE_URL" -f scripts/v5-skill-shadow-report.sql
--   psql "$DATABASE_URL" -v window_days=7 -f scripts/v5-skill-shadow-report.sql
--
-- Recall denominator = distinct successful skill_view gold skills on sampled
-- status=ok turns. Multiple skills in one turn are each counted, so this is true
-- set recall rather than an inflated "any hit in the turn" rate.
-- Activation gate requested by TASK.md: top-3 recall >= 90%.

\if :{?window_days}
\else
\set window_days 30
\endif

\echo '== collection health =='
SELECT
  count(*) AS sampled_rows,
  count(*) FILTER (WHERE status = 'ok') AS ranked_rows,
  count(*) FILTER (WHERE status = 'timeout') AS timeout_rows,
  count(*) FILTER (WHERE status = 'error') AS error_rows,
  count(*) FILTER (WHERE status = 'pending') AS usage_arrived_before_selection_rows,
  count(*) FILTER (WHERE cardinality(actual_skills) > 0) AS rows_with_actual_usage,
  round(100.0 * count(*) FILTER (WHERE status = 'timeout') / NULLIF(count(*), 0), 2)
    AS timeout_pct
FROM skill_retrieval_shadow_events
WHERE created_at >= NOW() - (:'window_days' || ' days')::interval;

\echo '== overall recall and 90% activation gate =='
WITH gold AS (
  SELECT id, routes, actual_skills
  FROM skill_retrieval_shadow_events
  WHERE created_at >= NOW() - (:'window_days' || ' days')::interval
    AND status = 'ok'
    AND cardinality(actual_skills) > 0
), route_turn AS (
  SELECT
    gold.id,
    route.key AS route,
    gold.actual_skills,
    ARRAY(
      SELECT ranked.name
      FROM jsonb_array_elements_text(route.value) WITH ORDINALITY AS ranked(name, ord)
      WHERE ranked.ord <= 3
      ORDER BY ranked.ord
    ) AS top3,
    ARRAY(
      SELECT ranked.name
      FROM jsonb_array_elements_text(route.value) WITH ORDINALITY AS ranked(name, ord)
      WHERE ranked.ord <= 5
      ORDER BY ranked.ord
    ) AS top5
  FROM gold
  CROSS JOIN LATERAL jsonb_each(gold.routes) AS route(key, value)
), scored AS (
  SELECT
    id,
    route,
    cardinality(actual_skills) AS gold_skills,
    (
      SELECT count(*)
      FROM unnest(actual_skills) AS actual(name)
      WHERE actual.name = ANY(top3)
    ) AS hits_at_3,
    (
      SELECT count(*)
      FROM unnest(actual_skills) AS actual(name)
      WHERE actual.name = ANY(top5)
    ) AS hits_at_5
  FROM route_turn
)
SELECT
  route,
  count(*) AS gold_turns,
  sum(gold_skills) AS gold_skills,
  round(sum(hits_at_3)::numeric / NULLIF(sum(gold_skills), 0), 4) AS recall_at_3,
  round(sum(hits_at_5)::numeric / NULLIF(sum(gold_skills), 0), 4) AS recall_at_5,
  sum(hits_at_3)::numeric / NULLIF(sum(gold_skills), 0) >= 0.90
    AS meets_top3_recall_gate
FROM scored
GROUP BY route
ORDER BY route;

\echo '== recall by main / coding / office / research bucket =='
WITH gold AS (
  SELECT
    id,
    routes,
    actual_skills,
    CASE
      WHEN agent_id = 'main' THEN 'main'
      WHEN agent_id IN ('codex', 'coder', 'coding-assistant') OR agent_id LIKE 'coding-%'
        THEN 'coding'
      WHEN agent_id IN ('office', 'office-assistant') OR agent_id LIKE 'office-%'
        THEN 'office'
      WHEN agent_id IN ('research', 'researcher', 'research-assistant', 'scientist')
        OR agent_id LIKE 'research-%' THEN 'research'
      ELSE 'other'
    END AS agent_bucket
  FROM skill_retrieval_shadow_events
  WHERE created_at >= NOW() - (:'window_days' || ' days')::interval
    AND status = 'ok'
    AND cardinality(actual_skills) > 0
), route_turn AS (
  SELECT
    gold.id,
    gold.agent_bucket,
    route.key AS route,
    gold.actual_skills,
    ARRAY(
      SELECT ranked.name
      FROM jsonb_array_elements_text(route.value) WITH ORDINALITY AS ranked(name, ord)
      WHERE ranked.ord <= 3
    ) AS top3,
    ARRAY(
      SELECT ranked.name
      FROM jsonb_array_elements_text(route.value) WITH ORDINALITY AS ranked(name, ord)
      WHERE ranked.ord <= 5
    ) AS top5
  FROM gold
  CROSS JOIN LATERAL jsonb_each(gold.routes) AS route(key, value)
), scored AS (
  SELECT
    id,
    agent_bucket,
    route,
    cardinality(actual_skills) AS gold_skills,
    (
      SELECT count(*)
      FROM unnest(actual_skills) AS actual(name)
      WHERE actual.name = ANY(top3)
    ) AS hits_at_3,
    (
      SELECT count(*)
      FROM unnest(actual_skills) AS actual(name)
      WHERE actual.name = ANY(top5)
    ) AS hits_at_5
  FROM route_turn
)
SELECT
  agent_bucket,
  route,
  count(*) AS gold_turns,
  sum(gold_skills) AS gold_skills,
  round(sum(hits_at_3)::numeric / NULLIF(sum(gold_skills), 0), 4) AS recall_at_3,
  round(sum(hits_at_5)::numeric / NULLIF(sum(gold_skills), 0), 4) AS recall_at_5
FROM scored
GROUP BY agent_bucket, route
ORDER BY agent_bucket, route;

\echo '== pairwise top-5 overlap (Jaccard) =='
WITH ranked AS (
  SELECT
    event.id,
    route.key AS route,
    ARRAY(
      SELECT DISTINCT ranked.name
      FROM jsonb_array_elements_text(route.value) WITH ORDINALITY AS ranked(name, ord)
      WHERE ranked.ord <= 5
    ) AS names
  FROM skill_retrieval_shadow_events AS event
  CROSS JOIN LATERAL jsonb_each(event.routes) AS route(key, value)
  WHERE event.created_at >= NOW() - (:'window_days' || ' days')::interval
    AND event.status = 'ok'
), pairs AS (
  SELECT a.id, a.route AS route_a, b.route AS route_b, a.names AS names_a, b.names AS names_b
  FROM ranked AS a
  JOIN ranked AS b ON b.id = a.id AND b.route > a.route
), scored AS (
  SELECT
    id,
    route_a,
    route_b,
    (
      SELECT count(*)::double precision
      FROM (SELECT unnest(names_a) INTERSECT SELECT unnest(names_b)) AS intersection_names
    ) / NULLIF((
      SELECT count(*)::double precision
      FROM (SELECT unnest(names_a) UNION SELECT unnest(names_b)) AS union_names
    ), 0) AS jaccard
  FROM pairs
)
SELECT route_a, route_b, count(*) AS turns, round(avg(jaccard)::numeric, 4) AS mean_jaccard_top5
FROM scored
GROUP BY route_a, route_b
ORDER BY route_a, route_b;
