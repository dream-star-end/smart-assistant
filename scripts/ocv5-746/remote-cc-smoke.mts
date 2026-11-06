/**
 * OCV5-746 node smoke: drives a real remote interactive Claude Code through the same
 * Cc5SshHost the gateway uses. Round 1 sends several turns into one live CLI; the host is
 * then stopped with the remote absence proof and round 2 starts again on the same task root,
 * which must resume the same native session. No relay, finance or tool calls are involved.
 *
 * Run as the account that owns the key (root on the master host):
 *   tsx scripts/ocv5-746/remote-cc-smoke.mts <config.json>
 * config: { host, user, keyPath, knownHostsPath, controllerPath, taskRoot, operationId, runId,
 *           upstreamModel, profileDir?, toolSocketPath, rounds: string[][] }
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { Cc5SshHost, defaultRemoteCcTarget } from '../../packages/gateway/src/cc5SshHost.ts'

const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const target = Object.freeze({
  ...defaultRemoteCcTarget({
    user: config.user,
    keyPath: config.keyPath,
    knownHostsPath: config.knownHostsPath,
    controllerPath: config.controllerPath,
    upstreamModel: config.upstreamModel,
  }),
  host: config.host,
  ...(config.profileDir ? { profileDir: config.profileDir } : {}),
})

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }))
}

// Stand-in for the relay's tool server: every tool call gets a well-formed error receipt.
let toolCalls = 0
if (existsSync(config.toolSocketPath)) unlinkSync(config.toolSocketPath)
const tools = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    toolCalls++
    log({ tool: body.name, toolUseId: body.toolUseId })
    const receipt = {
      version: 2, ok: true, runId: body.runId, operationId: body.operationId, rpcId: body.rpcId,
      toolUseId: body.toolUseId, name: body.name, inputSha256: body.inputSha256,
      result: { content: [{ type: 'text', text: 'Tools are disabled in this smoke test; answer directly.' }], isError: true },
    }
    const bytes = Buffer.from(JSON.stringify(receipt))
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length })
    res.end(bytes)
  })
})
await new Promise<void>((resolve) => tools.listen(config.toolSocketPath, resolve))

async function round(index: number, prompts: string[]): Promise<void> {
  const host = new Cc5SshHost({
    target,
    taskRoot: config.taskRoot,
    operationId: config.operationId,
    runId: config.runId,
    controllerPath: config.controllerPath,
    toolSocketPath: config.toolSocketPath,
  })
  const started = Date.now()
  if (config.provisionPacketPath) {
    // The lane runtime's first step: reset whatever an earlier owner left, then provision the root.
    await host.prepareTask(readFileSync(config.provisionPacketPath))
    log({ round: index, phase: 'prepared', ms: Date.now() - started })
  }
  const { stdin, stdout, ready } = host.start()
  const frames = createInterface({ input: stdout })[Symbol.asyncIterator]()
  await ready
  log({ round: index, phase: 'ready', ms: Date.now() - started })
  let nativeSession: string | undefined
  for (const [turn, prompt] of prompts.entries()) {
    const sent = Date.now()
    stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`)
    let firstFrame: number | undefined
    let firstText: number | undefined
    let text = ''
    for (;;) {
      const next = await frames.next()
      if (next.done) throw new Error('remote output ended before result')
      if (!next.value.trim()) continue
      const row = JSON.parse(next.value)
      firstFrame ??= Date.now() - sent
      if (typeof row.session_id === 'string') {
        if (nativeSession && nativeSession !== row.session_id) throw new Error('native session changed inside a round')
        nativeSession = row.session_id
      }
      const delta = row.type === 'stream_event' && row.event?.delta?.type === 'text_delta' ? row.event.delta.text : undefined
      const blocks = row.type === 'assistant' && Array.isArray(row.message?.content)
        ? row.message.content.filter((b: { type?: string }) => b?.type === 'text').map((b: { text: string }) => b.text).join('')
        : ''
      if ((delta || blocks) && firstText === undefined) firstText = Date.now() - sent
      if (row.type === 'result') {
        text = typeof row.result === 'string' ? row.result : blocks
        log({ round: index, turn: turn + 1, firstFrameMs: firstFrame, firstTextMs: firstText,
          resultMs: Date.now() - sent, isError: row.is_error, subtype: row.subtype,
          model: row.modelUsage ? Object.keys(row.modelUsage) : undefined, nativeSession, reply: text.slice(0, 200) })
        break
      }
    }
  }
  const stopping = Date.now()
  const proof = await host.stop()
  log({ round: index, phase: 'stopped', remoteStopped: proof.remoteStopped, ms: Date.now() - stopping })
}

for (const [index, prompts] of (config.rounds as string[][]).entries()) await round(index + 1, prompts)
log({ phase: 'done', toolCalls })
process.exit(0)
