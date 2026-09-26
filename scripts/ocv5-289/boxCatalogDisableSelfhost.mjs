/** OCV5-289 one-shot selfhost fail-closed catalog compensation.
 * Uses only the verified live release's existing disableEntry authority.
 * No migration, Box call, price patch, or model retry. */
import { readFileSync, realpathSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';

const model = 'box-api-claude-opus-5-5';
const expected = '577ba459a2e42dbfe5aaf38e0c1d825ecf8363ad';
try {
const live = realpathSync('/opt/openclaude/openclaude-v5-selfhost-live');
const assert = (ok, code) => { if (!ok) throw new Error(code); };
const mode = process.argv[2] ?? 'plan';
assert(mode === 'plan' || mode === 'disable', 'BOX_DISABLE_MODE_INVALID');
assert(hostname() === 'v3-dev-sg' && process.env.OCV5_289_ACK_USER_ID === '3',
  'BOX_DISABLE_SELFHOST_BOUNDARY');
assert(live.startsWith('/opt/openclaude/openclaude-v5-selfhost-releases/rel-')
  && realpathSync(process.cwd()) === live
  && JSON.parse(readFileSync(`${live}/.complete`, 'utf8')).sourceCommit === expected,
  'BOX_DISABLE_LIVE_SHA');
if (mode === 'disable') {
  assert(process.env.OCV5_289_CATALOG_DISABLE_ACK === '1', 'BOX_DISABLE_ACK_REQUIRED');
}
const importLive = async (relative) => import(pathToFileURL(`${live}/${relative}`).href);
const [{ disableEntry }, { loadConfig }, { getPool, closePool }, admin,
  { sameSelfhostCatalogEndpoint }, { getRuntimeChannel }] = await Promise.all([
  importLive('packages/commercial/src/admin/modelCatalogOps.ts'),
  importLive('packages/commercial/src/config.ts'),
  importLive('packages/commercial/src/db/index.ts'),
  importLive('packages/commercial/src/db/modelCatalogAdmin.ts'),
  importLive('scripts/ocv5-289/boxCatalogBoundary.ts'),
  importLive('packages/commercial/src/runtimeChannel.ts'),
]);
assert(getRuntimeChannel() === 'v5', 'BOX_DISABLE_RUNTIME_CHANNEL');
const cfg = loadConfig();
assert(cfg.MODEL_CATALOG_ADMIN_DATABASE_URL &&
  sameSelfhostCatalogEndpoint(cfg.DATABASE_URL, cfg.MODEL_CATALOG_ADMIN_DATABASE_URL),
  'BOX_DISABLE_DB_ENDPOINT');
const pool = getPool();
try {
  await admin.assertModelCatalogAdminPoolConfigured();
  const sql = `SELECT current_database() AS name,
    host(inet_server_addr()) AS addr, inet_server_port() AS port`;
  const [appDb, adminDb] = await Promise.all([
    pool.query(sql), admin.getModelCatalogAdminPool().query(sql),
  ]);
  const valid = (r) => r.rows.length === 1
    && r.rows[0].name === 'openclaude_v5_selfhost'
    && r.rows[0].addr === '127.0.0.1' && r.rows[0].port === 5432;
  assert(valid(appDb) && valid(adminDb), 'BOX_DISABLE_WRONG_DATABASE');
  const entrySql = `SELECT entry_id::text,state,lock_version,engine,
    provider_id,upstream_model_id FROM model_catalog WHERE model_id=$1
    AND state IN ('staged','active','disabled')`;
  const priceSql = `SELECT enabled,visibility FROM model_pricing WHERE model_id=$1`;
  let [entry, price] = await Promise.all([
    pool.query(entrySql, [model]), pool.query(priceSql, [model]),
  ]);
  const row = entry.rows[0];
  assert(entry.rows.length === 1 && row && row.engine === 'ccb'
    && row.provider_id === 'box_cli'
    && row.upstream_model_id === 'claude-opus-5-5'
    && price.rows.length === 1 && price.rows[0].visibility === 'admin'
    && (row.state === 'active' ? price.rows[0].enabled === true
      : price.rows[0].enabled === false),
  'BOX_DISABLE_EVIDENCE_INVALID');
  if (mode === 'disable' && row.state === 'active') {
    await disableEntry(row.entry_id, row.lock_version,
      { adminId: 3, userAgent: 'ocv5-289-box-catalog-disable' });
    [entry, price] = await Promise.all([
      pool.query(entrySql, [model]), pool.query(priceSql, [model]),
    ]);
    assert(entry.rows.length === 1 && entry.rows[0].state === 'disabled'
      && price.rows.length === 1 && price.rows[0].enabled === false
      && price.rows[0].visibility === 'admin', 'BOX_DISABLE_NOT_PROVEN');
  }
  writeSync(1, JSON.stringify({ mode, model, state: entry.rows[0]?.state,
    pricingEnabled: price.rows[0]?.enabled,
    visibility: price.rows[0]?.visibility, migrationRun: false, boxCall: false }) + '\n');
} finally {
  await Promise.allSettled([closePool(), admin.closeModelCatalogAdminPool()]);
}
} catch (error) {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.message)
    ? error.message : 'BOX_DISABLE_FAILED_INSPECT_STATE';
  writeSync(2, code + '\n');
  process.exitCode = 1;
}
// disableEntry's snapshot refresh may open a LISTEN client independent of the
// two pools above. All transaction/result work and finally cleanup have ended;
// terminate this one-shot operator so a successful rollback cannot hang.
process.exit(process.exitCode ?? 0);
