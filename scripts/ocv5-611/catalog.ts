/** Migration-free selfhost preparation. Default plan is read-only.
 * stage only creates an unavailable model; activation is a separate existing
 * admin operation after real upstream cost proof and verified deployment. */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { closePool, getPool } from '../../packages/commercial/src/db/index.js'
import { assertModelCatalogAdminPoolConfigured, closeModelCatalogAdminPool,
  getModelCatalogAdminPool } from '../../packages/commercial/src/db/modelCatalogAdmin.js'
import { loadConfig } from '../../packages/commercial/src/config.js'
import { getRuntimeChannel } from '../../packages/commercial/src/runtimeChannel.js'
import { createStaged, normalizeVersionInput, validateVersionSemantics }
  from '../../packages/commercial/src/admin/modelCatalogOps.js'
import { KIMI31_MODEL_ID, KIMI31_VERSION, KIMI31_CATALOG_COLUMNS,
  KIMI31_PRICE_COLUMNS, exactKimi31Catalog, exactKimi31Price, ensureKimi31Pricing,
  type Kimi31CatalogRow, type Kimi31PriceRow }
  from '../../packages/commercial/src/admin/kimi31Catalog.js'
import { sameSelfhostCatalogEndpoint } from '../ocv5-289/boxCatalogBoundary.js'

function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code)
}
function servingSource(sha: string): void {
  check(/^[a-f0-9]{40}$/.test(sha), 'KIMI31_REVIEWED_SHA_REQUIRED')
  const live = realpathSync('/opt/openclaude/openclaude-v5-selfhost-live')
  check(live.startsWith('/opt/openclaude/openclaude-v5-selfhost-releases/rel-')
    && realpathSync(process.cwd()) === live, 'KIMI31_LIVE_CWD_REQUIRED')
  check(JSON.parse(readFileSync(`${live}/.complete`, 'utf8')).sourceCommit === sha,
    'KIMI31_LIVE_SHA_MISMATCH')
  let egress = 0
  for (const unit of ['openclaude-v5-selfhost.service',
    'openclaude-v5-selfhost-egress@A.service', 'openclaude-v5-selfhost-egress@B.service']) {
    const pid = execFileSync('systemctl', ['show', unit, '-p', 'MainPID', '--value'],
      { encoding: 'utf8', timeout: 5000 }).trim()
    if (!/^[1-9][0-9]*$/.test(pid)) {
      check(unit !== 'openclaude-v5-selfhost.service', 'KIMI31_MASTER_NOT_RUNNING')
      continue
    }
    check(realpathSync(`/proc/${pid}/cwd`) === live, 'KIMI31_SERVING_SHA_MISMATCH')
    if (unit.includes('egress@')) egress++
  }
  check(egress === 1, 'KIMI31_EGRESS_SLOT_AMBIGUOUS')
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'plan'
  check(mode === 'plan' || mode === 'stage', 'KIMI31_MODE_INVALID')
  check(hostname() === 'v3-dev-sg' && getRuntimeChannel() === 'v5'
    && process.env.OC_USER_ID === '3', 'KIMI31_SELFHOST_OPERATOR_REQUIRED')
  const cfg = loadConfig()
  check(!!cfg.MODEL_CATALOG_ADMIN_DATABASE_URL
    && sameSelfhostCatalogEndpoint(cfg.DATABASE_URL, cfg.MODEL_CATALOG_ADMIN_DATABASE_URL),
  'KIMI31_DATABASE_ENDPOINT_INVALID')
  check(validateVersionSemantics(normalizeVersionInput(KIMI31_VERSION)).length === 0,
    'KIMI31_CAPABILITY_INVALID')
  if (mode === 'stage') servingSource(process.argv[process.argv.indexOf('--sha') + 1] ?? '')
  await assertModelCatalogAdminPoolConfigured()
  const pool = getPool()
  const identitySql = `SELECT current_database() AS name,
    host(inet_server_addr()) AS addr, inet_server_port() AS port`
  const [app, admin] = await Promise.all([
    pool.query(identitySql), getModelCatalogAdminPool().query(identitySql),
  ])
  check(app.rows.length === 1 && app.rows[0]?.name === 'openclaude_v5_selfhost'
    && app.rows[0]?.addr === '127.0.0.1' && app.rows[0]?.port === 5432
    && isDeepStrictEqual(app.rows, admin.rows), 'KIMI31_DATABASE_IDENTITY_INVALID')
  const read = async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      const catalog = await client.query<Kimi31CatalogRow>(
        `SELECT ${KIMI31_CATALOG_COLUMNS} FROM model_catalog
         WHERE model_id=$1 AND state IN ('staged','active','disabled')`, [KIMI31_MODEL_ID])
      const price = await client.query<Kimi31PriceRow>(
        `SELECT ${KIMI31_PRICE_COLUMNS} FROM model_pricing WHERE model_id=$1`, [KIMI31_MODEL_ID])
      check(catalog.rows.length <= 1 && (!catalog.rows[0] || exactKimi31Catalog(catalog.rows[0])),
        'KIMI31_EXISTING_CATALOG_CONFLICT')
      check(price.rows.length <= 1 && (!price.rows[0] || (!!catalog.rows[0]
        && exactKimi31Price(price.rows[0], catalog.rows[0].state === 'active'))),
      'KIMI31_EXISTING_PRICE_CONFLICT')
      await client.query('COMMIT')
      return { catalog: catalog.rows[0], price: price.rows[0] }
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  }
  let state = await read()
  if (mode === 'stage') {
    check(!state.catalog || state.catalog.state === 'staged', 'KIMI31_STAGE_STATE_CONFLICT')
    if (!state.catalog) await createStaged(KIMI31_VERSION,
      { adminId: 3, userAgent: 'ocv5-611-kimi31-stage' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await ensureKimi31Pricing(client, 3n)
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
    state = await read()
    check(state.catalog?.state === 'staged' && state.price?.enabled === false,
      'KIMI31_STAGE_UNPROVEN')
  }
  console.log(JSON.stringify({ mode, model: KIMI31_MODEL_ID,
    catalog: state.catalog ?? null, price: state.price ?? null, activationPerformed: false }))
}
void main().then(async () => {
  await Promise.allSettled([closePool(), closeModelCatalogAdminPool()])
}, async (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.message)
    ? error.message : 'KIMI31_CATALOG_FAILED'
  console.error(code)
  await Promise.allSettled([closePool(), closeModelCatalogAdminPool()])
  process.exitCode = 1
})
