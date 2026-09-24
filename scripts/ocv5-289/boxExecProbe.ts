/** OCV5-289 operator-only Box Exec capability and synthetic inference probe.
 * This does NOT install Sand relay, publish credentials, or change the user
 * container. An explicit second ACK permits one small synthetic inference.
 * EnsureSandBox may change upstream Box state; no call is retried on ambiguity.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ProxyAgent, fetch as fetchUndici } from 'undici'
import { getAccount, getCursorTokenSnapshot, getTokenForUse } from '../../packages/commercial/src/account-pool/store.js'
import { resolveAccountEgressDispatcher } from '../../packages/commercial/src/account-pool/egressDispatcher.js'
import { CursorSandProvisionClient } from '../../packages/commercial/src/account-pool/cursorSandProvision.js'
import { getRuntimeChannel } from '../../packages/commercial/src/runtimeChannel.js'
import { encodeExecRequest, parseExecFrames } from '../../packages/gateway/src/engine/cursorBoxCcExec.js'
import { boxExecEgressBasis } from './boxExecBasis.js'
import { withPinnedBoxHistoryVersion } from './boxHistoryVersionGate.js'
import { compileBoxCliSyntheticTurn } from '../../packages/commercial/src/http/proxy/boxMessagesMapper.js'
import type { ProxyBody } from '../../packages/commercial/src/http/proxy/shared.js'

const ACCOUNT_ID = '20'
const AUTH_DIR = '/etc/openclaude/cursor-v5-u3'
const MODEL = '/home/box/.local/bin/claude'
const COMMANDS = [['--version'], ['--help']] as const
async function main(): Promise<void> {
if (process.env.OCV5_289_ACK_ACCOUNT_ID !== ACCOUNT_ID || process.env.OCV5_289_ACK_USER_ID !== '3') {
  throw new Error('OCV5_289_OPERATOR_ACK_REQUIRED')
}
if (['OCV5_289_PARALLEL_ACK', 'OCV5_289_INFERENCE_ACK', 'OCV5_289_TOOL_ACK', 'OCV5_289_HISTORY_ACK']
  .filter((key) => process.env[key] === '1').length > 1) {
  throw new Error('BOX_PROBE_MODES_CONFLICT')
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
  const runFixed = async (input: { command: string; args: string[]; cwd: string;
    environment: Record<string, string>; timeoutMs?: number }): Promise<string> => {
    await assertCurrent()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20_000)
    try {
      const request = encodeExecRequest({ command: input.command, args: input.args,
        cwd: input.cwd, environment: input.environment })
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
      return output
    } finally { clearTimeout(timer) }
  }
  const summaries: Array<Record<string, unknown>> = []
  for (const argv of COMMANDS) {
    const output = await runFixed({ command: MODEL, args: [...argv], cwd: '/workspace',
      environment: { HOME: '/home/box', PATH: '/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' } })
      const flags = argv[0] === '--help'
        ? ['--input-format', '--output-format', '--mcp-config', '--no-session-persistence', '--tools']
            .filter((flag) => output.includes(flag))
        : []
      const version = output.trim().split(/\r?\n/, 1)[0] ?? ''
      summaries.push({ command: argv[0], exitCode: 0, outputBytes: Buffer.byteLength(output),
        outputHash: createHash('sha256').update(output).digest('hex').slice(0, 16), flags,
        ...(argv[0] === '--version' && /^\d+\.\d+\.\d+ \(Claude Code\)$/.test(version) ? { version } : {}) })
  }
  let parallelExec: Record<string, unknown> | undefined
  if (process.env.OCV5_289_PARALLEL_ACK === '1') {
    const nonce = randomBytes(12).toString('hex')
    const directory = `/tmp/ocv5-289-parallel-${nonce}`
    const firstPython = String.raw`import os,sys,time
directory,nonce=sys.argv[1:]
os.mkdir(directory,0o700)
with open(directory+'/pending.tmp','x',encoding='ascii') as f: f.write(nonce);f.flush();os.fsync(f.fileno())
os.replace(directory+'/pending.tmp',directory+'/pending')
end=time.time()+10
while time.time()<end and not os.path.exists(directory+'/result'):time.sleep(.02)
if not os.path.exists(directory+'/result'):raise SystemExit(2)
if open(directory+'/result',encoding='ascii').read()!=nonce:raise SystemExit(3)
print('first-ok')`
    const secondPython = String.raw`import os,sys,time
directory,nonce=sys.argv[1:]
end=time.time()+3
while time.time()<end and not os.path.exists(directory+'/pending'):time.sleep(.02)
if not os.path.exists(directory+'/pending') or open(directory+'/pending',encoding='ascii').read()!=nonce:raise SystemExit(2)
with open(directory+'/result.tmp','x',encoding='ascii') as f: f.write(nonce);f.flush();os.fsync(f.fileno())
os.replace(directory+'/result.tmp',directory+'/result')
print('second-ok')`
    const first = runFixed({ command: '/usr/bin/python3', args: ['-c', firstPython, directory, nonce],
      cwd: '/tmp', environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeoutMs: 15_000 })
    const second = runFixed({ command: '/usr/bin/python3', args: ['-c', secondPython, directory, nonce],
      cwd: '/tmp', environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeoutMs: 5_000 })
    const [firstResult, secondResult] = await Promise.allSettled([first, second])
    if (firstResult.status !== 'fulfilled' || secondResult.status !== 'fulfilled'
      || firstResult.value.trim() !== 'first-ok' || secondResult.value.trim() !== 'second-ok') {
      throw new Error('BOX_PARALLEL_EXEC_FAILED')
    }
    const cleanupPython = String.raw`import os,stat,sys
directory=sys.argv[1]
st=os.lstat(directory)
if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(1)
for name in ('pending','result'):os.unlink(directory+'/'+name)
os.rmdir(directory)
print('clean')`
    const cleaned = await runFixed({ command: '/usr/bin/python3', args: ['-c', cleanupPython, directory],
      cwd: '/tmp', environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
    if (cleaned.trim() !== 'clean') throw new Error('BOX_PARALLEL_CLEANUP_FAILED')
    parallelExec = { causalResultHandoff: true, firstExit: 0, secondExit: 0, cleanup: true }
  }
  let inference: Record<string, unknown> | undefined
  if (process.env.OCV5_289_INFERENCE_ACK === '1') {
    const asset = readFileSync(new URL('./box_supervisor.py', import.meta.url))
    const digest = createHash('sha256').update(asset).digest('hex')
    // Keep this non-secret, content-addressed asset after the probe: it
    // re-execs itself as the gate/watcher while the supervised CLI is live.
    // A later GC may remove it only after no process uses this digest.
    const remotePath = `/tmp/ocv5-289-supervisor-${digest.slice(0, 16)}.py`
    const stagePython = String.raw`import base64,hashlib,os,stat,sys
p,encoded,want=sys.argv[1:]
raw=base64.b64decode(encoded,validate=True)
if len(raw)>32768 or hashlib.sha256(raw).hexdigest()!=want: raise SystemExit(1)
try:
 fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
except FileExistsError:
 pass
else:
 try: os.write(fd,raw);os.fsync(fd)
 finally: os.close(fd)
st=os.lstat(p)
if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600: raise SystemExit(1)
if hashlib.sha256(open(p,'rb').read()).hexdigest()!=want: raise SystemExit(1)
print(want)`
    const stageOutput = await runFixed({ command: '/usr/bin/python3',
      args: ['-c', stagePython, remotePath, asset.toString('base64'), digest], cwd: '/tmp',
      environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
    if (stageOutput.trim() !== digest) throw new Error('BOX_SUPERVISOR_STAGE_FAILED')
    const verifyPython = String.raw`import hashlib,os,stat,sys
p=sys.argv[1];st=os.lstat(p)
if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600: raise SystemExit(1)
print(hashlib.sha256(open(p,'rb').read()).hexdigest())`
    const remoteDigest = await runFixed({ command: '/usr/bin/python3',
      args: ['-c', verifyPython, remotePath], cwd: '/tmp',
      environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
    if (remoteDigest.trim() !== digest) throw new Error('BOX_SUPERVISOR_VERIFY_FAILED')

    const nonce = `ocv5-289-${randomBytes(12).toString('hex')}`
    const prompt = `Return exactly this token, with no spaces or punctuation: ${nonce}`
    const output = await runFixed({
      command: '/usr/bin/python3', cwd: '/tmp', timeoutMs: 40_000,
      args: [remotePath, '--deadline', '30', '--kill-after', '2', '--max-output', '262144', '--',
        MODEL, '-p', prompt, '--model', 'claude-opus-5-5',
        '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
        '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config',
        '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--safe-mode'],
      environment: { HOME: '/home/box', PATH: '/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    })
    let records: Array<Record<string, unknown>>
    try { records = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) }
    catch { throw new Error('BOX_INFERENCE_STREAM_INVALID') }
    const init = records.find((record) => record.type === 'system' && record.subtype === 'init') as {
      tools?: unknown; mcp_servers?: unknown
    } | undefined
    const final = records.findLast((record) => record.type === 'result') as {
      subtype?: unknown; is_error?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown }
    } | undefined
    const text = records.filter((record) => record.type === 'assistant').flatMap((record) => {
      const content = (record.message as { content?: unknown } | undefined)?.content
      return Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text) : []
    }).join('')
    if (!init || !Array.isArray(init.tools) || init.tools.length !== 0
      || !Array.isArray(init.mcp_servers) || init.mcp_servers.length !== 0
      || final?.subtype !== 'success' || final.is_error !== false || text !== nonce
      || !Number.isSafeInteger(final.usage?.input_tokens) || Number(final.usage?.input_tokens) < 0
      || !Number.isSafeInteger(final.usage?.output_tokens) || Number(final.usage?.output_tokens) < 0) {
      throw new Error('BOX_INFERENCE_CONTRACT_FAILED')
    }
    inference = { exact: true, eventTypes: [...new Set(records.map((record) => record.type))],
      outputBytes: Buffer.byteLength(output), outputHash: createHash('sha256').update(output).digest('hex').slice(0, 16),
      inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens,
      remoteSupervisorHash: digest.slice(0, 16) }
  }
  let toolRoundtrip: Record<string, unknown> | undefined
  if (process.env.OCV5_289_TOOL_ACK === '1') {
    const stagePython = String.raw`import base64,hashlib,os,stat,sys
p,encoded,want=sys.argv[1:]
raw=base64.b64decode(encoded,validate=True)
if len(raw)>32768 or hashlib.sha256(raw).hexdigest()!=want:raise SystemExit(1)
try: fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
except FileExistsError: pass
else:
 try: os.write(fd,raw);os.fsync(fd)
 finally: os.close(fd)
st=os.lstat(p)
if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600:raise SystemExit(1)
if hashlib.sha256(open(p,'rb').read()).hexdigest()!=want:raise SystemExit(1)
print(want)`
    const stage = async (name: string): Promise<{ path: string; hash: string }> => {
      const asset = readFileSync(new URL(`./${name}`, import.meta.url))
      const hash = createHash('sha256').update(asset).digest('hex')
      const path = `/tmp/ocv5-289-${name.replace('.py', '')}-${hash.slice(0, 16)}.py`
      const observed = await runFixed({ command: '/usr/bin/python3',
        args: ['-c', stagePython, path, asset.toString('base64'), hash], cwd: '/tmp',
        environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
      if (observed.trim() !== hash) throw new Error('BOX_TOOL_ASSET_STAGE_FAILED')
      return { path, hash }
    }
    const supervisor = await stage('box_supervisor.py')
    const mcp = await stage('virtual_tool_mcp.py')
    const directory = `/tmp/ocv5-289-tool-${randomBytes(12).toString('hex')}`
    const created = await runFixed({ command: '/usr/bin/python3',
      args: ['-c', 'import os,sys;os.mkdir(sys.argv[1],0o700);print("created")', directory],
      cwd: '/tmp', environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
    if (created.trim() !== 'created') throw new Error('BOX_TOOL_DIR_CREATE_FAILED')
    let first: Promise<string> | undefined
    try {
      const mcpConfig = JSON.stringify({ mcpServers: { fixture: { type: 'stdio',
        command: '/usr/bin/python3', args: [mcp.path, directory] } } })
      const prompt = 'Call the fixture local_echo tool exactly once with value ping. Then reply with exactly the text returned by that tool, without other words.'
      first = runFixed({ command: '/usr/bin/python3', cwd: '/tmp', timeoutMs: 70_000,
        args: [supervisor.path, '--deadline', '55', '--kill-after', '2', '--max-output', '262144', '--',
          MODEL, '-p', prompt, '--model', 'claude-opus-5-5', '--output-format', 'stream-json',
          '--include-partial-messages', '--verbose', '--tools', '', '--strict-mcp-config',
          '--mcp-config', mcpConfig, '--allowedTools', 'mcp__fixture__local_echo',
          '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence'],
        environment: { HOME: '/home/box', PATH: '/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          OCV5_SUPERVISOR_TOOL_EVENT_FILE: `${directory}/event.json` } })
      void first.catch(() => {}) // handled again after rendezvous; no transient unhandled rejection
      // This is a separate simultaneous Box Exec. It exports metadata only;
      // the local tool result is chosen after OpenClaude checks both IDs.
      const rendezvousPython = String.raw`import json,os,stat,sys,time
d=sys.argv[1];end=time.monotonic()+35
fd=os.open(d,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 st=os.fstat(fd)
 if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(2)
 values={}
 while time.monotonic()<end:
  for name in ('event.json','pending.json'):
   if name in values:continue
   try: f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
   except FileNotFoundError:continue
   try:
    st=os.fstat(f)
    if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_size>16384:raise SystemExit(3)
    values[name]=json.loads(os.read(f,16385))
   finally:os.close(f)
  if len(values)==2:break
  time.sleep(.02)
 if len(values)!=2:raise SystemExit(4)
 print(json.dumps({'event':values['event.json'],'pending':values['pending.json']},separators=(',',':')))
finally:os.close(fd)`
      const metadata = JSON.parse(await runFixed({ command: '/usr/bin/python3',
        args: ['-c', rendezvousPython, directory], cwd: '/tmp', timeoutMs: 40_000,
        environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })) as {
          event?: { modelToolUseId?: unknown; name?: unknown; input?: unknown };
          pending?: { mcpRequestId?: unknown; name?: unknown; arguments?: unknown }
        }
      const modelId = metadata.event?.modelToolUseId
      const requestId = metadata.pending?.mcpRequestId
      if (typeof modelId !== 'string' || !/^toolu_[A-Za-z0-9_-]{1,120}$/.test(modelId)
        || metadata.event?.name !== 'mcp__fixture__local_echo'
        || JSON.stringify(metadata.event.input) !== '{"value":"ping"}'
        || metadata.pending?.name !== 'local_echo'
        || JSON.stringify(metadata.pending.arguments) !== '{"value":"ping"}'
        || (typeof requestId !== 'number' && typeof requestId !== 'string')
        || requestId === modelId) throw new Error('BOX_TOOL_METADATA_INVALID')
      // Fixed synthetic local action; no user data or arbitrary Box commands.
      const localResult = `local-${randomBytes(12).toString('hex')}`
      const resultWriter = String.raw`import json,os,stat,sys
d,request_id,model_id,text=sys.argv[1:]
fd=os.open(d,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 st=os.fstat(fd)
 if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(2)
 pending=json.load(open(d+'/pending.json'))
 event=json.load(open(d+'/event.json'))
 if str(pending.get('mcpRequestId'))!=request_id or event.get('modelToolUseId')!=model_id:raise SystemExit(3)
 raw=json.dumps({'mcpRequestId':pending['mcpRequestId'],'modelToolUseId':model_id,'text':text},separators=(',',':')).encode()
 tmp='result.'+str(os.getpid())+'.tmp'
 f=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
 try:os.write(f,raw);os.fsync(f)
 finally:os.close(f)
 try:os.link(tmp,'result.json',src_dir_fd=fd,dst_dir_fd=fd,follow_symlinks=False);os.fsync(fd)
 finally:os.unlink(tmp,dir_fd=fd)
 print('published')
finally:os.close(fd)`
      const published = await runFixed({ command: '/usr/bin/python3',
        args: ['-c', resultWriter, directory, String(requestId), modelId, localResult],
        cwd: '/tmp', environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
      if (published.trim() !== 'published') throw new Error('BOX_TOOL_RESULT_PUBLISH_FAILED')
      const output = await first
      let records: Array<Record<string, unknown>>
      try { records = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) }
      catch { throw new Error('BOX_TOOL_STREAM_INVALID') }
      const init = records.find((record) => record.type === 'system' && record.subtype === 'init') as {
        tools?: unknown; mcp_servers?: unknown
      } | undefined
      const final = records.findLast((record) => record.type === 'result') as {
        subtype?: unknown; is_error?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown }
      } | undefined
      const text = records.filter((record) => record.type === 'assistant').flatMap((record) => {
        const content = (record.message as { content?: unknown } | undefined)?.content
        return Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text) : []
      }).join('')
      if (!init || !Array.isArray(init.tools) || init.tools.length !== 1
        || init.tools[0] !== 'mcp__fixture__local_echo'
        || !Array.isArray(init.mcp_servers) || init.mcp_servers.length !== 1
        || final?.subtype !== 'success' || final.is_error !== false || text !== localResult
        || !Number.isSafeInteger(final.usage?.input_tokens) || Number(final.usage?.input_tokens) < 0
        || !Number.isSafeInteger(final.usage?.output_tokens) || Number(final.usage?.output_tokens) < 0) {
        throw new Error('BOX_TOOL_CONTRACT_FAILED')
      }
      toolRoundtrip = { exact: true, localResultReturned: true, soleTool: true,
        inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens,
        supervisorHash: supervisor.hash.slice(0, 16), mcpHash: mcp.hash.slice(0, 16) }
    } finally {
      const remoteTerminated = first ? await first.then(() => true, () => false) : true
      if (!remoteTerminated) {
        // The transport may have disconnected after Box accepted the run.
        // Do not remove live rendezvous files or silently retry the model.
        process.stderr.write('BOX_TOOL_REMOTE_UNKNOWN_RETAINED\n')
      } else {
      const cleanupPython = String.raw`import os,stat,sys
d=sys.argv[1];st=os.lstat(d)
if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(1)
for name in ('event.json','pending.json','result.json'):
 try:os.unlink(d+'/'+name)
 except FileNotFoundError:pass
os.rmdir(d);print('clean')`
      const cleaned = await runFixed({ command: '/usr/bin/python3',
        args: ['-c', cleanupPython, directory], cwd: '/tmp',
        environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
      if (cleaned.trim() !== 'clean') throw new Error('BOX_TOOL_CLEANUP_FAILED')
      }
    }
  }
  let historyReplay: Record<string, unknown> | undefined
  if (process.env.OCV5_289_HISTORY_ACK === '1') {
    const observedVersion = summaries.find((item) => item.command === '--version')?.version
    await withPinnedBoxHistoryVersion(observedVersion, async () => {
    const nonce = `local-${randomBytes(12).toString('hex')}`
    const directory = `/tmp/ocv5-289-run-${randomBytes(12).toString('hex')}`
    const currentPrompt = 'Return exactly the text of the earlier tool result, with no spaces or other words.'
    const synthetic = compileBoxCliSyntheticTurn({
      model: 'claude-opus-5-5', max_tokens: 128, stream: true,
      system: 'Synthetic OCV5-289 protocol test. Prior tool result is authoritative.',
      messages: [
        { role: 'user', content: 'Earlier synthetic fixture turn.' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_hist_289',
          name: 'mcp__fixture__local_echo', input: { value: 'ping' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_hist_289',
          content: [{ type: 'text', text: nonce }] }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Tool result received.' }] },
        { role: 'user', content: currentPrompt },
      ],
    } as ProxyBody, { cwd: directory, cliVersion: '2.1.280' })
    const supervisorAsset = readFileSync(new URL('./box_supervisor.py', import.meta.url))
    const supervisorHash = createHash('sha256').update(supervisorAsset).digest('hex')
    const supervisorPath = `/tmp/ocv5-289-supervisor-${supervisorHash.slice(0, 16)}.py`
    const stageSupervisor = String.raw`import base64,hashlib,os,stat,sys
p,encoded,want=sys.argv[1:]
raw=base64.b64decode(encoded,validate=True)
if len(raw)>32768 or hashlib.sha256(raw).hexdigest()!=want:raise SystemExit(1)
try:fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
except FileExistsError:pass
else:
 try:os.write(fd,raw);os.fsync(fd)
 finally:os.close(fd)
st=os.lstat(p)
if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600:raise SystemExit(1)
if hashlib.sha256(open(p,'rb').read()).hexdigest()!=want:raise SystemExit(1)
print(want)`
    const stagedSupervisor = await runFixed({ command: '/usr/bin/python3',
      args: ['-c', stageSupervisor, supervisorPath, supervisorAsset.toString('base64'), supervisorHash],
      cwd: '/tmp', environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
    if (stagedSupervisor.trim() !== supervisorHash) throw new Error('BOX_HISTORY_SUPERVISOR_STAGE_FAILED')
    const snapshot = Buffer.from(synthetic.snapshotJsonl)
    const snapshotHash = createHash('sha256').update(snapshot).digest('hex')
    const projectDir = `/home/box/.claude/projects/${directory.replaceAll('/', '-')}`
    const remoteSnapshot = `${projectDir}/${synthetic.sessionId}.jsonl`
    const stageSnapshot = String.raw`import base64,hashlib,os,stat,sys
cwd,project,path,encoded,want=sys.argv[1:]
if not cwd.startswith('/tmp/ocv5-289-run-') or not project.startswith('/home/box/.claude/projects/-tmp-ocv5-289-run-'):raise SystemExit(1)
raw=base64.b64decode(encoded,validate=True)
if len(raw)>32768 or hashlib.sha256(raw).hexdigest()!=want:raise SystemExit(1)
os.mkdir(cwd,0o700);os.mkdir(project,0o700)
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try:os.write(fd,raw);os.fsync(fd)
finally:os.close(fd)
st=os.lstat(path)
if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600:raise SystemExit(1)
print(hashlib.sha256(open(path,'rb').read()).hexdigest())`
    const staged = await runFixed({ command: '/usr/bin/python3',
      args: ['-c', stageSnapshot, directory, projectDir, remoteSnapshot,
        snapshot.toString('base64'), snapshotHash], cwd: '/tmp',
      environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
    if (staged.trim() !== snapshotHash) throw new Error('BOX_HISTORY_SNAPSHOT_STAGE_FAILED')
    let remoteCompleted = false
    try {
      const output = await runFixed({ command: '/usr/bin/python3', cwd: directory, timeoutMs: 45_000,
        args: [supervisorPath, '--deadline', '35', '--kill-after', '2', '--max-output', '262144', '--',
          MODEL, '-p', currentPrompt, '--resume', synthetic.sessionId, '--model', 'claude-opus-5-5',
          '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
          '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config',
          '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
          '--disable-slash-commands', '--no-session-persistence',
          '--system-prompt', synthetic.systemPrompt],
        environment: { HOME: '/home/box', PATH: '/home/box/.local/bin:/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
      remoteCompleted = true
      let records: Array<Record<string, unknown>>
      try { records = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) }
      catch { throw new Error('BOX_HISTORY_STREAM_INVALID') }
      const init = records.find((record) => record.type === 'system' && record.subtype === 'init') as {
        tools?: unknown; mcp_servers?: unknown
      } | undefined
      const final = records.findLast((record) => record.type === 'result') as {
        subtype?: unknown; is_error?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown }
      } | undefined
      const text = records.filter((record) => record.type === 'assistant').flatMap((record) => {
        const content = (record.message as { content?: unknown } | undefined)?.content
        return Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text) : []
      }).join('')
      if (!init || !Array.isArray(init.tools) || init.tools.length !== 0
        || !Array.isArray(init.mcp_servers) || init.mcp_servers.length !== 0
        || final?.subtype !== 'success' || final.is_error !== false || text !== nonce
        || !Number.isSafeInteger(final.usage?.input_tokens) || Number(final.usage?.input_tokens) < 0
        || !Number.isSafeInteger(final.usage?.output_tokens) || Number(final.usage?.output_tokens) < 0) {
        throw new Error('BOX_HISTORY_CONTRACT_FAILED')
      }
      historyReplay = { exact: true, completedToolHistory: true, inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens, snapshotHash: snapshotHash.slice(0, 16),
        supervisorHash: supervisorHash.slice(0, 16) }
    } finally {
      if (!remoteCompleted) process.stderr.write('BOX_HISTORY_REMOTE_UNKNOWN_RETAINED\n')
      else {
        const cleanup = String.raw`import os,stat,sys
cwd,project,path=sys.argv[1:]
for d in (cwd,project):
 st=os.lstat(d)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(1)
os.unlink(path);os.rmdir(project);os.rmdir(cwd);print('clean')`
        const cleaned = await runFixed({ command: '/usr/bin/python3',
          args: ['-c', cleanup, directory, projectDir, remoteSnapshot], cwd: '/tmp',
          environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
        if (cleaned.trim() !== 'clean') throw new Error('BOX_HISTORY_CLEANUP_FAILED')
      }
    }
    })
  }
  process.stdout.write(JSON.stringify({ accountId: ACCOUNT_ID, route: 'box-exec-direct', summaries,
    ...(parallelExec ? { parallelExec } : {}), ...(inference ? { inference } : {}),
    ...(toolRoundtrip ? { toolRoundtrip } : {}), ...(historyReplay ? { historyReplay } : {}) }) + '\n')
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
