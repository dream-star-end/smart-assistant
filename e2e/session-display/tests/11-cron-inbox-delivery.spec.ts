// 用例 11:取 v5-evals 真实容器的既有 token + bridge IP 身份,从宿主 loopback 直投
// 0% candidate 的私有控制口 /internal/v3/inbox-post,再从用户 API 读取 durable cron 站内信。只写合成账号，
// finally 按唯一 delivery key 精确清理；不创建/执行真实 cron，也不触碰真实用户任务。

import { execFileSync } from 'node:child_process'
import WebSocket from 'ws'

import { test, expect } from '../fixtures'
import { config } from '../lib/env'
import { queryScalar, runSql } from '../lib/pg'

const POST_SCRIPT = String.raw`
import { execFileSync } from 'node:child_process'

const port = process.env.OC_E2E_TARGET_PORT
const container = process.env.OC_E2E_CONTAINER
const payload = Buffer.from(process.env.OC_E2E_PAYLOAD_B64, 'base64').toString('utf8')
if (!port || !container) throw new Error('candidate inbox-post target missing')
const token = execFileSync('docker', ['exec', container, 'printenv', 'OPENCLAUDE_V3_CONTAINER_TOKEN'], {
  encoding: 'utf8',
}).trim()
const inspect = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0]
const peerIp = Object.values(inspect?.NetworkSettings?.Networks ?? {})
  .map((network) => network?.IPAddress)
  .find(Boolean)
if (!token || !peerIp) throw new Error('real container identity missing')
const url = new URL('/internal/v3/inbox-post', 'http://127.0.0.1:' + port)
const response = await fetch(url, {
  method: 'POST',
  headers: {
    authorization: 'Bearer ' + token,
    'content-type': 'application/json; charset=utf-8',
    'x-v5-egress-peer-ip': peerIp,
  },
  body: payload,
})
const body = await response.text()
process.stdout.write(JSON.stringify({ status: response.status, body }))
`

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function ensureEvalContainerReady(token: string): Promise<void> {
  const ws = new WebSocket(`${config().wsBase}/ws/user-chat-bridge`, ['bearer', token])
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* already closed */ }
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(
      () => finish(new Error('v5-evals container relay readiness timed out')),
      90_000,
    )

    ws.on('message', (data) => {
      try {
        if (JSON.parse(String(data))?.type === 'sys.relay_ready') finish()
      } catch {
        // Ignore non-JSON frames while waiting for the authoritative ready signal.
      }
    })
    ws.on('error', (error) => finish(new Error(`v5-evals container relay error: ${error.message}`)))
    ws.on('close', (code, reason) => {
      finish(new Error(`v5-evals container relay closed before ready: ${code} ${String(reason)}`))
    })
  })
}

function postFromEvalContainer(
  dockerName: string,
  payload: { title: string; bodyMd: string; deliveryKey: string },
): { status: number; body: string } {
  const sshHost = process.env.OC_E2E_PW_HOST?.trim() || 'kl-mirror'
  const remotePort = process.env.OC_E2E_REMOTE_PORT?.trim() || '18795'
  if (!/^oc-v5-u[1-9][0-9]*$/.test(dockerName)) throw new Error(`unexpected eval container ${dockerName}`)
  const privatePort = remotePort === '18790' ? '18896' : remotePort === '18795' ? '18897' : ''
  if (!privatePort) throw new Error(`invalid candidate port ${remotePort}`)
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64')
  const remoteCommand = [
    `OC_E2E_TARGET_PORT=${privatePort}`,
    `OC_E2E_CONTAINER=${dockerName}`,
    `OC_E2E_PAYLOAD_B64=${payloadBase64}`,
    'node --input-type=module',
  ].join(' ')
  const raw = execFileSync(
    'ssh',
    ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshHost, remoteCommand],
    { encoding: 'utf8', input: POST_SCRIPT, timeout: 30_000 },
  )
  return JSON.parse(raw) as { status: number; body: string }
}

test('cron durable inbox：真实容器直投 candidate 后用户 API 可见且字段完整', async ({ api, token }) => {
  const login = await api.login()
  const userId = login.userId
  expect(userId).toMatch(/^[1-9][0-9]*$/)
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
  const dockerName = `oc-v5-u${userId}`

  const marker = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const deliveryKey = `cron.e2e.${marker}`
  const title = `e2e-cron-inbox-${marker}`
  const bodyMd = `e2e durable cron result ${marker}`

  try {
    const posted = postFromEvalContainer(dockerName, { title, bodyMd, deliveryKey })
    expect(posted.status).toBe(200)
    expect(JSON.parse(posted.body)).toEqual({ ok: true })

    const response = await fetch(`${config().baseUrl}/api/me/messages?limit=100`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.ok, `inbox list ${response.status}`).toBeTruthy()
    const result = await response.json() as {
      messages: Array<Record<string, unknown>>
    }
    const matching = result.messages.filter((message) => message.source_phase === deliveryKey)
    expect(matching).toHaveLength(1)
    expect(matching[0]).toMatchObject({
      audience: 'user',
      user_id: userId,
      title,
      body_md: bodyMd,
      category: 'automation',
      thread_key: `cron:user:${userId}`,
      source_type: 'cron_delivery',
      source_id: userId,
      source_phase: deliveryKey,
    })
  } finally {
    runSql(`
      DELETE FROM inbox_messages
       WHERE source_type='cron_delivery'
         AND source_id=${userId}::bigint
         AND source_phase=${sqlText(deliveryKey)}
    `)
  }
})
