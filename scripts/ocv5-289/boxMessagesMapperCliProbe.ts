/** Offline same-version Claude CLI contract for the production mapper.
 * No Box credential, real user content or paid upstream is used here.
 */
import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileBoxCliSyntheticTurn } from '../../packages/commercial/src/http/proxy/boxMessagesMapper.js'
import { completedBoxCliToSse } from '../../packages/commercial/src/http/proxy/boxCliSse.js'
import type { ProxyBody } from '../../packages/commercial/src/http/proxy/shared.js'

const cwd = `/tmp/ocv5-289-run-${randomBytes(12).toString('hex')}`
if (execFileSync('/usr/local/bin/claude', ['--version'], { encoding: 'utf8' }).trim()
  !== '2.1.280 (Claude Code)') throw new Error('CLI_VERSION_NOT_PINNED')
const config = join(cwd, 'config')
mkdirSync(config, { recursive: true, mode: 0o700 })
const nonce = `local-${randomBytes(8).toString('hex')}`
const body = {
  model: 'claude-opus-5-5', max_tokens: 256, stream: true,
  system: 'OpenClaude memory and skills: synthetic fixture only',
  messages: [
    { role: 'user', content: 'prior question' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fixture_289',
      name: 'mcp__fixture__local_echo', input: { value: 'ping' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture_289',
      content: [{ type: 'text', text: nonce }] }] },
    { role: 'assistant', content: [{ type: 'text', text: `prior-${nonce}` }] },
    { role: 'user', content: [{ type: 'text', text: 'current question' }] },
    { role: 'system', content: 'OpenClaude current-turn context' },
  ],
} as ProxyBody
const compiled = compileBoxCliSyntheticTurn(body, { cwd, cliVersion: '2.1.280' })
const expected = `answer-${nonce}`
let requests = 0, exactHistory = false, exactSystem = false, exactMaxTokens = false
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/v1/messages') {
    res.writeHead(404); res.end(); return
  }
  requests++
  const sent = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  exactMaxTokens = sent.max_tokens === body.max_tokens
  const nonSystem = sent.messages.filter((m: { role: string }) => m.role !== 'system')
  const expectedHistory = (body.messages as Array<{ role: string; content: unknown }>)
    .filter((message) => message.role !== 'system')
    .map(({ role, content }) => ({ role, content }))
  exactHistory = JSON.stringify(nonSystem.map(({ role, content }: { role: string; content: unknown }) =>
    ({ role, content }))) === JSON.stringify(expectedHistory)
  const observedSystem = sent.system
  const expectedLastSystem = { type: 'text', text: compiled.systemPrompt,
    cache_control: { type: 'ephemeral' } }
  exactSystem = Array.isArray(observedSystem) && observedSystem.length === 3
    && Object.keys(observedSystem[0]).sort().join(',') === 'text,type'
    && observedSystem[0].type === 'text'
    && /^x-anthropic-billing-header: cc_version=2\.1\.280\.[a-f0-9]{3}; cc_entrypoint=sdk-cli;$/.test(observedSystem[0].text)
    && JSON.stringify(observedSystem[1]) === JSON.stringify({ type: 'text',
      text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      cache_control: { type: 'ephemeral' } })
    && JSON.stringify(observedSystem[2]) === JSON.stringify(expectedLastSystem)
  const replyText = exactHistory && exactSystem ? expected : 'rejected'
  const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  event('message_start', { type: 'message_start', message: { id: 'msg_mapper', type: 'message',
    role: 'assistant', model: sent.model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 1 } } })
  event('content_block_start', { type: 'content_block_start', index: 0,
    content_block: { type: 'text', text: '' } })
  event('content_block_delta', { type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: replyText } })
  event('content_block_stop', { type: 'content_block_stop', index: 0 })
  event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 4 } })
  event('message_stop', { type: 'message_stop' }); res.end()
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
try {
  const projectKey = cwd.replaceAll('/', '-')
  const snapshot = join(config, 'projects', projectKey, `${compiled.sessionId}.jsonl`)
  mkdirSync(join(config, 'projects', projectKey), { recursive: true, mode: 0o700 })
  let snapshotText = compiled.snapshotJsonl
  let stdinJsonl = compiled.stdinJsonl
  let systemPrompt = compiled.systemPrompt
  const tamper = process.env.OCV5_TEST_MAPPER_TAMPER
  if (tamper) {
    if (!['id', 'result_image', 'user_extra', 'system_order', 'system_extra'].includes(tamper)) {
      throw new Error('NEGATIVE_MODE_INVALID')
    }
    if (tamper === 'id') snapshotText = snapshotText.replace('"tool_use_id":"toolu_fixture_289"',
      '"tool_use_id":"toolu_wrong_289"')
    if (tamper === 'result_image') snapshotText = snapshotText.replace(
      `"type":"text","text":"${nonce}"`,
      '"type":"image","source":{"type":"base64","data":"abc"}')
    if (tamper === 'user_extra') {
      const current = JSON.parse(stdinJsonl)
      current.message.content.push({ type: 'text', text: 'extra injected user text' })
      stdinJsonl = JSON.stringify(current) + '\n'
    }
    if (tamper === 'system_order') systemPrompt = 'OpenClaude current-turn context\n\nOpenClaude memory and skills: synthetic fixture only'
    if (tamper === 'system_extra') systemPrompt += '\n\nextra injected system instruction'
    if (snapshotText === compiled.snapshotJsonl && stdinJsonl === compiled.stdinJsonl
      && systemPrompt === compiled.systemPrompt) throw new Error('NEGATIVE_FIXTURE_NOT_APPLIED')
  }
  writeFileSync(snapshot, snapshotText, { mode: 0o600, flag: 'wx' })
  const stdinPath = join(cwd, 'stdin.jsonl')
  writeFileSync(stdinPath, stdinJsonl, { mode: 0o600, flag: 'wx' })
  const systemPath = join(cwd, 'system.txt')
  writeFileSync(systemPath, systemPrompt, { mode: 0o600, flag: 'wx' })
  const stdinHash = createHash('sha256').update(stdinJsonl).digest('hex')
  const child = spawn('/usr/bin/python3', [
    fileURLToPath(new URL('./box_supervisor.py', import.meta.url)),
    '--deadline', '15', '--kill-after', '1', '--max-output', '262144',
    '--stdin-file', stdinPath, '--stdin-sha256', stdinHash, '--',
    '/usr/local/bin/claude', '-p', '--resume', compiled.sessionId,
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--include-partial-messages', '--verbose', '--no-session-persistence',
    '--model', 'claude-opus-5-5', '--tools', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands',
    '--system-prompt-file', systemPath], {
    cwd, env: { HOME: cwd, CLAUDE_CONFIG_DIR: config, PATH: '/usr/local/bin:/usr/bin:/bin',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      ANTHROPIC_AUTH_TOKEN: 'fixture-only', CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(body.max_tokens),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_PROXY: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderrBytes = 0
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { stderrBytes += chunk.length })
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  const exit = await new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)))
  clearTimeout(timer)
  const records = stdout.split(/\r?\n/).flatMap((line) => {
    try { return line ? [JSON.parse(line)] : [] } catch { return [] }
  })
  const final = records.findLast((record) => record.type === 'result')
  const converted = exit === 0 ? completedBoxCliToSse(stdout, 'claude-opus-5-5') : null
  const good = exit === 0 && requests === 1 && exactHistory && exactSystem && exactMaxTokens
    && final?.is_error === false && final?.result === expected
    && converted?.sse.includes('event: message_stop') === true
  process.stdout.write(JSON.stringify({ exit, requests, exactHistory, exactSystem, exactMaxTokens,
    finalSuccess: final?.is_error === false, textExact: final?.result === expected,
    sseBytes: converted?.sse.length ?? 0, stderrBytes }) + '\n')
  if (!good) process.exitCode = 1
} finally {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(cwd, { recursive: true, force: true })
}
