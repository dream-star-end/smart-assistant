/**
 * Private uncached verification CatalogSource for `remote-driver-v4` (`OCV5-749`, R12).
 *
 * Allows commissioning turns on allowed `-remote` models even when `model_catalog.state` is
 * `'disabled'` with `pool_auto_disabled = TRUE` (chicken-and-egg bootstrap before the first
 * verified profile activates the offer), while rejecting global admin disables
 * (`state = 'disabled' AND pool_auto_disabled = FALSE`).
 */
import type { RemoteProbeSnapshot } from '@openclaude/protocol'
import type { Pool } from 'pg'
import type { UserModelAuthzLoader } from '../../auth/userModelAuthz.js'
import {
  type ModelCapabilityProfile,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
  ModelCatalogSnapshot,
  type ModelEngine,
  parseCapabilityProfile,
} from '../../billing/modelCatalog.js'
import type { ModelVisibility } from '../../billing/pricing.js'
import type { CatalogSource } from '../../http/proxy/modelAuthorityGate.js'
import {
  computeAggregatedRemoteCatalogState,
  countEligibleEnabledRemoteOffers,
} from '../remoteBrainPool.js'
import { resolveProbedUpstreamModel } from './modelResolution.js'
import { loadRemoteDriverRegistry } from './registry.js'

function need(condition: unknown, code = 'REMOTE_VERIFICATION_CATALOG_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

export interface CreateDriverVerificationCatalogInput {
  readonly pool: Pool
  readonly source: CatalogSource
  readonly loadAuthz: UserModelAuthzLoader
  readonly driverId: string
  readonly canonicalModel: string
  readonly verifiedProbe: RemoteProbeSnapshot
  readonly fence: () => Promise<void>
  readonly registryPath?: string
}

function deriveBaseSlug(canonicalModel: string): string {
  return canonicalModel.endsWith('-remote')
    ? canonicalModel.slice(0, -'-remote'.length)
    : canonicalModel
}

function buildCapabilityProfileFromProbe(
  driverId: string,
  canonicalModel: string,
  resolvedUpstreamModel: string,
  rawRowProfile: unknown,
  verifiedProbe: RemoteProbeSnapshot,
): ModelCapabilityProfile {
  if (rawRowProfile && typeof rawRowProfile === 'object' && !Array.isArray(rawRowProfile)) {
    return parseCapabilityProfile(canonicalModel, rawRowProfile)
  }
  const probedModel = verifiedProbe.models.find((m) => m.upstreamModelId === resolvedUpstreamModel)
  const supported =
    probedModel && probedModel.supportedEfforts.length > 0
      ? [...probedModel.supportedEfforts]
      : ['low']
  const codexDefault = probedModel?.defaultEffort ?? null
  return parseCapabilityProfile(canonicalModel, {
    supports_vision: false,
    reasoning: {
      supported,
      codex_model_default: codexDefault,
    },
    ccb: {
      capability_zero: driverId === 'cc',
      supports_thinking: false,
      ...(driverId === 'cc' ? { context_owner: 'box-native-v1' } : {}),
    },
  })
}

export type VerificationCatalogHandle = ReturnType<typeof createDriverVerificationCatalog>

export function createDriverVerificationCatalog(
  input: CreateDriverVerificationCatalogInput,
): CatalogSource {
  const regMap = loadRemoteDriverRegistry(input.registryPath)
  const reg = regMap.get(input.driverId)
  need(reg !== undefined, 'REMOTE_DRIVER_NOT_REGISTERED')
  const expectedEngine = reg.authorityEngine as ModelEngine

  return {
    async assertFresh(): Promise<ModelCatalogSnapshot> {
      await input.fence()
      const live = await input.source.assertFresh()
      const authz = await input.loadAuthz(3n, live.securityEpoch)
      need(
        authz.role === 'admin' && !authz.deniedModelIds?.has(input.canonicalModel),
        'REMOTE_VERIFICATION_MODEL_DENIED',
      )

      const catRes = await input.pool.query<Record<string, any>>(
        `SELECT entry_id::text AS entry_id, model_id, engine, provider_id, upstream_model_id,
                context_window, capability_profile, capability_schema_version, state, lock_version,
                placement, pool_auto_disabled
           FROM model_catalog
          WHERE model_id = $1
            AND state IN ('active', 'disabled', 'staged')
          ORDER BY entry_id DESC
          LIMIT 1`,
        [input.canonicalModel],
      )
      need(catRes.rows.length === 1, 'REMOTE_VERIFICATION_CATALOG_ROW_MISSING')
      const catRow = catRes.rows[0]!
      need(catRow.placement === 'remote_pool', 'REMOTE_VERIFICATION_PLACEMENT_INVALID')
      need(catRow.engine === expectedEngine, 'REMOTE_VERIFICATION_ENGINE_MISMATCH')
      need(
        !(catRow.state === 'disabled' && catRow.pool_auto_disabled === false),
        'REMOTE_VERIFICATION_MODEL_ADMIN_DISABLED',
      )

      const baseSlug = deriveBaseSlug(input.canonicalModel)
      const priceRes = await input.pool.query<Record<string, any>>(
        `SELECT p.model_id, p.display_name,
                p.input_per_mtok::text       AS input_per_mtok,
                p.output_per_mtok::text      AS output_per_mtok,
                p.cache_read_per_mtok::text  AS cache_read_per_mtok,
                p.cache_write_per_mtok::text AS cache_write_per_mtok,
                p.multiplier::text           AS multiplier,
                p.visibility, p.sort_order, p.default_effort,
                p.min_plan_code,
                sp.tier AS min_plan_tier,
                sp.name AS min_plan_name,
                p.promo_label
           FROM model_pricing p
           LEFT JOIN subscription_plans sp ON sp.code = p.min_plan_code
          WHERE p.model_id IN ($1, $2)
          ORDER BY CASE WHEN p.model_id = $1 THEN 0 ELSE 1 END
          LIMIT 1`,
        [input.canonicalModel, baseSlug],
      )
      need(priceRes.rows.length === 1, 'REMOTE_VERIFICATION_PRICING_MISSING')
      const priceRow = priceRes.rows[0]!

      const rawUpstream = String(catRow.upstream_model_id ?? baseSlug)
      const resolvedUpstream = resolveProbedUpstreamModel(
        input.driverId,
        rawUpstream,
        input.verifiedProbe,
      )
      need(resolvedUpstream !== null, 'REMOTE_VERIFICATION_MODEL_NOT_PROBED')

      const capabilityProfile = buildCapabilityProfileFromProbe(
        input.driverId,
        input.canonicalModel,
        resolvedUpstream,
        catRow.capability_profile,
        input.verifiedProbe,
      )

      const entry: ModelCatalogEntry = {
        entryId: Number(catRow.entry_id),
        modelId: input.canonicalModel,
        engine: expectedEngine,
        providerId: catRow.provider_id ? String(catRow.provider_id) : null,
        upstreamModelId: resolvedUpstream,
        contextWindow: catRow.context_window == null ? null : Number(catRow.context_window),
        capabilityProfile,
        capabilitySchemaVersion: Number(catRow.capability_schema_version ?? 1),
        state: 'active',
        lockVersion: Number(catRow.lock_version ?? 0),
        placement: 'remote_pool',
      }

      const pricingEntry: ModelCatalogPricing = {
        modelId: input.canonicalModel,
        displayName: String(priceRow.display_name),
        inputPerMtok: BigInt(priceRow.input_per_mtok),
        outputPerMtok: BigInt(priceRow.output_per_mtok),
        cacheReadPerMtok: BigInt(priceRow.cache_read_per_mtok),
        cacheWritePerMtok: BigInt(priceRow.cache_write_per_mtok),
        multiplier: String(priceRow.multiplier),
        visibility: priceRow.visibility as ModelVisibility,
        sortOrder: Number(priceRow.sort_order),
        defaultEffort: priceRow.default_effort ? String(priceRow.default_effort) : null,
        minPlanCode: priceRow.min_plan_code ? String(priceRow.min_plan_code) : null,
        minPlanTier:
          priceRow.min_plan_tier == null || priceRow.min_plan_tier === ''
            ? null
            : Number(priceRow.min_plan_tier),
        minPlanName: priceRow.min_plan_name ? String(priceRow.min_plan_name) : null,
        promoLabel: priceRow.promo_label ? String(priceRow.promo_label) : null,
      }

      return new ModelCatalogSnapshot({
        entries: [entry],
        aliases: new Map(),
        pricing: new Map([[input.canonicalModel, pricingEntry]]),
        securityEpoch: live.securityEpoch,
        loadedAt: live.loadedAt,
      })
    },
  }
}

export async function syncProfileOffersCatalogState(
  pool: Pool,
  profileId: string,
): Promise<Array<{ canonicalModelId: string; catalogState: string }>> {
  const offers = (
    await pool.query<{ canonical_model_id: string }>(
      `SELECT DISTINCT canonical_model_id
         FROM remote_model_offers
        WHERE profile_id = $1`,
      [profileId],
    )
  ).rows

  const results: Array<{ canonicalModelId: string; catalogState: string }> = []
  for (const row of offers) {
    const canonicalModelId = String(row.canonical_model_id)
    const nextActive = await countEligibleEnabledRemoteOffers(canonicalModelId, pool)
    const catRes = await pool.query<{
      entry_id: string
      state: 'staged' | 'active' | 'disabled'
      pool_auto_disabled: boolean
    }>(
      `SELECT entry_id::text AS entry_id, state, pool_auto_disabled
         FROM model_catalog
        WHERE model_id = $1
          AND placement = 'remote_pool'
          AND state IN ('active', 'disabled', 'staged')
        ORDER BY entry_id DESC
        LIMIT 1`,
      [canonicalModelId],
    )
    if (catRes.rows.length === 0) continue
    const cat = catRes.rows[0]!
    const agg = computeAggregatedRemoteCatalogState({
      prevActiveOfferCount: cat.state === 'active' ? 1 : 0,
      nextActiveOfferCount: nextActive,
      existingCatalogState: cat.state,
      executionEnabled: nextActive > 0,
      poolAutoDisabled: Boolean(cat.pool_auto_disabled),
    })
    if (agg.globalAdminDisabled) {
      results.push({ canonicalModelId, catalogState: 'disabled' })
      continue
    }
    const entryId = Number(cat.entry_id)
    if (cat.state !== agg.catalogState) {
      if (cat.state === 'staged' && agg.catalogState === 'disabled') {
        await pool.query(`UPDATE model_catalog SET state = 'active' WHERE entry_id = $1`, [entryId])
        await pool.query(
          `UPDATE model_catalog SET state = 'disabled', pool_auto_disabled = TRUE WHERE entry_id = $1`,
          [entryId],
        )
      } else {
        await pool.query(
          `UPDATE model_catalog
              SET state = $2,
                  pool_auto_disabled = CASE WHEN $2 = 'disabled' THEN TRUE ELSE FALSE END
            WHERE entry_id = $1`,
          [entryId, agg.catalogState],
        )
      }
    }
    results.push({ canonicalModelId, catalogState: agg.catalogState })
  }
  return results
}
