/** OCV5-425 selfhost catalog operation. Invoke only on the selfhost host after the lease-train
 * callback and read-only live verification.
 *   --check            read-only report
 *   --on --sha <sha>   stage+activate the OpenCode Go models (scripts/ocv5-425/models.ts) and
 *                      switch Gemini 4 to its effort-tier profile; every serving process must
 *                      contain the reviewed SHA
 *   --off              disable/hide the new models and switch Gemini 4 back to no tiers
 * Refuses any drift from the reviewed rows. Environment keys stay in memory, never printed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Pool } from 'pg'

import {
  applyGoCatalog,
  readGoCatalog,
} from '../../packages/commercial/src/admin/openCodeGoCatalog.js'

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
  if (check) {
    await client.query('SET TRANSACTION READ ONLY')
    const db = await client.query('SELECT current_database() AS db')
    if (db.rows[0]?.db !== 'openclaude_v5_selfhost')
      throw new Error('OCV5-425 refuses any other database')
  } else {
    await applyGoCatalog(client, on ? 'on' : 'off')
  }
  const models = await readGoCatalog(client)
  await client.query('COMMIT')
  console.log(JSON.stringify({ action: check ? 'check' : on ? 'on' : 'off', models }, null, 1))
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await pool.end()
}
