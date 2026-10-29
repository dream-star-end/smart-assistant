/** oc-bridge: lets the OpenClaude gateway drive an interactive Claude Code
 * session over the same stream-json contract as Route B's `claude -p`.
 *
 * In:  the Box host's tap child streams gateway lines; user messages become
 *      `$.prompt.submit({ asUser: true })`, interrupts `$.turn.abort`.
 * Out: hooks become stream-json lines POSTed to the host's Unix socket,
 *      which prints them on the launch exec's stdout.
 *
 * Inert unless OC_BRIDGE_DIR is set (the host sets it for product sessions). */
import type { Register } from 'claude-code'
import { StreamJson, textOfUserContent, type StepChunk } from './frames.ts'

// Tools a person must answer. Route B shows them in web through can_use_tool
// even under bypassPermissions; here the bridge answers them the same way.
const PERSON_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const BATCH_BYTES = 256 * 1024
// Print mode (OCV5-378): attachments the CLI adds about the machine it runs on and the login it
// runs under. The Box only serves the model request; the environment the model works in is the
// user container's, described by the container's own system prompt.
const BOX_CONTEXT = new Set(['environment', 'session_context'])

export const register: Register = (on) => {
  const sj = new StreamJson()
  let sock = ''
  /** The host's capability for this session; tools never see it. */
  let auth: Record<string, string> = {}
  let active = false
  let running: string | undefined
  let lastStopReason: string | null = null
  const queue: string[] = []
  let wake: (() => void) | null = null
  let decisionSeq = 0
  /** Interrupts the tap saw; the session.start loop that owns `$` runs them. */
  const aborts: string[] = []
  /** Print mode (OC_BRIDGE_MODE=print, set by the host for the Box model route): the session speaks
   * `claude -p`'s exact stream-json, streamed as each step runs (see StreamJson.printStart). */
  let print = false
  let printInit: { tools: string[]; mcp_servers: { name: string; status: string }[] } = { tools: [], mcp_servers: [] }
  let initSent = false
  /** The main-loop step being streamed, until its stop chunk (StreamJson.printStart..printStop). */
  let printing: { stopped: boolean } | null = null
  /** Non-response rows (tool results) that arrive before the step stops; they follow it, as on `-p`. */
  const held: string[] = []
  const stopPrint = (stop: { stopReason: string | null; usage: any }): void => {
    if (!printing || printing.stopped) return
    printing.stopped = true
    lastStopReason = stop.stopReason ?? null
    send(sj.printStop(stop))
    if (held.length > 0) send(held.splice(0))
  }

  const send = (lines: string[]): void => {
    if (!active || lines.length === 0) return
    queue.push(...lines)
    wake?.()
  }
  const nextBatch = (): { body: string; n: number } | null => {
    if (queue.length === 0) return null
    let n = 0
    let size = 0
    while (n < queue.length && (n === 0 || size + queue[n]!.length < BATCH_BYTES)) {
      size += queue[n]!.length + 1
      n++
    }
    return { body: `${queue.slice(0, n).join('\n')}\n`, n }
  }
  const idle = (): Promise<void> => new Promise((resolve) => { wake = () => { wake = null; resolve() } })
  const permRequest = (tool: string, input: unknown, toolUseId: string | undefined): string => {
    decisionSeq += 1
    const requestId = `ocb-perm-${decisionSeq}-${toolUseId ?? 'q'}`
    send([sj.canUseTool(requestId, tool, input, toolUseId)])
    return requestId
  }
  const decisionOf = (status: number, text: string): { done: boolean; value: any } => {
    if (status === 204) return { done: false, value: null }
    if (status !== 200) return { done: true, value: null }
    try {
      return { done: true, value: JSON.parse(text)?.response?.response ?? null }
    } catch {
      return { done: true, value: null }
    }
  }

  // Only the bridge and the CLI's own bundled plugins load into a product
  // session (Route B parity: the Box profile enables none today).
  on('plugin.register', async ($, e, next) => {
    const dir = await $.env.get('OC_BRIDGE_DIR')
    if (!dir) return next(e)
    if (e.provenance.endsWith('@builtin') || (e.name === 'oc-bridge' && e.provenance === 'oc-bridge@inline')) {
      sj.plugins.push(e.name)
      return next(e)
    }
    return { refuse: 'oc-bridge: a product session admits no other plugin' }
  }).catch(($, e, next) => (next.called ? next(e) : { refuse: 'oc-bridge: plugin guard failed' }))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const dir = await $.env.get('OC_BRIDGE_DIR')
    if (!dir) return started
    sock = `${dir}/bridge.sock`
    // Read once; the host deletes the file at our first request, before any
    // tool can run, and accepts requests only from this process.
    const token = (await $.fs.read(`${dir}/token`)).trim()
    auth = { 'x-oc-bridge-token': token }
    active = true
    sj.sessionId = await $.session.id()
    sj.model = await $.session.model()
    sj.cwd = e.cwd
    sj.version = (await $.env.get('OC_BRIDGE_CLI_VERSION')) ?? ''
    sj.permissionMode = (await $.env.get('OC_BRIDGE_PERMISSION_MODE')) ?? 'default'
    print = (await $.env.get('OC_BRIDGE_MODE')) === 'print'
    if (print) {
      try {
        const declared = JSON.parse((await $.env.get('OC_BRIDGE_INIT')) ?? '{}')
        printInit = { tools: Array.isArray(declared.tools) ? declared.tools.map(String) : [],
          mcp_servers: Array.isArray(declared.mcp_servers) ? declared.mcp_servers : [] }
      } catch {
        printInit = { tools: [], mcp_servers: [] }
      }
    }
    if (!sj.plugins.includes('oc-bridge')) sj.plugins.unshift('oc-bridge')

    // Sender: one loop, so order is the hooks' order and no hook waits on I/O.
    void (async () => {
      let failures = 0
      for (;;) {
        while (aborts.length > 0) {
          const turnId = aborts.shift()!
          await $.turn.abort({ turnId }).catch(() => undefined)
        }
        const batch = nextBatch()
        if (!batch) {
          await idle()
          continue
        }
        try {
          const res = await $.http.fetch('http://bridge/out', { method: 'POST', socketPath: sock, headers: auth, body: batch.body })
          if (!res.ok) throw new Error(`status ${res.status}`)
          queue.splice(0, batch.n)
          failures = 0
        } catch {
          failures++
          await $.clock.sleep(Math.min(2000, 50 * failures))
        }
      }
    })()

    // Ready first: the host relays no gateway line before it, so a session
    // that never gets here has seen none and the bridge can replay them on -p.
    await $.http.fetch('http://bridge/ready', {
      method: 'POST',
      socketPath: sock,
      headers: auth,
      body: JSON.stringify({ sessionId: sj.sessionId, model: sj.model, isInteractive: e.isInteractive, plugins: sj.plugins }),
    })
    // Tap: the host streams gateway lines to this child's stdout.
    void (async () => {
      let buf = ''
      for await (const piece of $.process.spawn({ argv: ['python3', `${dir}/tap.py`, sock], input: `${token}\n` })) {
        if (piece.stream !== 'stdout') continue
        buf += piece.text
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          let msg: any
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          if (msg?.type === 'user') {
            const raw = textOfUserContent(msg.message?.content)
            if (!raw.trim()) continue
            // The engine refuses a plugin prompt that opens with `/` (it would
            // run a command as the user); the text goes to the model instead.
            const text = raw.startsWith('/') ? ` ${raw}` : raw
            // Queued by the engine; its own turn once idle (never folded in).
            $.prompt.submit({ text, asUser: true }).catch((err: unknown) => {
              send([sj.result({ reason: 'error', answer: `oc-bridge: prompt refused: ${String(err)}`, durationMs: 0 }, null)])
            })
          } else if (msg?.type === 'control_request') {
            const subtype = msg.request?.subtype
            if (subtype === 'interrupt') {
              if (running) aborts.push(running)
              send([sj.controlSuccess(String(msg.request_id))])
            } else {
              send([sj.controlError(String(msg.request_id), `unsupported control_request: ${String(subtype)}`)])
            }
          }
        }
      }
    })()

    return started
  })

  on('turn.start', ($, e, next) => {
    if (active) {
      running = e.turnId
      lastStopReason = null
      sj.turnStart()
      // `-p` prints one init per process; Route B's bridge reads one per turn.
      if (!print) send([sj.init()])
      else if (!initSent) send([sj.printInit(printInit.tools, printInit.mcp_servers)])
      initSent = true
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (print && !e.agentId) {
      printing = { stopped: false }
      // The client learns at once that the model is working, as from -p's own message_start.
      send(sj.printStart({ turnId: e.turnId, index: e.index, model: e.model }))
      const stream = next(e) as AsyncGenerator<StepChunk, any>
      let result: any
      for (;;) {
        const item = await stream.next()
        if (item.done) {
          result = item.value
          break
        }
        const c = item.value as StepChunk
        // The stop chunk carries the step's usage and comes before a pending tool returns.
        if (c.kind === 'stop') stopPrint({ stopReason: (c as any).stopReason ?? null, usage: (c as any).usage ?? null })
        else if (!printing.stopped) send(sj.printChunk(c))
        yield item.value as any
      }
      stopPrint({ stopReason: result?.stopReason ?? null, usage: result?.usage ?? null })
      printing = null
      return result
    }
    send(sj.stepStart(e))
    const stream = next(e) as AsyncGenerator<StepChunk, any>
    let res: any
    for (;;) {
      const item = await stream.next()
      if (item.done) {
        res = item.value
        break
      }
      send(sj.chunk(e.agentId, item.value))
      yield item.value as any
    }
    if (!e.agentId && res) lastStopReason = res.stopReason ?? null
    send(sj.stepEnd(e.agentId, res))
    return res
  })

  on('session.append', async ($, e, next) => {
    const m = e.message as any
    if (print && m?.type === 'attachment' && BOX_CONTEXT.has(m.name)) {
      return next({ ...e, message: { ...m, content: [] } } as any)
    }
    const stored = await next(e)
    const row = { door: e.door, uuid: e.uuid, agentId: e.agentId, origin: e.origin, message: stored?.message ?? e.message } as any
    if (print && printing && !printing.stopped && !e.agentId) {
      if (e.door === 'response' && row.message?.type === 'assistant') send(sj.printRow(row))
      else held.push(...sj.row(row))
      return stored
    }
    send(sj.row(row))
    return stored
  })

  on('tool.call', async ($, e, next) => {
    if (!active) return next(e)
    if (!e.agentId && e.tool === 'Agent' && e.tool_use_id) sj.noteAgentCall(e.tool_use_id)
    if (!PERSON_TOOLS.has(e.tool)) return next(e)
    if (print) return { deny: `${e.tool} is not available here.` }
    // The tool's own arguments sit beside the reserved keys on `e`.
    const { tool: _tool, tool_use_id: _id, consent: _consent, agentId: _agent, ...input } = e as any
    const requestId = permRequest(e.tool, input, e.tool_use_id)
    let decision: any = null
    for (;;) {
      if (next.signal.aborted) break
      const res = await $.http.fetch(`http://bridge/decision?id=${encodeURIComponent(requestId)}`, { socketPath: sock, headers: auth })
      const got = decisionOf(res.status, res.text)
      if (got.done) {
        decision = got.value
        break
      }
    }
    if (decision?.behavior !== 'allow') {
      return { deny: decision?.message ?? `The user declined ${e.tool}.` }
    }
    const updated = decision.updatedInput ?? input
    if (e.tool === 'AskUserQuestion') {
      return { result: { questions: updated.questions ?? input.questions ?? [], answers: updated.answers ?? {} } } as any
    }
    return { result: { plan: updated.plan ?? input.plan ?? null, isAgent: false } } as any
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'oc-bridge: could not reach the web for an answer' }))

  // A verdict of `ask` goes to web as Route B's can_use_tool does; no dialog
  // is ever left on the terminal.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (!active || verdict.decision !== 'ask' || !e.tool_use_id || PERSON_TOOLS.has(e.tool)) return verdict
    // Nobody answers a prompt on the Box model route; the launch allows exactly the tools it serves.
    if (print) return { decision: 'deny', reason: 'oc-bridge: not allowed for this session' }
    const requestId = permRequest(e.tool, e.input, e.tool_use_id)
    let decision: any = null
    for (;;) {
      if (next.signal.aborted) break
      const res = await $.http.fetch(`http://bridge/decision?id=${encodeURIComponent(requestId)}`, { socketPath: sock, headers: auth })
      const got = decisionOf(res.status, res.text)
      if (got.done) {
        decision = got.value
        break
      }
    }
    return decision?.behavior === 'allow'
      ? { decision: 'allow', reason: 'approved in web' }
      : { decision: 'deny', reason: decision?.message ?? 'denied in web' }
  }).catch(() => ({ decision: 'deny', reason: 'oc-bridge: permission bridge failed' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (active && !e.agentId) {
      // The login's plan windows ride ahead of the result, as on `-p`; a failed read only drops the line.
      let rate: string | null = null
      try { rate = sj.rateLimits((await $.session.usage())?.rateLimits) } catch { rate = null }
      send(rate ? [rate, sj.result(e as any, lastStopReason)] : [sj.result(e as any, lastStopReason)])
      running = undefined
    }
    return done
  })
}
