/** OCV5-289 operator-only Box Exec capability probe.
 * This does NOT install Sand relay, issue inference, publish credentials, or
 * change the user container. It may call upstream EnsureSandBox once.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ProxyAgent, fetch as fetchUndici } from 'undici'
import { getAccount, getCursorTokenSnapshot, getTokenForUse } from '../../packages/commercial/src/account-pool/store.js'
import { resolveAccountEgressDispatcher } from '../../packages/commercial/src/account-pool/egressDispatcher.js'
import { CursorSandProvisionClient } from '../../packages/commercial/src/account-pool/cursorSandProvision.js'
import { getRuntimeChannel } from '../../packages/commercial/src/runtimeChannel.js'
import { encodeExecRequest, parseExecFrames } from '../../packages/gateway/src/engine/cursorBoxCcExec.js'
import { boxExecEgressBasis } from './boxExecBasis.js'

const ACCOUNT_ID = '20'
const AUTH_DIR = '/etc/openclaude/cursor-v5-u3'
const MODEL = '/home/box/.local/bin/claude'
const COMMANDS = [['--version'], ['--help']] as const
async function main(): Promise<void> {
if (process.env.OCV5_289_ACK_ACCOUNT_ID !== ACCOUNT_ID || process.env.OCV5_289_ACK_USER_ID !== '3') {
  throw new Error('OCV5_289_OPERATOR_ACK_REQUIRED')
}
if (getRuntimeChannel() !== 'v5') throw new Error('WRONG_RUNTIME_CHANNEL')

const account = await getAccount(ACCOUNT_ID)
if (!account || account.provider !== 'cursor' || account.status !== 'active'
  || account.cursor_sand_enabled !== true || account.cursor_credential_kind !== 'session'
  || account.cursor_sand_access_state !== 'SAND_ACCESS_STATE_GRANTED'
  || (account.cooldown_until && account.cooldown_until.getTime() > Date.now())) {
  throw new Error('BOX_ACCOUNT_NOT_ELIGIBLE')
}
let secret: Awaited<ReturnType<typeof getTokenForUse>> = null
let snap: Awaited<ReturnType<typeof getCursorTokenSnapshot>> = null
let proxy: ProxyAgent | undefined
try {
  secret = await getTokenForUse(ACCOUNT_ID, undefined, { requireActiveStatus: true })
  snap = await getCursorTokenSnapshot(ACCOUNT_ID)
  if (!secret || !snap) throw new Error('BOX_CREDENTIAL_MISSING')
  if (snap.credential_kind !== 'session' || !snap.machine_id || !snap.expires_at
    || snap.expires_at.getTime() < Date.now() + 60_000
    || secret.token.length !== snap.token.length
    || !timingSafeEqual(secret.token, snap.token)) throw new Error('BOX_CREDENTIAL_SNAPSHOT_CHANGED')
  const egress = await resolveAccountEgressDispatcher(ACCOUNT_ID, {
    egressProxy: secret.egress_proxy,
    egressTarget: secret.egress_target,
    egressProxyId: secret.egress_proxy_id,
    egressHostUuid: secret.egress_host_uuid,
  })
  if (egress.kind === 'unavailable') throw new Error('BOX_EGRESS_UNAVAILABLE')
  const egressBasis = boxExecEgressBasis({ proxy: secret.egress_proxy, proxyId: secret.egress_proxy_id,
    hostUuid: secret.egress_host_uuid, target: secret.egress_target })
  let fallbackProxyHash: string | null = null
  if (egress.kind === 'unbound') {
    try {
      const proxyUrl = readFileSync(`${AUTH_DIR}/.https-proxy`, 'utf8').trim()
      const parsed = new URL(proxyUrl)
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('invalid proxy')
      proxy = new ProxyAgent(proxyUrl)
      fallbackProxyHash = createHash('sha256').update(proxyUrl).digest('hex')
    } catch { throw new Error('BOX_FALLBACK_PROXY_UNAVAILABLE') }
  }
  const dispatcher = egress.kind === 'ready' ? egress.dispatcher : proxy
  const fetchImpl = (url: string, init: RequestInit): Promise<Response> => fetchUndici(url, {
    ...init, dispatcher,
  } as Parameters<typeof fetchUndici>[1]) as unknown as Promise<Response>
  const client = new CursorSandProvisionClient({ fetchImpl, timeoutMs: 15_000 })
  const assertCurrent = async (): Promise<void> => {
    const current = await getAccount(ACCOUNT_ID)
    if (!current || current.status !== 'active' || current.provider !== 'cursor'
      || current.cursor_sand_enabled !== true || current.cursor_credential_kind !== 'session'
      || current.cursor_sand_access_state !== 'SAND_ACCESS_STATE_GRANTED'
      || (current.cooldown_until && current.cooldown_until.getTime() > Date.now())) throw new Error('BOX_ACCOUNT_CHANGED')
    const freshUse = await getTokenForUse(ACCOUNT_ID, undefined, { requireActiveStatus: true })
    let fresh: Awaited<ReturnType<typeof getCursorTokenSnapshot>> = null
    try {
      fresh = await getCursorTokenSnapshot(ACCOUNT_ID)
      if (!freshUse || !fresh || fresh.machine_id !== snap.machine_id
        || !fresh.expires_at || fresh.expires_at.getTime() <= Date.now() + 60_000
        || fresh.token.length !== snap.token.length || !timingSafeEqual(fresh.token, snap.token)
        || freshUse.token.length !== snap.token.length || !timingSafeEqual(freshUse.token, snap.token)
        || boxExecEgressBasis({ proxy: freshUse.egress_proxy, proxyId: freshUse.egress_proxy_id,
          hostUuid: freshUse.egress_host_uuid, target: freshUse.egress_target }) !== egressBasis) {
        throw new Error('BOX_CREDENTIAL_OR_EGRESS_CHANGED')
      }
      const nextEgress = await resolveAccountEgressDispatcher(ACCOUNT_ID, {
        egressProxy: freshUse.egress_proxy, egressTarget: freshUse.egress_target,
        egressProxyId: freshUse.egress_proxy_id, egressHostUuid: freshUse.egress_host_uuid,
      })
      if (nextEgress.kind !== egress.kind) throw new Error('BOX_EGRESS_CHANGED')
      if (fallbackProxyHash !== null) {
        let currentHash: string
        try { currentHash = createHash('sha256').update(readFileSync(`${AUTH_DIR}/.https-proxy`, 'utf8').trim()).digest('hex') }
        catch { throw new Error('BOX_FALLBACK_PROXY_CHANGED') }
        if (currentHash !== fallbackProxyHash) throw new Error('BOX_FALLBACK_PROXY_CHANGED')
      }
    } finally {
      freshUse?.token.fill(0); freshUse?.refresh?.fill(0)
      fresh?.token.fill(0); fresh?.refresh?.fill(0)
    }
  }
  client.setAccountGuard(assertCurrent)
  const controlAbort = new AbortController()
  const target = await client.resolveBoxExec(snap.token.toString('utf8').trim(), snap.machine_id, controlAbort.signal)
  const summaries: Array<Record<string, unknown>> = []
  for (const argv of COMMANDS) {
    await assertCurrent()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const request = encodeExecRequest({
        command: MODEL,
        args: [...argv],
        cwd: '/workspace',
        environment: { HOME: '/home/box', PATH: '/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      })
      const response = await fetchImpl(target.execUrl, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {
          authorization: `Bearer ${target.execToken}`,
          'content-type': 'application/connect+json',
          'connect-protocol-version': '1',
          'x-anyrun-network-token': target.networkToken,
        },
        body: new Uint8Array(request),
      })
      if (!response.ok || !response.body) throw new Error(`BOX_EXEC_HTTP_${response.status}`)
      const reader = response.body.getReader()
      let pending = Buffer.alloc(0), output = '', total = 0, exitCode: number | null = null
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          total += chunk.value.byteLength
          if (total > 256 * 1024) throw new Error('BOX_EXEC_RESPONSE_TOO_LARGE')
          pending = Buffer.concat([pending, Buffer.from(chunk.value)])
          const parsed = parseExecFrames(pending)
          pending = Buffer.from(parsed.rest)
          for (const event of parsed.events) {
            if (event.kind === 'stdout') output += event.data ?? ''
            if (event.kind === 'exit') exitCode = event.code ?? 0
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      if (exitCode !== 0 || pending.length !== 0) throw new Error('BOX_EXEC_INCOMPLETE')
      const flags = argv[0] === '--help'
        ? ['--input-format', '--output-format', '--mcp-config', '--no-session-persistence', '--tools']
            .filter((flag) => output.includes(flag))
        : []
      const version = output.trim().split(/\r?\n/, 1)[0] ?? ''
      summaries.push({ command: argv[0], exitCode, outputBytes: Buffer.byteLength(output),
        outputHash: createHash('sha256').update(output).digest('hex').slice(0, 16), flags,
        ...(argv[0] === '--version' && /^\d+\.\d+\.\d+ \(Claude Code\)$/.test(version) ? { version } : {}) })
    } finally { clearTimeout(timer) }
  }
  process.stdout.write(JSON.stringify({ accountId: ACCOUNT_ID, route: 'box-exec-direct', summaries }) + '\n')
} finally {
  secret?.token.fill(0); secret?.refresh?.fill(0)
  snap?.token.fill(0); snap?.refresh?.fill(0)
  await proxy?.destroy()
}
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : ''
  const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(message) ? message : 'BOX_PROBE_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
