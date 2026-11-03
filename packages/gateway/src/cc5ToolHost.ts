/** UID-local tool-only MCP client. Fixed entry point, no model or credential transport. */
import { spawn } from 'node:child_process'
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { assertCc5ToolResult, boundCc5ToolResult, type Cc5ToolResult } from './cc5NativeTool.js'

export class Cc5ToolHost {
  private readonly child
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private pending?: { id: number; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  private sequence = 0
  private closing = false
  private closePromise?: Promise<void>
  private readonly ready: Promise<void>
  constructor(private readonly root: string, private readonly lifecycleId: string) {
    const supervisor = fileURLToPath(new URL('../../../scripts/agent-remote/cc5-toolhost-supervisor.py', import.meta.url))
    const env: NodeJS.ProcessEnv = {
      HOME: process.env.HOME,
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}),
    }
    this.child = spawn('/usr/bin/python3', ['-I', '-B', supervisor, process.execPath,
      join(root, 'stopped.json'), lifecycleId], { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.exited = new Promise((resolve) => this.child.once('exit', (code, signal) => resolve({ code, signal })))
    this.child.stderr.resume() // Tool/user/config data must not leak through bridge stderr.
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        buffer += decoder.write(chunk)
        if (Buffer.byteLength(buffer) > 262144) throw new Error('limit')
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const row = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>
          buffer = buffer.slice(index + 1)
          if (row.id === undefined) continue // MCP progress/notifications have no authority.
          if (row.jsonrpc !== '2.0' || row.id !== this.pending?.id) throw new Error('correlation')
          const pending = this.pending!
          this.pending = undefined
          if (row.error !== undefined) pending.reject(new Error('CC5_TOOLHOST_REQUEST_REJECTED'))
          else if (!row.result || typeof row.result !== 'object' || Array.isArray(row.result)) pending.reject(new Error('CC5_TOOLHOST_RESPONSE_INVALID'))
          else pending.resolve(row.result as Record<string, unknown>)
        }
      } catch { this.fail() }
    })
    this.child.once('error', () => this.fail())
    this.child.once('exit', () => { if (!this.closing) this.fail() })
    this.child.stdin.on('error', () => this.fail())
    this.ready = this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'cc5-uid-local', version: '2' } }).then(async () => {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      const result = await this.request('tools/list', {})
      const tools = result.tools as Array<{ name?: string }>
      if (!Array.isArray(tools) || tools.length !== 3 || tools.map((tool) => tool.name).sort().join(',') !== 'Bash,Edit,Read')
        throw new Error('CC5_TOOLHOST_PROFILE_INVALID')
    })
    void this.ready.catch(() => this.fail())
  }
  private fail(): void {
    this.pending?.reject(new Error('CC5_TOOLHOST_EXECUTION_UNKNOWN'))
    this.pending = undefined
    if (!this.closing) void this.close().catch(() => {})
  }
  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closing || this.pending) return Promise.reject(new Error('CC5_TOOLHOST_CLOSED_OR_BUSY'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { this.fail() }, 45000)
      this.pending = { id, resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) } }
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  async execute(name: string, args: unknown, identity: { nativeSessionId: string; turnKey: string; toolUseId: string }): Promise<Cc5ToolResult> {
    await this.ready
    const value = await this.request('tools/call', { name: name.slice('mcp__ocbridge__'.length), arguments: args,
      _meta: { 'claudecode/toolUseId': identity.toolUseId, 'openclaude/nativeSessionId': identity.nativeSessionId,
        'openclaude/turnKey': identity.turnKey } })
    const result = boundCc5ToolResult({ content: value.content, isError: value.isError === true })
    assertCc5ToolResult(result)
    return structuredClone(result)
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.pending?.reject(new Error('CC5_TOOLHOST_STOPPED_DURING_EXECUTION'))
    this.pending = undefined
    this.closePromise = (async () => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      const status = await Promise.race([this.exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('CC5_TOOLHOST_STOP_UNKNOWN')), 4000)
      })]).finally(() => clearTimeout(timer))
      if (status.code !== 0 || status.signal) throw new Error('CC5_TOOLHOST_STOP_UNKNOWN')
      const fd = openSync(join(this.root, 'stopped.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const st = fstatSync(fd)
        if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink !== 1 || (st.mode & 0o077) || st.size > 4096)
          throw new Error('CC5_TOOLHOST_STOP_UNKNOWN')
        const proof = JSON.parse(readFileSync(fd, 'utf8'))
        if (proof.version !== 1 || proof.lifecycleId !== this.lifecycleId || proof.supervisorPid !== this.child.pid || proof.localStopped !== true)
          throw new Error('CC5_TOOLHOST_STOP_UNKNOWN')
      } finally { closeSync(fd) }
    })()
    return this.closePromise
  }
}
