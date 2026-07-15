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
}

function clampText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.slice(0, max);
}

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
  await query(
    `INSERT INTO product_friction_events
       (event_key, user_id, surface, stage, code, outcome, attempts, latency_ms,
        model, provider, client_build, browser_family, device_class, trace_id,
        session_id, recovered_at)
     VALUES ($1,$2,$3,$4,$5,$6::varchar,$7,$8,$9,$10,$11,$12,$13,$14,$15,
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
