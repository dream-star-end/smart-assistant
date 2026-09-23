/** Pure exec framing for the box-resident Claude bridge.
 * This file must stay free of gateway, credential, and protocol imports.
 * The bridge is spawned as plain node and cannot load that graph. */
export const BOX_CC_REMOTE_CLAUDE = '/home/box/.local/bin/claude'
export const BOX_CC_CWD = '/workspace'
export const BOX_CC_HOME = '/home/box'

const SAFE_FLAG = new Set(['--model', '--resume', '--permission-mode'])

const BOX_OFFICIAL_MODELS: Record<string, string> = {
  'box-claude-opus-5-5': 'claude-opus-5-5',
  'box-claude-sonnet-5': 'claude-sonnet-5',
  'box-claude-haiku-4-5': 'claude-haiku-4-5',
}

/** Catalog ids for the box CLI. Old cursor-opus/sonnet/haiku/fable ids map
 * to the same official names so a not-yet-migrated session still speaks
 * Claude Code's model id, not a Cursor Sand slug. */
export function boxOfficialClaudeModel(model: string | undefined): string | undefined {
  if (!model) return undefined
  const exact = BOX_OFFICIAL_MODELS[model]
  if (exact) return exact
  if (model.startsWith('cursor-opus-') || model.startsWith('cursor-fable-')) return 'claude-opus-5-5'
  if (model.startsWith('cursor-sonnet-')) return 'claude-sonnet-5'
  if (model === 'cursor-haiku-4.5' || model.startsWith('cursor-haiku-')) return 'claude-haiku-4-5'
  return undefined
}

export function isBoxClaudeCatalogModel(model: string | undefined): boolean {
  return !!model && Object.prototype.hasOwnProperty.call(BOX_OFFICIAL_MODELS, model)
}

/** Official stream-json argv that is safe to run inside the box.
 * Container paths (--add-dir, --settings, --mcp-config, prompt files) are dropped. */
export function remoteClaudeArgs(argv: readonly string[]): string[] {
  const out = [
    '-p',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompt-tool',
    'stdio',
  ]
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag || !SAFE_FLAG.has(flag)) continue
    const value = argv[i + 1]
    if (!value || value.startsWith('-')) continue
    const forwarded = flag === '--model' ? (boxOfficialClaudeModel(value) ?? value) : value
    out.push(flag, forwarded)
    i++
    if (flag === '--permission-mode' && value === 'bypassPermissions') {
      out.push('--dangerously-skip-permissions')
    }
  }
  return out
}

export const BOX_CC_LAUNCH_SCRIPT = [
  'set -eu',
  'fifo="$1"',
  'claude="$2"',
  'shift 2',
  'rm -f "$fifo"',
  'mkfifo -m 600 "$fifo"',
  'exec "$claude" "$@" < "$fifo"',
].join('\n')

export interface BoxCcExecRequest {
  command: string
  args: string[]
  cwd: string
  environment: Record<string, string>
}

export interface BoxCcControl {
  execUrl: string
  execToken: string
  networkToken: string
  remoteClaude: string
  fifo: string
  cwd: string
}

export function boxCcLaunchExec(
  control: BoxCcControl,
  remoteArgs: readonly string[],
): BoxCcExecRequest {
  return {
    command: 'sh',
    args: ['-c', BOX_CC_LAUNCH_SCRIPT, 'sh', control.fifo, control.remoteClaude, ...remoteArgs],
    cwd: control.cwd,
    environment: {
      HOME: BOX_CC_HOME,
      PATH: '/home/box/.local/bin:/home/box/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8',
    },
  }
}

/** Wait until the launch script has created the fifo. Opening it immediately
 * races the mkfifo and then leaves Claude blocked on a reader that never
 * gets a writer. */
export const BOX_CC_WRITE_SCRIPT = [
  'import os,time',
  'p=os.environ["OC_BOX_CC_FIFO"]',
  'end=time.time()+15',
  'while not os.path.exists(p):',
  '    if time.time()>end: raise SystemExit(1)',
  '    time.sleep(0.05)',
  'open(p,"a",encoding="utf-8").write(os.environ["OC_BOX_CC_LINE"])',
].join('\n')

export function boxCcWriteExec(control: BoxCcControl, line: string): BoxCcExecRequest {
  const text = line.endsWith('\n') ? line : `${line}\n`
  return {
    command: 'python3',
    args: ['-c', BOX_CC_WRITE_SCRIPT],
    cwd: control.cwd,
    environment: {
      HOME: BOX_CC_HOME,
      OC_BOX_CC_FIFO: control.fifo,
      OC_BOX_CC_LINE: text,
    },
  }
}

export function boxCcControlSummary(control: BoxCcControl): {
  execHost: string
  remoteClaude: string
  fifo: string
  cwd: string
} {
  const host = new URL(control.execUrl).host
  return {
    execHost: host,
    remoteClaude: control.remoteClaude,
    fifo: control.fifo,
    cwd: control.cwd,
  }
}

export interface ExecFrame {
  kind: 'stdout' | 'stderr' | 'exit'
  data?: string
  code?: number
}

export function parseExecFrames(buffer: Buffer): { events: ExecFrame[]; rest: Buffer } {
  const events: ExecFrame[] = []
  let offset = 0
  while (offset + 5 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 1)
    if (length > 8 * 1024 * 1024) break
    if (offset + 5 + length > buffer.length) break
    const payload = buffer.subarray(offset + 5, offset + 5 + length)
    offset += 5 + length
    let parsed: unknown
    try {
      parsed = JSON.parse(payload.toString('utf8'))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    const stdout = record.stdoutEvent ?? record.stdout_event
    const stderr = record.stderrEvent ?? record.stderr_event
    const exit = record.exitEvent ?? record.exit_event
    if (stdout && typeof stdout === 'object' && typeof (stdout as { data?: unknown }).data === 'string') {
      events.push({ kind: 'stdout', data: (stdout as { data: string }).data })
    } else if (stderr && typeof stderr === 'object' && typeof (stderr as { data?: unknown }).data === 'string') {
      events.push({ kind: 'stderr', data: (stderr as { data: string }).data })
    } else if (exit && typeof exit === 'object') {
      const code = (exit as { exitCode?: unknown; exit_code?: unknown }).exitCode
        ?? (exit as { exit_code?: unknown }).exit_code
      events.push({ kind: 'exit', code: typeof code === 'number' ? code : 0 })
    }
  }
  return { events, rest: buffer.subarray(offset) }
}

export function encodeExecRequest(body: BoxCcExecRequest): Buffer {
  const payload = Buffer.from(JSON.stringify(body))
  const out = Buffer.alloc(5 + payload.length)
  out[0] = 0
  out.writeUInt32BE(payload.length, 1)
  payload.copy(out, 5)
  return out
}
