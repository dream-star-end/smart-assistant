/**
 * Shared release-intake helpers (batch1b §3.1 / §11).
 *
 * A Tier2 release job can be enqueued from three origins, all of which freeze
 * their deploy plan from the SAME local durable authority — the committed
 * `${repairId}:cutover` broker action (never a caller-supplied payload):
 *
 *   - `v5`         — the HMAC-verified v5 admin one-click release webhook. The
 *                    receiver additionally re-checks the webhook's
 *                    sha/deployPlanHash/manifestHash against the local record and
 *                    refuses (409 authority_mismatch) on any drift.
 *   - `auto`       — OC_SELFHEAL_AUTO_DEPLOY_TIER2=1: the broker enqueues the
 *                    just-classified cutover directly.
 *   - `breakglass` — the root break-glass route reads the committed record.
 *
 * The frozen values (sha / baseSha / deployPlanHash / manifestHash / full plan)
 * are the SINGLE source of truth for the worker + lane; nothing downstream ever
 * re-derives them from a mutable record. This module is pure w.r.t. HTTP — the
 * receiver / server adapt transport; the broker calls the enqueue directly.
 */

import { createHash } from 'node:crypto'
import {
  type InsertReleaseJobResult,
  type SelfhealReleaseJobOrigin,
  getBrokerAction,
  insertReleaseJobReceived,
} from '@openclaude/storage'

const SHA_RE = /^[0-9a-f]{40}$/

/** Frozen deploy plan extracted from the LOCAL durable cutover record. */
export interface FrozenCutoverPlan {
  sha: string
  baseSha: string | null
  deployPlanHash: string | null
  manifestHash: string | null
  /** Full cutover-record detail (the authoritative plan) as a JSON string — the
   *  job's `plan_json` (§7). */
  planJson: string
  /** Parsed detail for callers that need surfaces / classification. */
  detail: Record<string, unknown>
}

/**
 * Read the committed `${repairId}:cutover` broker action and extract the frozen
 * plan. Returns null when the record is absent / not committed / corrupt / lacks
 * a valid sha (fail-closed — every caller treats null as "no authoritative
 * cutover" and refuses to enqueue a release).
 */
export async function readCommittedCutoverPlan(
  repairId: string,
): Promise<FrozenCutoverPlan | null> {
  const rec = await getBrokerAction(`${repairId}:cutover`)
  if (!rec || rec.status !== 'committed' || !rec.response) return null
  let resp: { detail?: unknown }
  try {
    resp = JSON.parse(rec.response) as { detail?: unknown }
  } catch {
    return null
  }
  const detail = resp.detail
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
  const d = detail as Record<string, unknown>
  const sha = typeof d.sha === 'string' ? d.sha : ''
  if (!SHA_RE.test(sha)) return null
  const baseSha = typeof d.baseSha === 'string' && SHA_RE.test(d.baseSha) ? d.baseSha : null
  const deployPlanHash = typeof d.deployPlanHash === 'string' ? d.deployPlanHash : null
  const manifestHash = typeof d.manifestHash === 'string' ? d.manifestHash : null
  return { sha, baseSha, deployPlanHash, manifestHash, planJson: JSON.stringify(d), detail: d }
}

/** Deterministic payload hash over the FROZEN plan fields — a re-delivery of the
 *  same release_request_id with the same frozen plan is a durable duplicate.
 *  Binds the repair IDENTITY (repairId + incidentId) into the hash (§F11 rrid↔
 *  repair binding) so a rrid can never be re-used to smuggle a different repair's
 *  plan past the durable duplicate/conflict gate. */
export function releasePayloadHash(fields: {
  repairId: string
  incidentId: string
  sha: string
  baseSha: string | null
  deployPlanHash: string | null
  manifestHash: string | null
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        fields.repairId,
        fields.incidentId,
        fields.sha,
        fields.baseSha ?? '',
        fields.deployPlanHash ?? '',
        fields.manifestHash ?? '',
      ]),
    )
    .digest('hex')
}

/** Durably record a release job from a frozen plan (idempotent on rrid). */
export async function enqueueReleaseJob(input: {
  repairId: string
  incidentId: string
  releaseRequestId: string
  origin: SelfhealReleaseJobOrigin
  plan: FrozenCutoverPlan
}): Promise<InsertReleaseJobResult> {
  return insertReleaseJobReceived({
    releaseRequestId: input.releaseRequestId,
    repairId: input.repairId,
    incidentId: input.incidentId,
    payloadHash: releasePayloadHash({
      repairId: input.repairId,
      incidentId: input.incidentId,
      sha: input.plan.sha,
      baseSha: input.plan.baseSha,
      deployPlanHash: input.plan.deployPlanHash,
      manifestHash: input.plan.manifestHash,
    }),
    approvedSha: input.plan.sha,
    baseSha: input.plan.baseSha,
    deployPlanHash: input.plan.deployPlanHash,
    manifestHash: input.plan.manifestHash,
    planJson: input.plan.planJson,
    origin: input.origin,
  })
}

/** True when a frozen plan is not machine-deployable (any manual path, or no
 *  surface at all) — the worker terminalizes such a job `manual_required` (§11
 *  note) instead of ever running a lane with an empty/unsafe argv. Single
 *  adjudicator across all three origins. `planDetail` is the parsed plan_json
 *  (the frozen cutover-record detail). */
export function planIsManual(
  planDetail: Record<string, unknown>,
): { manual: boolean; reasons: string[] } {
  const cls = planDetail.classification
  if (!cls || typeof cls !== 'object' || Array.isArray(cls)) {
    return { manual: true, reasons: ['missing_classification'] }
  }
  const c = cls as Record<string, unknown>
  const manual = Array.isArray(c.manual) ? (c.manual as unknown[]) : []
  const surfaces = Array.isArray(c.surfaces) ? (c.surfaces as unknown[]) : []
  if (manual.length > 0) {
    const reasons = manual
      .map((m) =>
        m && typeof m === 'object' && !Array.isArray(m)
          ? `${(m as Record<string, unknown>).path ?? '?'}:${(m as Record<string, unknown>).reason ?? '?'}`
          : String(m),
      )
      .slice(0, 20)
    return { manual: true, reasons }
  }
  if (surfaces.length === 0) return { manual: true, reasons: ['no_deploy_surface'] }
  return { manual: false, reasons: [] }
}
