/** Run only in an isolated --network none container. Uses no credentials and a loopback fake provider. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
const rounds = []
for (let round = 1; round <= 3; round++) {
  const counts = { getModels: 0, inferencePosts: 0, otherRequests: 0 }
  const server = createServer((req, res) => {
    req.resume()
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (req.method === 'GET' && path.endsWith('/models')) counts.getModels++
    else if (req.method === 'POST' && (path.endsWith('/responses') || path.endsWith('/chat/completions'))) counts.inferencePosts++
    else counts.otherRequests++
    res.setHeader('content-type', 'application/json')
    if (req.method !== 'GET') { res.writeHead(403); res.end('{"error":{"message":"isolated probe forbids inference"}}'); return }
    res.end('{"models":[],"data":[]}')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = '/tmp/g496-probe-' + round
  await mkdir(home + '/codex', { recursive: true })
  const args = ['app-server', '-c', 'model="gpt-6.1-sol"', '-c', 'model_provider="probe"',
    '-c', 'model_providers.probe.name="Isolated probe"',
    '-c', 'model_providers.probe.base_url="http://127.0.0.1:' + port + '/v1"',
    '-c', 'model_providers.probe.wire_api="responses"',
    '-c', 'model_providers.probe.requires_openai_auth=false',
    '-c', 'check_for_update_on_startup=false', '--listen', 'stdio://']
  const proc = spawn('codex', args, { cwd: home, env: {
    PATH: process.env.PATH, HOME: home, CODEX_HOME: home + '/codex', RUST_LOG: 'warn',
  }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = '', id = 0, stage = 'initialize'
  const pending = new Map()
  proc.stderr.on('data', b => { if (stderr.length < 65536) stderr += b.toString() })
  const lines = createInterface({ input: proc.stdout })
  lines.on('line', line => {
    let data
    try { data = JSON.parse(line) } catch { return }
    const item = pending.get(data.id)
    if (!item) return
    pending.delete(data.id); clearTimeout(item.timer)
    if (data.error) item.reject(Object.assign(Error('RPC_ERROR'), { rpcCode: data.error.code }))
    else item.resolve(data.result)
  })
  proc.on('exit', code => {
    for (const item of pending.values()) {
      clearTimeout(item.timer); item.reject(Object.assign(Error('CLI_EXIT'), { exitCode: code }))
    }
    pending.clear()
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => { pending.delete(key); reject(Error('RPC_TIMEOUT')) }, 20000)
    pending.set(key, { resolve, reject, timer })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n')
  })
  const status = async () => {
    // npm CLI launchers may retain a Node parent; measure the complete owned tree.
    const visit = async pid => {
      try {
        const s = await readFile('/proc/' + pid + '/status', 'utf8')
        const stat = (await readFile('/proc/' + pid + '/stat', 'utf8')).replace(/^.*\\) /, '').split(' ')
        const children = (await readFile('/proc/' + pid + '/task/' + pid + '/children', 'utf8')).trim().split(/\\s+/).filter(Boolean)
        const totals = { processCount: 1, rssKiB: Number(s.match(/^VmRSS:\\s+(\\d+)/m)?.[1] || 0),
          cpuTicks: Number(stat[11]) + Number(stat[12]) }
        for (const child of children) {
          const values = await visit(child)
          totals.processCount += values.processCount; totals.rssKiB += values.rssKiB; totals.cpuTicks += values.cpuTicks
        }
        return totals
      } catch { return { processCount: 0, rssKiB: 0, cpuTicks: 0 } }
    }
    return visit(proc.pid)
  }
  try {
    const started = performance.now()
    await rpc('initialize', { clientInfo: { name: 'g496-offline-prewarm', version: '1.0.0' }, capabilities: { experimentalApi: true } })
    const initialized = performance.now()
    proc.stdin.write('{"jsonrpc":"2.0","method":"initialized","params":{}}\n')
    stage = 'thread/start'
    const thread = await rpc('thread/start', { approvalPolicy: 'never', sandbox: 'read-only', cwd: home, model: 'gpt-6.1-sol' })
    const ready = performance.now()
    const before = await status()
    await new Promise(r => setTimeout(r, 2000))
    const after = await status()
    const result = { round, initializeMs: initialized - started, threadMs: ready - initialized,
      readyMs: ready - started, processCount: after.processCount, rssKiB: after.rssKiB, idleWindowMs: performance.now() - ready,
      idleCpuTicks: after.cpuTicks - before.cpuTicks, freshThread: typeof thread?.thread?.id === 'string', ...counts }
    if (!result.freshThread || counts.inferencePosts !== 0) throw Error('PREWARM_NO_INFERENCE_CONTRACT_FAILED')
    rounds.push(result)
  } catch (err) {
    console.log(JSON.stringify({ round, failed: true, stage, rpcCode: err.rpcCode ?? null, exitCode: err.exitCode ?? null,
      errorKind: ['config','auth','model','provider'].find(x => stderr.toLowerCase().includes(x)) || 'unknown', ...counts }))
    process.exitCode = 1
  } finally {
    proc.kill('SIGTERM')
    await new Promise(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      proc.once('exit', resolve)
      setTimeout(() => proc.kill('SIGKILL'), 2000).unref()
    })
    lines.close()
    await new Promise(r => server.close(r))
  }
  if (process.exitCode) break
}
if (!process.exitCode) console.log(JSON.stringify({ mode: 'isolated-loopback-no-credentials', rounds,
  totalInferencePosts: rounds.reduce((n, r) => n + r.inferencePosts, 0) }))
