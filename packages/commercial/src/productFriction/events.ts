import { createHash } from "node:crypto";
import type { QueryRunner } from "../db/queries.js";
import { query } from "../db/queries.js";

export type FrictionOutcome =
  | "pending"
  | "failed"
  | "recovered"
  | "succeeded"
  | "abandoned"
  | "cancelled";

export interface ProductFrictionEvent {
  /** Server-owned request/turn/session correlation input. Never persisted. */
  correlation: string;
  userId?: bigint | null;
  surface: string;
  stage: string;
  code: string;
  outcome: FrictionOutcome;
  attempts?: number;
  latencyMs?: number | null;
  model?: string | null;
  provider?: string | null;
  clientBuild?: string | null;
  browserFamily?: string | null;
  deviceClass?: "desktop" | "mobile" | "tablet" | "unknown" | null;
  traceId?: string | null;
  sessionId?: string | null;
  /** Stable product entity identity (for example marketplace skill slug). */
  entitySlug?: string | null;
  /**
   * Bounded JS error location identifiers (0248). Never raw message/stack:
   * error class name + bundle basename + line/col + fingerprint derived from
   * those bounded fields. Resolvable to source via client_build sourcemaps.
   */
  errorName?: string | null;
  scriptRef?: string | null;
  lineNo?: number | null;
  colNo?: number | null;
  errorFingerprint?: string | null;
  /** Bounded card tone (0278). Invalid values are stored as NULL. */
  presentation?: "red" | "yellow" | "soft" | "banner" | "placeholder" | null;
  /** Bounded snake token (0278 CHECK `^[a-z0-9_]{1,32}$`). Invalid → NULL. */
  path?: string | null;
  /** Bounded snake token (0278 CHECK `^[a-z0-9_]{1,48}$`). Invalid → NULL. */
  reason?: string | null;
}

function clampText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.slice(0, max);
}

const PRESENTATIONS = new Set(["red", "yellow", "soft", "banner", "placeholder"]);
/** Must match 0278 CHECK and clientErrors whitelist character-for-character. */
const FRICTION_PATH_RE = /^[a-z0-9_]{1,32}$/;
const FRICTION_REASON_RE = /^[a-z0-9_]{1,48}$/;

function sanitizePresentation(
  value: ProductFrictionEvent["presentation"],
): ProductFrictionEvent["presentation"] {
  return value && PRESENTATIONS.has(value) ? value : null;
}

function sanitizePath(value: string | null | undefined): string | null {
  const clamped = clampText(value, 32);
  return clamped && FRICTION_PATH_RE.test(clamped) ? clamped : null;
}

function sanitizeReason(value: string | null | undefined): string | null {
  const clamped = clampText(value, 48);
  return clamped && FRICTION_REASON_RE.test(clamped) ? clamped : null;
}

/**
 * Same predicate as the outcome CASE that actually adopts EXCLUDED.outcome.
 * presentation/path/reason only latest-non-null-win when this is true, so a
 * late failed(decision_timeout) cannot rewrite a recovered/cancelled row.
 */
const ADOPT_EXCLUDED_OUTCOME_SQL = `(product_friction_events.outcome NOT IN ('recovered','succeeded','abandoned','cancelled') AND (product_friction_events.outcome='pending' OR (product_friction_events.outcome='failed' AND EXCLUDED.outcome IN ('recovered','succeeded','abandoned','cancelled'))))`;

export function productFrictionEventKey(input: Pick<ProductFrictionEvent, "correlation" | "surface" | "stage">): string {
  return createHash("sha256")
    .update("oc-product-friction-v1\0")
    .update(input.surface)
    .update("\0")
    .update(input.stage)
    .update("\0")
    .update(input.correlation)
    .digest("hex");
}

/**
 * Atomic monotonic upsert. pending may become failed/terminal and failed may
 * recover; terminal outcomes can never be overwritten by late/replayed events.
 */
export async function recordProductFrictionEvent(
  input: ProductFrictionEvent,
  runner?: QueryRunner,
): Promise<void> {
  const attempts = Math.max(1, Math.min(32, Math.trunc(input.attempts ?? 1)));
  const latency = input.latencyMs == null
    ? null
    : Math.max(0, Math.min(86_400_000, Math.trunc(input.latencyMs)));
  const clampLine = (value: number | null | undefined): number | null =>
    value == null ? null : Math.max(0, Math.min(10_000_000, Math.trunc(value)));
  await query(
    `INSERT INTO product_friction_events
       (event_key, user_id, surface, stage, code, outcome, attempts, latency_ms,
        model, provider, client_build, browser_family, device_class, trace_id,
        session_id, entity_slug, error_name, script_ref, line_no, col_no,
        error_fingerprint, presentation, path, reason, recovered_at)
     VALUES ($1,$2,$3,$4,$5,$6::varchar,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             $17,$18,$19,$20,$21,$22,$23,$24,
             CASE WHEN $6::varchar IN ('recovered','succeeded') THEN NOW() ELSE NULL END)
     ON CONFLICT (event_key) DO UPDATE SET
       outcome = CASE
         WHEN product_friction_events.outcome IN ('recovered','succeeded','abandoned','cancelled')
           THEN product_friction_events.outcome
         WHEN product_friction_events.outcome = 'failed'
              AND EXCLUDED.outcome IN ('recovered','succeeded','abandoned','cancelled')
           THEN EXCLUDED.outcome
         WHEN product_friction_events.outcome = 'pending'
           THEN EXCLUDED.outcome
         ELSE product_friction_events.outcome
       END,
       attempts = GREATEST(product_friction_events.attempts, EXCLUDED.attempts),
       user_id = COALESCE(product_friction_events.user_id, EXCLUDED.user_id),
       latency_ms = COALESCE(EXCLUDED.latency_ms, product_friction_events.latency_ms),
       model = COALESCE(product_friction_events.model, EXCLUDED.model),
       provider = COALESCE(product_friction_events.provider, EXCLUDED.provider),
       client_build = COALESCE(product_friction_events.client_build, EXCLUDED.client_build),
       browser_family = COALESCE(product_friction_events.browser_family, EXCLUDED.browser_family),
       device_class = COALESCE(product_friction_events.device_class, EXCLUDED.device_class),
       trace_id = COALESCE(product_friction_events.trace_id, EXCLUDED.trace_id),
       session_id = COALESCE(product_friction_events.session_id, EXCLUDED.session_id),
       entity_slug = COALESCE(product_friction_events.entity_slug, EXCLUDED.entity_slug),
       error_name = COALESCE(product_friction_events.error_name, EXCLUDED.error_name),
       script_ref = COALESCE(product_friction_events.script_ref, EXCLUDED.script_ref),
       line_no = COALESCE(product_friction_events.line_no, EXCLUDED.line_no),
       col_no = COALESCE(product_friction_events.col_no, EXCLUDED.col_no),
       error_fingerprint = COALESCE(product_friction_events.error_fingerprint, EXCLUDED.error_fingerprint),
       presentation = CASE WHEN ${ADOPT_EXCLUDED_OUTCOME_SQL} THEN COALESCE(EXCLUDED.presentation, product_friction_events.presentation) ELSE product_friction_events.presentation END,
       path = CASE WHEN ${ADOPT_EXCLUDED_OUTCOME_SQL} THEN COALESCE(EXCLUDED.path, product_friction_events.path) ELSE product_friction_events.path END,
       reason = CASE WHEN ${ADOPT_EXCLUDED_OUTCOME_SQL} THEN COALESCE(EXCLUDED.reason, product_friction_events.reason) ELSE product_friction_events.reason END,
       recovered_at = CASE
         WHEN product_friction_events.outcome IN ('recovered','succeeded','abandoned','cancelled')
           THEN product_friction_events.recovered_at
         WHEN EXCLUDED.outcome IN ('recovered','succeeded') THEN NOW()
         ELSE product_friction_events.recovered_at
       END,
       updated_at = NOW()`,
    [
      productFrictionEventKey(input),
      input.userId == null ? null : input.userId.toString(),
      input.surface,
      input.stage,
      input.code,
      input.outcome,
      attempts,
      latency,
      clampText(input.model, 128),
      clampText(input.provider, 32),
      clampText(input.clientBuild, 64),
      clampText(input.browserFamily, 24),
      input.deviceClass ?? null,
      clampText(input.traceId, 96),
      clampText(input.sessionId, 96),
      clampText(input.entitySlug, 128),
      clampText(input.errorName, 64),
      clampText(input.scriptRef, 120),
      clampLine(input.lineNo),
      clampLine(input.colNo),
      clampText(input.errorFingerprint, 16),
      sanitizePresentation(input.presentation),
      sanitizePath(input.path),
      sanitizeReason(input.reason),
    ],
    runner,
  );
}

/** Transition an already-recorded journey without creating success noise.
 * Used by durable recovery paths that may run for every healthy turn but only
 * need to close a prior failure when one exists. */
export async function transitionProductFrictionEventIfPresent(input: {
  correlation: string;
  surface: string;
  stage: string;
  outcome: "failed" | "recovered" | "abandoned" | "cancelled";
  attemptIncrement?: number;
}, runner?: QueryRunner): Promise<boolean> {
  const increment = Math.max(1, Math.min(32, Math.trunc(input.attemptIncrement ?? 1)));
  const result = await query(
    `UPDATE product_friction_events
        SET outcome = $2::varchar,
            attempts=LEAST(32,attempts+$3),
            recovered_at=CASE
              WHEN $2::varchar='recovered' THEN NOW()
              ELSE recovered_at
            END,
            updated_at=NOW()
      WHERE event_key=$1
        AND outcome NOT IN ('recovered','succeeded','abandoned','cancelled')`,
    [productFrictionEventKey(input), input.outcome, increment],
    runner,
  );
  return (result.rowCount ?? 0) > 0;
}
