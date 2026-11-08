/** Master-side evidence. Node MCP metadata alone never grants an effect. */
import { EventEmitter } from 'node:events'
import { cc5ToolInputSha256, validateCc5NativeToolInput } from './cc5NativeTool.js'
import { codexNeed, nativeId } from './codexRemoteContract.js'
export interface CodexObservedTool {
  nativeThreadId: string; nativeTurnId: string; callId: string; server: string; name: string; inputSha256: string
}
export class CodexToolObservation {
  private readonly events = new EventEmitter()
  private readonly observed = new Map<string, CodexObservedTool>()
  private readonly consumed = new Set<string>()
  private readonly started = new Set<string>()
  private fenced = false
  private thread?: string
  private turn?: string
  constructor(private readonly names: ReadonlySet<string>, private readonly onFence: (reason: string) => void) {}
  bindThread(id: string): void { codexNeed(nativeId(id) && (!this.thread || this.thread === id)); this.thread = id }
  get nativeThreadId(): string | undefined { return this.thread }
  get nativeTurnId(): string | undefined { return this.turn }
  get calls(): readonly CodexObservedTool[] { return [...this.observed.values()] }
  revoke(reason = 'CODEX_ORIGINAL_OBSERVATION_REJECTED'): void {
    if (!this.fenced) { this.fenced = true; this.events.emit('change'); this.onFence(reason) }
  }
  endTurn(): void { this.turn = undefined; this.observed.clear() }
  observe(raw: unknown): void {
    try {
      codexNeed(!this.fenced && raw && typeof raw === 'object' && !Array.isArray(raw))
      const f = raw as { id?: unknown; method?: string; params?: any }
      codexNeed(!(f.id !== undefined && f.method !== undefined), 'CODEX_SERVER_REQUEST_REJECTED')
      const p = f.params
      if (f.method === 'turn/started') {
        codexNeed(p?.threadId === this.thread && !this.turn && nativeId(p.turn?.id))
        this.turn = p.turn.id
      }
      if (f.method === 'item/started' || f.method === 'item/completed') {
        codexNeed(p?.threadId === this.thread && p.turnId === this.turn && !!this.turn)
        const i = p.item
        codexNeed(i && ['agentMessage', 'reasoning', 'userMessage', 'contextCompaction', 'mcpToolCall'].includes(i.type), 'CODEX_NATIVE_ITEM_REJECTED')
        if (i.type === 'mcpToolCall') {
          codexNeed(i.server === 'ocbridge' && this.names.has(i.tool) && nativeId(i.id), 'CODEX_NATIVE_ITEM_REJECTED')
          let args = i.arguments
          if (typeof args === 'string') args = JSON.parse(args)
          validateCc5NativeToolInput(`mcp__ocbridge__${i.tool}`, args)
          const evidence = { nativeThreadId: this.thread!, nativeTurnId: this.turn!, callId: i.id,
            server: i.server, name: i.tool, inputSha256: cc5ToolInputSha256(args) }
          if (f.method === 'item/started') {
            codexNeed(!this.started.has(i.id) && this.started.size < 10000)
            this.started.add(i.id)
            this.observed.set(i.id, evidence)
          } else {
            const started = this.observed.get(i.id)
            codexNeed(started && Object.keys(evidence).every(k => evidence[k as keyof CodexObservedTool] === started[k as keyof CodexObservedTool]))
          }
        }
      }
      if (f.method === 'turn/completed') codexNeed(p?.threadId === this.thread && p.turn?.id === this.turn && !!this.turn)
      this.events.emit('change')
    } catch (error) { this.revoke(error instanceof Error ? error.message : undefined); throw error }
  }
  async authorize(request: CodexObservedTool & { arguments: unknown }, timeoutMs = 10000): Promise<void> {
    codexNeed(!this.fenced && nativeId(request.callId) && !this.consumed.has(request.callId))
    // Burn before waiting so two concurrent transports cannot both acquire the same effect.
    this.consumed.add(request.callId)
    try {
      validateCc5NativeToolInput(`mcp__ocbridge__${request.name}`, request.arguments)
      codexNeed(request.inputSha256 === cc5ToolInputSha256(request.arguments))
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => { clearTimeout(timer); this.events.removeListener('change', check); error ? reject(error) : resolve() }
        const check = () => {
          if (this.fenced) return done(new Error('CODEX_ORIGINAL_OBSERVATION_REJECTED'))
          const actual = this.observed.get(request.callId)
          if (!actual) return
          done(Object.keys(actual).every(k => actual[k as keyof CodexObservedTool] === request[k as keyof CodexObservedTool])
            ? undefined : new Error('CODEX_ORIGINAL_TOOL_SCOPE_MISMATCH'))
        }
        const timer = setTimeout(() => done(new Error('CODEX_ORIGINAL_TOOL_NOT_OBSERVED')), timeoutMs)
        this.events.on('change', check); check()
      })
    } catch (error) { this.revoke(); throw error }
  }
}
