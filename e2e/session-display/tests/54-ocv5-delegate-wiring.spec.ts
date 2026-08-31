// OCV5-54 defect 2 live proof: explicit unknown --model must 400 DELEGATE_MODEL_UNKNOWN
// and must not mint an async job.
//
// Playwright `request` always hits OC_E2E_BASE_URL first (candidate HTTP).
// Commercial user JWT cannot reach container /delegate (BLOCKED_FOR_USER 403);
// then follow 11-cron-inbox-delivery and POST from the evals container to its
// own gateway listener (real HTTP, not handleDelegateTask).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { expect, test } from '../fixtures'
import { config } from '../lib/env'

const UNKNOWN_SLUG = 'definitely-not-a-model'
const DELEGATE_BODY = {
  goal: 'e2e unknown slug must not inherit',
  model: UNKNOWN_SLUG,
  sourceAgent: 'main',
}

const POST_FROM_CONTAINER = String.raw`
import { readFileSync } from 'node:fs'
const cfg = JSON.parse(readFileSync('/home/agent/.openclaude/openclaude.json', 'utf8'))
const token = cfg?.gateway?.accessToken
const port = Number(cfg?.gateway?.port || process.env.OPENCLAUDE_GATEWAY_PORT || 18789)
if (!token) throw new Error('gateway accessToken missing')
const payload = JSON.parse(Buffer.from(process.env.OC_E2E_PAYLOAD_B64, 'base64').toString('utf8'))
const response = await fetch('http://127.0.0.1:' + port + '/api/agents/coding-assistant/delegate', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})
const text = await response.text()
let body = text
try { body = JSON.parse(text) } catch { /* keep text */ }
process.stdout.write(JSON.stringify({ status: response.status, body }))
`

function postDelegateFromEvalContainer(userId: string, payload: unknown): { status: number; body: any } {
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
    { encoding: 'utf8', input: POST_FROM_CONTAINER, timeout: 30_000 },
  )
  return JSON.parse(raw) as { status: number; body: any }
}

function postDelegateOnThisContainer(payload: unknown): { status: number; body: any } | null {
  try {
    const cfg = JSON.parse(readFileSync('/home/agent/.openclaude/openclaude.json', 'utf8')) as {
      gateway?: { accessToken?: string; port?: number }
    }
    const token = cfg.gateway?.accessToken
    const port = Number(cfg.gateway?.port || process.env.OPENCLAUDE_GATEWAY_PORT || 0)
    if (!token || !port) return null
    const raw = execFileSync(
      process.execPath,
      ['--input-type=module'],
      {
        encoding: 'utf8',
        timeout: 15_000,
        input: `const payload = ${JSON.stringify(payload)};
const token = ${JSON.stringify(token)};
const port = ${JSON.stringify(port)};
const response = await fetch('http://127.0.0.1:' + port + '/api/agents/coding-assistant/delegate', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
const text = await response.text();
let body = text;
try { body = JSON.parse(text) } catch {}
process.stdout.write(JSON.stringify({ status: response.status, body }));
`,
      },
    )
    return JSON.parse(raw) as { status: number; body: any }
  } catch {
    return null
  }
}

test('explicit unknown slug returns 400 DELEGATE_MODEL_UNKNOWN without a job', async ({
  request,
  api,
  token,
}) => {
  const cfg = config()
  expect(cfg.baseUrl, 'OC_E2E_BASE_URL must be set').toBeTruthy()
  const login = await api.login()
  const url = `${cfg.baseUrl}/api/agents/coding-assistant/delegate`

  const viaCandidate = await request.post(url, {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    data: DELEGATE_BODY,
  })
  let status = viaCandidate.status()
  let body: any = {}
  try {
    body = await viaCandidate.json()
  } catch {
    body = { error: await viaCandidate.text() }
  }

  if (status === 401 || status === 403 || status === 404) {
    const local = postDelegateOnThisContainer(DELEGATE_BODY)
    if (local) {
      status = local.status
      body = local.body
    } else {
      const posted = postDelegateFromEvalContainer(login.userId, DELEGATE_BODY)
      status = posted.status
      body = posted.body
    }
  }

  expect(status, JSON.stringify(body)).toBe(400)
  expect(body.code).toBe('DELEGATE_MODEL_UNKNOWN')
  expect(String(body.error ?? '')).toMatch(/DELEGATE_MODEL_UNKNOWN/)
  expect(body.jobId, 'unknown slug must not mint an async job').toBeUndefined()
})
