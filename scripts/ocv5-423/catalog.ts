/** Invoke only on selfhost host, after the lease-train callback and read-only
 * live verification. --check does not mutate. --off hides/disables just this
 * model; --on requires all serving processes to contain the reviewed SHA.
 * Environment keys stay in memory and are never printed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const args = process.argv.slice(2)
const on = args.includes('--on')
const off = args.includes('--off')
const check = args.includes('--check')
if ([on, off, check].filter(Boolean).length !== 1)
  throw new Error('use exactly one: --check | --on --sha <reviewed-sha> | --off')
const sha = args[args.indexOf('--sha') + 1]
const canonical = '/opt/openclaude/openclaude-v5-selfhost'
if (on) {
  if (!args.includes('--sha') || !/^[a-f0-9]{40}$/.test(sha ?? ''))
    throw new Error('--on requires exact reviewed SHA')
  let egressCount = 0
  for (const unit of [
    'openclaude-v5-selfhost.service',
    'openclaude-v5-selfhost-egress.service',
    'openclaude-v5-selfhost-egress@A.service',
    'openclaude-v5-selfhost-egress@B.service',
  ]) {
    const pid = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', unit], {
      encoding: 'utf8',
    }).trim()
    if (!/^\d+$/.test(pid) || pid === '0') {
      if (unit === 'openclaude-v5-selfhost.service')
        throw new Error('selfhost master is not running')
      continue
    }
    let directory = readlinkSync(`/proc/${pid}/cwd`)
    while (!existsSync(join(directory, '.complete')) && dirname(directory) !== directory)
      directory = dirname(directory)
    const live = JSON.parse(readFileSync(join(directory, '.complete'), 'utf8'))
      .sourceCommit as string
    if (!/^[a-f0-9]{40}$/.test(live)) throw new Error(`unverifiable ${unit} release`)
    execFileSync('git', ['-C', canonical, 'merge-base', '--is-ancestor', sha!, live])
    if (unit.includes('egress')) egressCount++
    console.log(JSON.stringify({ unit, liveSha: live }))
  }
  if (!egressCount) throw new Error('no running selfhost egress verified')
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  connectionTimeoutMillis: 10000,
  options: '-c statement_timeout=15000',
})
const client = await pool.connect()
try {
  await client.query('BEGIN')
  if (check) await client.query('SET TRANSACTION READ ONLY')
  const db = await client.query('SELECT current_database() AS db')
  if (db.rows[0]?.db !== 'openclaude_v5_selfhost')
    throw new Error('OCV5-423 refuses any other database')
  if (!check) {
    await client.query("SELECT set_config('openclaude.ocv5_423_enable',$1,true)", [
      on ? 'on' : 'off',
    ])
    await client.query(readFileSync(fileURLToPath(new URL('catalog.sql', import.meta.url)), 'utf8'))
  }
  const result =
    await client.query(`SELECT c.model_id,c.engine,c.provider_id,c.context_window,c.state,
    p.enabled,p.visibility,p.input_per_mtok,p.output_per_mtok,p.cache_read_per_mtok,p.cache_write_per_mtok
    FROM model_catalog c JOIN model_pricing p USING(model_id)
    WHERE c.model_id='gemini-4-argon-contributor' AND c.state IN ('active','disabled','staged')`)
  await client.query('COMMIT')
  console.log(JSON.stringify({ action: check ? 'check' : on ? 'on' : 'off', models: result.rows }))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await pool.end()
}
