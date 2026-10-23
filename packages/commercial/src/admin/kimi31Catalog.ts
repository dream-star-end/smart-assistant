/** OCV5-611 operator-only catalog preparation. No migration or activation.
 * Prices are the steward-approved platform prices, not a vendor cost claim. */
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { writeAdminAudit } from './audit.js'

export const KIMI31_MODEL_ID = 'k3.1-pro'
export const KIMI31_VERSION = {
  model_id: KIMI31_MODEL_ID,
  engine: 'ccb',
  provider_id: 'moonshot',
  upstream_model_id: KIMI31_MODEL_ID,
  context_window: 1_048_576,
  capability_schema_version: 1,
  capability_profile: {
    supports_vision: true,
    reasoning: { supported: ['low', 'high', 'max'], codex_model_default: null },
    ccb: { capability_zero: true, supports_thinking: true },
  },
} as const

export const KIMI31_PRICE = {
  model_id: KIMI31_MODEL_ID,
  display_name: 'Kimi K3.1 Pro',
  input_per_mtok: '609',
  output_per_mtok: '3046',
  cache_read_per_mtok: '61',
  cache_write_per_mtok: '0',
  multiplier: '1.000',
  enabled: false,
  visibility: 'public',
  sort_order: 89,
  default_effort: 'max',
  extra_system_prompt: null,
  min_plan_code: null,
} as const

export type Kimi31CatalogRow = {
  entry_id: string; model_id: string; state: string; engine: string;
  provider_id: string; upstream_model_id: string; context_window: number;
  capability_schema_version: number; capability_profile: unknown;
}
export type Kimi31PriceRow = { [K in keyof typeof KIMI31_PRICE]: unknown }

export const KIMI31_CATALOG_COLUMNS = `entry_id::text,model_id,state,engine,
  provider_id,upstream_model_id,context_window,capability_schema_version,capability_profile`
export const KIMI31_PRICE_COLUMNS = `model_id,display_name,input_per_mtok::text,
  output_per_mtok::text,cache_read_per_mtok::text,cache_write_per_mtok::text,
  multiplier::text,enabled,visibility,sort_order,default_effort,extra_system_prompt,min_plan_code`

export function exactKimi31Catalog(row: Kimi31CatalogRow): boolean {
  return row.model_id === KIMI31_MODEL_ID && row.engine === 'ccb'
    && row.provider_id === 'moonshot' && row.upstream_model_id === KIMI31_MODEL_ID
    && row.context_window === 1_048_576 && row.capability_schema_version === 1
    && ['staged', 'active', 'disabled'].includes(row.state)
    && isDeepStrictEqual(row.capability_profile, KIMI31_VERSION.capability_profile)
}

export function exactKimi31Price(row: Kimi31PriceRow, active = false): boolean {
  return Object.entries(KIMI31_PRICE).every(([key, value]) => {
    const actual = row[key as keyof Kimi31PriceRow]
    if (key === 'enabled') return actual === active
    if (key === 'multiplier') return typeof actual === 'string' && Number(actual) === 1
    return actual === value
  })
}

/** Caller owns BEGIN/COMMIT. The pricing trigger locks the catalog as definer;
 * an audit failure or drift must roll back the same transaction. */
export async function ensureKimi31Pricing(client: PoolClient, adminId: bigint): Promise<boolean> {
  const catalog = await client.query<Kimi31CatalogRow>(
    `SELECT ${KIMI31_CATALOG_COLUMNS} FROM model_catalog
     WHERE model_id=$1 AND state IN ('staged','active','disabled')`,
    [KIMI31_MODEL_ID],
  )
  if (catalog.rows.length !== 1 || !exactKimi31Catalog(catalog.rows[0]!)
    || catalog.rows[0]!.state !== 'staged') throw new Error('KIMI31_REQUIRES_EXACT_STAGE')
  const result = await client.query(
    `INSERT INTO model_pricing (model_id,display_name,input_per_mtok,output_per_mtok,
       cache_read_per_mtok,cache_write_per_mtok,multiplier,enabled,visibility,
       sort_order,default_effort,extra_system_prompt,min_plan_code,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,false,'public',89,'max',NULL,NULL,$8)
     ON CONFLICT (model_id) DO NOTHING RETURNING model_id`,
    [KIMI31_MODEL_ID, KIMI31_PRICE.display_name, KIMI31_PRICE.input_per_mtok,
      KIMI31_PRICE.output_per_mtok, KIMI31_PRICE.cache_read_per_mtok,
      KIMI31_PRICE.cache_write_per_mtok, KIMI31_PRICE.multiplier, adminId.toString()],
  )
  const price = await client.query<Kimi31PriceRow>(
    `SELECT ${KIMI31_PRICE_COLUMNS} FROM model_pricing WHERE model_id=$1 FOR UPDATE`,
    [KIMI31_MODEL_ID],
  )
  if (price.rows.length !== 1 || !exactKimi31Price(price.rows[0]!))
    throw new Error('KIMI31_PRICE_CONFLICT')
  // App/admin roles deliberately have catalog SELECT only. The INSERT's
  // SECURITY DEFINER trigger owns its row lock; recheck before committing so
  // a concurrent activation cannot be accidentally committed as disabled.
  const finalCatalog = await client.query<Kimi31CatalogRow>(
    `SELECT ${KIMI31_CATALOG_COLUMNS} FROM model_catalog
     WHERE model_id=$1 AND state IN ('staged','active','disabled')`, [KIMI31_MODEL_ID],
  )
  if (finalCatalog.rows.length !== 1 || !exactKimi31Catalog(finalCatalog.rows[0]!)
    || finalCatalog.rows[0]!.state !== 'staged') throw new Error('KIMI31_STAGE_CHANGED')
  if (result.rowCount === 1) {
    await writeAdminAudit(client, { adminId, action: 'pricing.create',
      target: `model:${KIMI31_MODEL_ID}`, before: null, after: KIMI31_PRICE,
      userAgent: 'ocv5-611-kimi31-stage' })
  }
  return result.rowCount === 1
}
