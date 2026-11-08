/** UID-local tool-only MCP client. Fixed entry point, no model or credential transport. */
import { spawn } from 'node:child_process'
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { type Cc5ToolResult, assertCc5ToolResult, boundCc5ToolResult } from './cc5NativeTool.js'
import type { Cc5HostProfile, Cc5HostTool } from './cc5ToolCatalog.js'

/** The bridge already holds a local chat's tool environment without model credentials (runner
 * laneEnv); tools see it as they would locally. NODE_OPTIONS could rewrite the child runtime. */
function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && key !== 'NODE_OPTIONS') env[key] = value
  }
  return { ...env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/
const INIT_TIMEOUT_MS = 90000
/** tools/list is big (full builtin + MCP prompts), so the line bound must be too. */
const MAX_LINE_BYTES = 2 * 1024 * 1024
const CALL_TIMEOUT_MS = 11 * 60 * 1000

export class Cc5ToolHost {
  private readonly child
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private pending?: {
    id: number
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
  }
  private sequence = 0
  private closing = false
  private closePromise?: Promise<void>
  private readonly ready: Promise<void>
  private toolList?: Cc5HostTool[]
  constructor(
    private readonly root: string,
    private readonly lifecycleId: string,
    profile: Cc5HostProfile,
    /** Answers the host's permission prompt (AskUserQuestion) the way a local chat's gateway does. */
    private readonly onPermission?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
    environment?: NodeJS.ProcessEnv,
  ) {
    const supervisor = fileURLToPath(
      new URL('../../../scripts/agent-remote/cc5-toolhost-supervisor.py', import.meta.url),
    )
    const profilePath = join(root, 'host-profile.json')
    const body = JSON.stringify({
      version: 1,
      cwd: profile.cwd,
      mcpConfigPath: profile.mcpConfigPath,
      settingsPath: profile.settingsPath,
      disallowedTools: profile.disallowedTools,
    })
    const fd = openSync(
      profilePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      writeFileSync(fd, body)
    } finally {
      closeSync(fd)
    }
    this.child = spawn(
      '/usr/bin/python3',
      [
        '-I',
        '-B',
        supervisor,
        process.execPath,
        join(root, 'stopped.json'),
        lifecycleId,
        profilePath,
      ],
      {
        env: childEnv(environment),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    this.exited = new Promise((resolve) =>
      this.child.once('exit', (code, signal) => resolve({ code, signal })),
    )
    this.child.stderr.resume() // Tool/user/config data must not leak through bridge stderr.
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        buffer += decoder.write(chunk)
        if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw new Error('limit')
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const row = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>
          buffer = buffer.slice(index + 1)
          if (row.id === undefined) continue // MCP progress/notifications have no authority.
          if (typeof row.method === 'string') {
            this.answer(row)
            continue
          }
          if (row.jsonrpc !== '2.0' || row.id !== this.pending?.id) throw new Error('correlation')
          const pending = this.pending!
          this.pending = undefined
          if (row.error !== undefined) pending.reject(new Error('CC5_TOOLHOST_REQUEST_REJECTED'))
          else if (!row.result || typeof row.result !== 'object' || Array.isArray(row.result))
            pending.reject(new Error('CC5_TOOLHOST_RESPONSE_INVALID'))
          else pending.resolve(row.result as Record<string, unknown>)
        }
      } catch {
        this.fail()
      }
    })
    this.child.once('error', () => this.fail())
    this.child.once('exit', () => {
      if (!this.closing) this.fail()
    })
    this.child.stdin.on('error', () => this.fail())
    this.ready = this.load()
    void this.ready.catch(() => this.fail())
  }
  private async load(): Promise<void> {
    await this.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'cc5-uid-local', version: '2' },
      },
      INIT_TIMEOUT_MS,
    )
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    )
    const result = await this.request('tools/list', {}, INIT_TIMEOUT_MS)
    const tools = result.tools
    if (!Array.isArray(tools) || tools.length < 1 || tools.length > 128)
      throw new Error('CC5_TOOLHOST_PROFILE_INVALID')
    const names = new Set<string>()
    this.toolList = tools.map((value) => {
      const tool =
        value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
      const inputSchema = tool?.inputSchema
      if (
        !tool ||
        typeof tool.name !== 'string' ||
        !TOOL_NAME.test(tool.name) ||
        names.has(tool.name) ||
        typeof tool.description !== 'string' ||
        !inputSchema ||
        typeof inputSchema !== 'object' ||
        Array.isArray(inputSchema) ||
        (inputSchema as Record<string, unknown>).type !== 'object'
      )
        throw new Error('CC5_TOOLHOST_PROFILE_INVALID')
      names.add(tool.name)
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchema as Record<string, unknown>,
      }
    })
  }
  /** A host request is only legitimate while one of our tools/call is running. */
  private answer(row: Record<string, unknown>): void {
    const id = row.id
    if (row.jsonrpc !== '2.0' || row.method !== 'openclaude/can_use_tool' || !this.pending || this.toolList === undefined ||
        !(typeof id === 'string' || typeof id === 'number') || !row.params || typeof row.params !== 'object' || !this.onPermission)
      throw new Error('correlation')
    const write = (value: Record<string, unknown>): void => {
      if (!this.closing) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...value })}\n`)
    }
    this.onPermission(row.params as Record<string, unknown>).then((result) => write({ result }),
      () => write({ error: { code: -32000, message: 'permission request not answered' } }))
  }
  private fail(): void {
    this.pending?.reject(new Error('CC5_TOOLHOST_EXECUTION_UNKNOWN'))
    this.pending = undefined
    if (!this.closing) void this.close().catch(() => {})
  }
  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (this.closing || this.pending)
      return Promise.reject(new Error('CC5_TOOLHOST_CLOSED_OR_BUSY'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.fail()
      }, timeoutMs)
      this.pending = {
        id,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  async tools(): Promise<Cc5HostTool[]> {
    await this.ready
    return structuredClone(this.toolList!)
  }
  async execute(
    name: string,
    args: unknown,
    identity: { nativeSessionId: string; turnKey: string; toolUseId: string },
  ): Promise<Cc5ToolResult> {
    await this.ready
    const value = await this.request(
      'tools/call',
      {
        name,
        arguments: args,
        _meta: {
          'claudecode/toolUseId': identity.toolUseId,
          'openclaude/nativeSessionId': identity.nativeSessionId,
          'openclaude/turnKey': identity.turnKey,
        },
      },
      CALL_TIMEOUT_MS,
    )
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
      const status = await Promise.race([
        this.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('CC5_TOOLHOST_STOP_UNKNOWN')), 4000)
        }),
      ]).finally(() => clearTimeout(timer))
      if (status.code !== 0 || status.signal) throw new Error('CC5_TOOLHOST_STOP_UNKNOWN')
      const fd = openSync(
        join(this.root, 'stopped.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const st = fstatSync(fd)
        if (
          !st.isFile() ||
          st.uid !== process.getuid?.() ||
          st.nlink !== 1 ||
          st.mode & 0o077 ||
          st.size > 4096
        )
          throw new Error('CC5_TOOLHOST_STOP_UNKNOWN')
        const proof = JSON.parse(readFileSync(fd, 'utf8'))
        if (
          proof.version !== 1 ||
          proof.lifecycleId !== this.lifecycleId ||
          proof.supervisorPid !== this.child.pid ||
          proof.localStopped !== true
        )
          throw new Error('CC5_TOOLHOST_STOP_UNKNOWN')
      } finally {
        closeSync(fd)
      }
    })().catch((error) => {
      // A late supervisor proof can be re-read; closing still permanently rejects tool calls.
      this.closePromise = undefined
      throw error
    })
    return this.closePromise
  }
}
