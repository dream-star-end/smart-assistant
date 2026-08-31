// OCV5-54 defect 2 live proof: explicit unknown --model must 400 DELEGATE_MODEL_UNKNOWN
// and must not mint an async job.
//
// Playwright `request` always hits OC_E2E_BASE_URL first (candidate HTTP).
// Commercial user JWT cannot reach container /delegate (BLOCKED_FOR_USER 403).
// 401/404 fail-closed. Only exact 403 falls through to the expected eval
// container `oc-v5-u<eval-user>` (same location as 11-cron-inbox-delivery).
// The eval POST uses async:true so the job-create branch is on the path.
// SQLite snapshots are only honest when OC_DELEGATE_SM && OC_DELEGATE_DURABLE
// are effective (production write path). Flag-off jobs live in memory and are
// not persisted until shutdown JSON; unchanged default DB would be fake-green.
// Flag-off "no job" is the HTTP mint handle: 400 and no jobId (async 200 would
// return jobId). Keep a single 400 assertion — 401 from model-authority is red.

import { execFileSync } from 'node:child_process'

import WebSocket from 'ws'

import { expect, test } from '../fixtures'
import { config } from '../lib/env'
import { queryScalar } from '../lib/pg'

const UNKNOWN_SLUG = 'definitely-not-a-model'
const DELEGATE_BODY = {
  goal: 'e2e unknown slug must not inherit',
  model: UNKNOWN_SLUG,
  sourceAgent: 'main',
  async: true,
}

const EVAL_PROBE = String.raw`
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function flagOn(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on'
}
function isDelegateSmEnabled(env) {
  return flagOn(env.OC_DELEGATE_SM)
}
function isDelegateDurableEnabled(env) {
  return flagOn(env.OC_DELEGATE_DURABLE)
}
function isDelegateDurableEffective(env) {
  return isDelegateSmEnabled(env) && isDelegateDurableEnabled(env)
}
function resolveDelegateJobsDbPath(env) {
  const override = String(env.OPENCLAUDE_DELEGATE_JOBS_DB ?? '').trim()
  if (override) return override
  const home = String(env.OPENCLAUDE_HOME ?? '').trim() || join(homedir(), '.openclaude')
  return join(home, 'delegate-jobs.db')
}

function snapshotJobs(db) {
  if (!existsSync(db)) return { path: db, exists: false, readable: true, count: 0, ids: [] }
  const py = [
    'import json, sqlite3, sys',
    'con = sqlite3.connect(sys.argv[1])',
    'try:',
    '    ids = [row[0] for row in con.execute("SELECT job_id FROM delegate_jobs ORDER BY job_id")]',
    '    print(json.dumps({"exists": True, "readable": True, "count": len(ids), "ids": ids}))',
    'except sqlite3.OperationalError as err:',
    '    print(json.dumps({"exists": True, "readable": False, "count": 0, "ids": [], "error": str(err)}))',
  ].join('\n')
  const bins = ['python3', 'python']
  for (const bin of bins) {
    try {
      const raw = execFileSync(bin, ['-c', py, db], { encoding: 'utf8' })
      return { path: db, readable: true, ...JSON.parse(raw) }
    } catch {
      /* try next reader */
    }
  }
  try {
    const raw = execFileSync('sqlite3', ['-json', db, 'SELECT job_id FROM delegate_jobs ORDER BY job_id'], {
      encoding: 'utf8',
    })
    const rows = raw.trim() ? JSON.parse(raw) : []
    const ids = rows.map((row) => row.job_id)
    return { path: db, exists: true, readable: true, count: ids.length, ids }
  } catch (err) {
    throw new Error('job-store unreadable: ' + ((err && err.message) || err))
  }
}

const flags = {
  sm: isDelegateSmEnabled(process.env),
  durable: isDelegateDurableEnabled(process.env),
  durableEffective: isDelegateDurableEffective(process.env),
}
const dbPath = resolveDelegateJobsDbPath(process.env)
const cfg = JSON.parse(readFileSync('/home/agent/.openclaude/openclaude.json', 'utf8'))
const token = cfg?.gateway?.accessToken
const port = Number(cfg?.gateway?.port || process.env.OPENCLAUDE_GATEWAY_PORT || 18789)
if (!token) throw new Error('gateway accessToken missing')
const payload = JSON.parse(Buffer.from(process.env.OC_E2E_PAYLOAD_B64, 'base64').toString('utf8'))
const before = flags.durableEffective ? snapshotJobs(dbPath) : null
const response = await fetch('http://127.0.0.1:' + port + '/api/agents/coding-assistant/delegate', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
const text = await response.text()
let body = text
try { body = JSON.parse(text) } catch { /* keep text */ }
const after = flags.durableEffective ? snapshotJobs(dbPath) : null
process.stdout.write(JSON.stringify({
  status: response.status,
  body,
  flags,
  dbPath,
  before,
  after,
}))
`

async function ensureEvalContainerReady(token: string): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const retryAfterMs = await new Promise<number | null>((resolve, reject) => {
      const ws = new WebSocket(`${config().wsBase}/ws/user-chat-bridge`, ['bearer', token])
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (retryMs: number | null, error?: Error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        ws.removeAllListeners()
        ws.once('error', () => { /* consume terminate while CONNECTING */ })
        try { ws.terminate() } catch { /* already closed */ }
        if (error) reject(error)
        else resolve(retryMs)
      }
      timer = setTimeout(
        () => finish(null, new Error('v5-evals container relay readiness timed out')),
        deadline - Date.now(),
      )

      ws.on('message', (data) => {
        try {
          if (JSON.parse(String(data))?.type === 'sys.relay_ready') finish(null)
        } catch {
          // Ignore non-JSON frames while waiting for the authoritative ready signal.
        }
      })
      ws.on('error', (error) => finish(null, new Error(`v5-evals container relay error: ${error.message}`)))
      ws.on('close', (code, reasonBuffer) => {
        const reason = String(reasonBuffer)
        try {
          const parsed = JSON.parse(reason) as { reason?: unknown; retryAfterSec?: unknown }
          const retryAfterSec = Number(parsed.retryAfterSec)
          if (
            code === 4503
            && (parsed.reason === 'starting' || parsed.reason === 'provisioning')
            && Number.isFinite(retryAfterSec)
            && retryAfterSec > 0
          ) {
            finish(Math.min(Math.max(retryAfterSec * 1000, 1000), 60_000))
            return
          }
        } catch {
          // Malformed or non-JSON close reasons are not retryable readiness signals.
        }
        finish(null, new Error(`v5-evals container relay closed before ready: ${code} ${reason}`))
      })
    })
    if (retryAfterMs === null) return
    const remainingMs = deadline - Date.now()
    if (retryAfterMs >= remainingMs) break
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs))
  }
  throw new Error('v5-evals container relay readiness timed out')
}

type JobSnapshot = { path: string; exists: boolean; readable: boolean; count: number; ids: string[] }
type EvalProbe = {
  status: number
  body: any
  flags: { sm: boolean; durable: boolean; durableEffective: boolean }
  dbPath: string
  before: JobSnapshot | null
  after: JobSnapshot | null
}

function probeUnknownSlugOnEvalContainer(userId: string, payload: unknown): EvalProbe {
  const dockerName = `oc-v5-u${userId}`
  if (!/^oc-v5-u[1-9][0-9]*$/.test(dockerName)) throw new Error(`unexpected eval container ${dockerName}`)
  const sshHost = process.env.OC_E2E_PW_HOST?.trim() || 'kl-mirror'
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64')
  const remoteCommand = [
    `OC_E2E_PAYLOAD_B64=${payloadBase64}`,
    'node --input-type=module',
  ].join(' ')
  const raw = execFileSync(
    'ssh',
    ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshHost, `docker exec -i ${dockerName} env ${remoteCommand}`],
    { encoding: 'utf8', input: EVAL_PROBE, timeout: 30_000 },
  )
  return JSON.parse(raw) as EvalProbe
}

test('explicit unknown slug returns 400 DELEGATE_MODEL_UNKNOWN without a job', async ({
  request,
  api,
  token,
}) => {
  const cfg = config()
  expect(cfg.baseUrl, 'OC_E2E_BASE_URL must be set').toBeTruthy()
  const login = await api.login()
  const userId = login.userId
  expect(userId).toMatch(/^[1-9][0-9]*$/)
  const url = `${cfg.baseUrl}/api/agents/coding-assistant/delegate`

  const viaCandidate = await request.post(url, {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    data: DELEGATE_BODY,
  })
  const candidateStatus = viaCandidate.status()
  let candidateBody: any = {}
  try {
    candidateBody = await viaCandidate.json()
  } catch {
    candidateBody = { error: await viaCandidate.text() }
  }
  expect(
    candidateStatus,
    `commercial /delegate must 403 BLOCKED_FOR_USER so job-store proof runs on oc-v5-u${userId}; got ${candidateStatus} ${JSON.stringify(candidateBody)}`,
  ).toBe(403)

  await ensureEvalContainerReady(token)
  await expect.poll(() => {
    return queryScalar(`
      SELECT ac.id
        FROM agent_containers ac
        JOIN compute_hosts ch ON ch.id=ac.host_uuid
       WHERE ac.user_id=${userId}::bigint
         AND ac.state='active'
         AND ch.name='self'
       LIMIT 1
    `)
  }, {
    message: 'v5-evals 必须已有 self host active 容器',
    timeout: 15_000,
  }).toMatch(/^[1-9][0-9]*$/)

  const posted = probeUnknownSlugOnEvalContainer(userId, DELEGATE_BODY)
  const { status, body, flags, dbPath, before, after } = posted
  expect(flags, `eval flag probe missing: ${JSON.stringify(posted)}`).toBeTruthy()
  expect(status, JSON.stringify(body)).toBe(400)
  expect(body.code).toBe('DELEGATE_MODEL_UNKNOWN')
  expect(String(body.error ?? '')).toMatch(/DELEGATE_MODEL_UNKNOWN/)
  expect(body.jobId, 'unknown slug must not mint an async job').toBeUndefined()
  if (flags.durableEffective) {
    expect(before, `durable on (${dbPath}) but before snapshot missing`).toBeTruthy()
    expect(after, `durable on (${dbPath}) but after snapshot missing`).toBeTruthy()
    expect(before?.readable, `durable job-store unreadable before: ${JSON.stringify(before)}`).toBe(true)
    expect(after?.readable, `durable job-store unreadable after: ${JSON.stringify(after)}`).toBe(true)
    expect(
      after!.count,
      `job-store grew: db=${dbPath} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    ).toBe(before!.count)
    const beforeIds = new Set(before!.ids)
    const newIds = after!.ids.filter((id) => !beforeIds.has(id))
    expect(newIds, `new job ids after unknown slug: ${newIds.join(',')}`).toEqual([])
  } else {
    test.info().annotations.push({
      type: 'job-store',
      description: `OC_DELEGATE_SM=${flags.sm} OC_DELEGATE_DURABLE=${flags.durable}; sqlite is not the write path. HTTP jobId is the mint handle.`,
    })
  }
})
