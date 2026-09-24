/** Offline real Claude CLI + supervisor + Python MCP rendezvous contract. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync('/tmp/ocv5-289-tool-')
const nonce = `local-${randomBytes(8).toString('hex')}`
const modelId = 'toolu_fixture_289'
const sessionId = randomUUID()
const resumedText = `resumed-${nonce}`
const mcpConfig = join(root, 'mcp.json')
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { fixture: {
  type: 'stdio', command: '/usr/bin/python3',
  args: [fileURLToPath(new URL('./virtual_tool_mcp.py', import.meta.url)), root],
} } }), { mode: 0o600 })
let requests = 0, returned = false, advertised = false, resumedHistory = false
let historyShape = null, resumedActualText = null
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (new URL(req.url, 'http://127.0.0.1').pathname !== '/v1/messages') {
    res.writeHead(404); res.end(); return
  }
  requests++
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (requests === 3) {
    historyShape = body.messages?.flatMap((message, index) => Array.isArray(message.content)
      ? message.content.filter((block) => ['tool_use', 'tool_result'].includes(block?.type))
        .map((block) => ({ index, role: message.role, block })) : []) ?? []
    const use = historyShape[0], result = historyShape[1]
    const content = result?.block?.content
    resumedActualText = Array.isArray(content) && content.length === 1
      && content[0]?.type === 'text' && typeof content[0].text === 'string'
      ? content[0].text : null
    resumedHistory = historyShape.length === 2
      && use?.role === 'assistant' && result?.role === 'user' && use.index < result.index
      && use.block.type === 'tool_use' && result.block.type === 'tool_result'
      && use.block.id === modelId && use.block.name === 'mcp__fixture__local_echo'
      && JSON.stringify(use.block.input) === '{"value":"ping"}'
      && result.block.tool_use_id === modelId && result.block.is_error !== true
      && resumedActualText === nonce
  }
  const toolName = body.tools?.find((tool) => String(tool.name).endsWith('local_echo'))?.name
  advertised ||= body.tools?.length === 1 && Boolean(toolName)
  const toolResults = body.messages?.flatMap((m) => m.role === 'user' && Array.isArray(m.content)
    ? m.content.filter((c) => c?.type === 'tool_result') : []) ?? []
  const actualContent = toolResults[0]?.content
  const actualText = typeof actualContent === 'string' ? actualContent
    : Array.isArray(actualContent) && actualContent.length === 1
      && actualContent[0]?.type === 'text' && typeof actualContent[0].text === 'string'
      ? actualContent[0].text : null
  // Negative fixture mutates only the observed error bit, not the nonce.
  const observedError = process.env.OCV5_TEST_MUTATE_ERROR === '1'
    || toolResults[0]?.is_error === true
  returned = toolResults.length === 1 && toolResults[0].tool_use_id === modelId
    && !observedError && actualText === nonce
  const isTool = requests === 1
  const block = isTool ? { type: 'tool_use', id: modelId, name: toolName, input: {} }
    : { type: 'text', text: '' }
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  event('message_start', { type: 'message_start', message: {
    id: `msg_fixture_${requests}`, type: 'message', role: 'assistant', model: body.model,
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 30, output_tokens: 1 },
  } })
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: block })
  event('content_block_delta', { type: 'content_block_delta', index: 0,
    delta: isTool ? { type: 'input_json_delta', partial_json: '{"value":"ping"}' }
      : { type: 'text_delta', text: requests === 3
        ? (resumedHistory ? `resumed-${resumedActualText}` : 'rejected')
        : (returned ? actualText : 'rejected') } })
  event('content_block_stop', { type: 'content_block_stop', index: 0 })
  event('message_delta', { type: 'message_delta',
    delta: { stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 8 } })
  event('message_stop', { type: 'message_stop' }); res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const args = ['-p', `Call fixture local_echo with value ping then answer.`, '--model', 'claude-opus-5-5',
  '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--tools', '',
  '--strict-mcp-config', '--mcp-config', mcpConfig, '--allowedTools', 'mcp__fixture__local_echo',
  '--setting-sources', '', '--disable-slash-commands', '--session-id', sessionId]
const child = spawn('/usr/bin/python3', [
  fileURLToPath(new URL('./box_supervisor.py', import.meta.url)), '--deadline', '20',
  '--kill-after', '1', '--max-output', '262144', '--', '/usr/local/bin/claude', ...args,
], { cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config'),
    PATH: '/usr/local/bin:/usr/bin:/bin', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_AUTH_TOKEN: 'fixture-only-not-real', CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_PROXY: '127.0.0.1,localhost',
    OCV5_SUPERVISOR_TOOL_EVENT_FILE: join(root, 'event.json') },
  stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = '', stderrBytes = 0, closed = false
child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
child.stderr.on('data', (chunk) => { stderrBytes += chunk.length })
const done = new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', (code, signal) => { closed = true; resolve({ code, signal }) })
})
let event = null, pending = null, delivered = false
const deadline = Date.now() + 17000
try {
  while (!closed && Date.now() < deadline && !(event && pending)) {
    if (existsSync(join(root, 'event.json'))) event = JSON.parse(readFileSync(join(root, 'event.json'), 'utf8'))
    if (existsSync(join(root, 'pending.json'))) pending = JSON.parse(readFileSync(join(root, 'pending.json'), 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (event && pending && event.modelToolUseId === modelId
      && event.name === 'mcp__fixture__local_echo' && event.input?.value === 'ping'
      && pending.name === 'local_echo' && pending.arguments?.value === 'ping') {
    const temporary = join(root, 'result.tmp')
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ mcpRequestId: pending.mcpRequestId,
        modelToolUseId: event.modelToolUseId,
        text: process.env.OCV5_TEST_CORRUPT_RESULT === '1' ? `CORRUPT:${nonce}` : nonce,
      }))
      fsyncSync(fd)
      linkSync(temporary, join(root, 'result.json'))
    } finally { closeSync(fd); unlinkSync(temporary) }
    delivered = true
  }
  const exit = await done
  const records = stdout.split(/\r?\n/).flatMap((line) => { try { return line ? [JSON.parse(line)] : [] } catch { return [] } })
  const final = records.findLast((record) => record.type === 'result')
  const assistant = records.filter((record) => record.type === 'assistant')
    .flatMap((record) => record.message?.content?.filter((block) => block.type === 'text').map((block) => block.text) ?? [])
  const sourceConfig = join(root, 'config')
  let sessionFile = null
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name === `${sessionId}.jsonl`) sessionFile = path
    }
  }
  visit(sourceConfig)
  if (!sessionFile) throw new Error('SESSION_FILE_MISSING')
  const secondHome = mkdtempSync('/tmp/ocv5-289-resumed-home-')
  let resume = null
  try {
    const target = join(secondHome, 'config', sessionFile.slice(sourceConfig.length + 1))
    mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true })
    copyFileSync(sessionFile, target)
    const negative = process.env.OCV5_TEST_RESUME_CORRUPT
    if (negative) {
      if (!['id', 'text', 'args', 'error'].includes(negative)) throw new Error('NEGATIVE_MODE_INVALID')
      let changed = 0
      const mutate = (value) => {
        if (!value || typeof value !== 'object') return
        if (value.type === 'tool_use' && value.id === modelId && negative === 'args') {
          value.input = { value: 'wrong' }; changed++
        }
        if (value.type === 'tool_result' && value.tool_use_id === modelId) {
          if (negative === 'id') { value.tool_use_id = 'toolu_wrong_289'; changed++ }
          if (negative === 'error') { value.is_error = true; changed++ }
          if (negative === 'text' && Array.isArray(value.content)) {
            for (const part of value.content) {
              if (part?.type === 'text' && part.text === nonce) {
                part.text = `CORRUPT:${nonce}`; changed++
              }
            }
          }
        }
        for (const item of Object.values(value)) mutate(item)
      }
      const original = readFileSync(target, 'utf8')
      const corrupted = original.split(/\r?\n/).map((line) => {
        if (!line) return ''
        const value = JSON.parse(line); mutate(value); return JSON.stringify(value)
      }).join('\n')
      if (changed < 1) throw new Error('NEGATIVE_FIXTURE_NOT_APPLIED')
      writeFileSync(target, corrupted)
    }
    const resumed = spawn('/usr/local/bin/claude', ['-p', 'Second synthetic turn.',
      '--resume', sessionId, '--model', 'claude-opus-5-5', '--output-format', 'stream-json',
      '--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--disable-slash-commands'], {
      cwd: root, env: { HOME: secondHome, CLAUDE_CONFIG_DIR: join(secondHome, 'config'),
        PATH: '/usr/local/bin:/usr/bin:/bin', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        ANTHROPIC_AUTH_TOKEN: 'fixture-only-not-real', CLAUDE_CODE_MAX_RETRIES: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_PROXY: '127.0.0.1,localhost' },
      stdio: ['ignore', 'pipe', 'pipe'] })
    let resumedStdout = ''
    resumed.stdout.on('data', (chunk) => { resumedStdout += chunk.toString('utf8') })
    resumed.stderr.resume()
    const resumedTimer = setTimeout(() => resumed.kill('SIGKILL'), 12000)
    const resumeExit = await new Promise((resolve) => resumed.once('close', (code) => resolve(code)))
    clearTimeout(resumedTimer)
    const resumedRecords = resumedStdout.split(/\r?\n/).flatMap((line) => {
      try { return line ? [JSON.parse(line)] : [] } catch { return [] }
    })
    const resumedFinal = resumedRecords.findLast((record) => record.type === 'result')
    resume = { exit: resumeExit, sameSession: resumedFinal?.session_id === sessionId,
      finalSuccess: resumedFinal?.is_error === false, textExact: resumedFinal?.result === resumedText,
      historyToolPair: resumedHistory }
  } finally { rmSync(secondHome, { recursive: true, force: true }) }
  console.log(JSON.stringify({ exit, requests, advertised, returned, delivered, resume,
    historyShape: historyShape?.map((part) => ({ index: part.index, role: part.role,
      type: part.block.type, id: part.block.id ?? part.block.tool_use_id })),
    modelId: event?.modelToolUseId ?? null, mcpRequestId: pending?.mcpRequestId ?? null,
    distinctIds: event?.modelToolUseId !== pending?.mcpRequestId,
    finalSuccess: final?.is_error === false, textExact: assistant.includes(nonce), stderrBytes }))
  if (exit.code !== 0 || requests !== 3 || !advertised || !delivered
      || !assistant.includes(nonce) || final?.is_error !== false
      || resume?.exit !== 0 || !resume.sameSession || !resume.finalSuccess
      || !resume.textExact || !resume.historyToolPair) process.exitCode = 1
} finally {
  if (!closed) child.kill('SIGTERM')
  await Promise.race([done.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2000))])
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
