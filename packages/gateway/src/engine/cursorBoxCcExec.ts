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

/** End the Claude that reads one fifo: the process whose stdin is that path.
 * The launch script keeps the fifo open, so closing a writer never ends it.
 * dash applies a foreground redirect to itself while the command runs, so the
 * launch shell is a reader too and goes with its Claude; callers remove the
 * fifo. TERM first; KILL whatever still reads the fifo two seconds later. */
const BOX_CC_REAP_FUNCTION = [
  'reap() {',
  '  pids=""',
  '  for d in /proc/[0-9]*; do',
  '    if [ "$(readlink "$d/fd/0" 2>/dev/null || true)" = "$1" ]; then pids="$pids ${d#/proc/}"; fi',
  '  done',
  '  if [ -z "$pids" ]; then return 0; fi',
  '  kill -TERM $pids 2>/dev/null || true',
  '  n=0',
  '  while [ "$n" -lt 20 ]; do',
  '    alive=""',
  '    for p in $pids; do',
  '      if [ "$(readlink "/proc/$p/fd/0" 2>/dev/null || true)" = "$1" ]; then alive="$alive $p"; fi',
  '    done',
  '    if [ -z "$alive" ]; then return 0; fi',
  '    sleep 0.1',
  '    n=$((n + 1))',
  '  done',
  '  kill -KILL $alive 2>/dev/null || true',
  '}',
] as const

export const BOX_CC_LAUNCH_SCRIPT = [
  'set -eu',
  'fifo="$1"',
  'claude="$2"',
  'shift 2',
  ...BOX_CC_REAP_FUNCTION,
  // A bridge that was killed leaves its Claude running on the old fifo, still
  // attached to this session's transcript. One session keeps one Claude.
  'for old in "${fifo%.*.fifo}".*.fifo; do',
  '  if [ "$old" = "$fifo" ] || [ ! -p "$old" ]; then continue; fi',
  '  reap "$old"',
  '  rm -f "$old" "$old.in" "$old.seq" "$old.lock"',
  'done',
  'rm -f "$fifo" "$fifo.in" "$fifo.seq" "$fifo.lock"',
  'mkfifo -m 600 "$fifo"',
  // Hold both ends for the life of claude. A later writer then cannot block
  // in open(), and closing that writer does not deliver EOF mid-turn.
  'exec 3<>"$fifo"',
  'set +e',
  '"$claude" "$@" <"$fifo"',
  'status=$?',
  'set -e',
  'exec 3>&-',
  'rm -f "$fifo" "$fifo.in" "$fifo.seq" "$fifo.lock"',
  'exit "$status"',
].join('\n')

export const BOX_CC_STOP_SCRIPT = [
  'set -eu',
  ...BOX_CC_REAP_FUNCTION,
  'reap "$1"',
  'rm -f "$1" "$1.in" "$1.seq" "$1.lock"',
].join('\n')

const SPAWN_FIFO_NONCE = /^[a-f0-9]{8,32}$/

/** One fifo name per bridge process. A writer blocked on the previous
 * process's fifo must not be able to miss the new inode after rm. */
export function boxCcSpawnFifo(base: string, nonce: string): string {
  if (!base.startsWith('/tmp/oc-box-cc-') || !base.endsWith('.fifo') || !SPAWN_FIFO_NONCE.test(nonce)) {
    throw new Error('BOX_CC_FIFO_INVALID')
  }
  return `${base.slice(0, -'.fifo'.length)}.${nonce}.fifo`
}

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

const BOX_CC_PATH = '/home/box/.local/bin:/home/box/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

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
      PATH: BOX_CC_PATH,
      LANG: 'C.UTF-8',
    },
  }
}

/** Ends the Claude this bridge launched. Used when the gateway closes stdin. */
export function boxCcStopExec(control: BoxCcControl): BoxCcExecRequest {
  return {
    command: 'sh',
    args: ['-c', BOX_CC_STOP_SCRIPT, 'sh', control.fifo],
    cwd: control.cwd,
    environment: {
      HOME: BOX_CC_HOME,
      PATH: BOX_CC_PATH,
    },
  }
}

/** One stdin line for the box Claude, sent as one or more exec requests.
 * The exec API carries data only in argv and environment, and the kernel
 * refuses any single string over 128 KiB (MAX_ARG_STRLEN), so a line is cut
 * into base64 parts well under that. A line that needs several requests is
 * collected in `<fifo>.in`, each request writing at its own offset, and
 * reaches the fifo in one write by the last request.
 *
 * Claude must never read a line twice, also when the bridge repeats a
 * request whose response it lost. The bridge numbers its lines; under
 * `<fifo>.lock` the script records `<n> pending` in `<fifo>.seq` before the
 * fifo write and `<n> done` after it. A repeated request waits for the
 * attempt that holds the lock, then exits 0 if the line is done and 4 if the
 * earlier attempt died between the two marks (it is unknown how much Claude
 * received, so the line is not written again and the bridge stops).
 *
 * The script waits until the launch script has created the fifo: opening it
 * earlier races the mkfifo and then leaves Claude blocked on a reader that
 * never gets a writer. */
export const BOX_CC_WRITE_SCRIPT = [
  'import base64,fcntl,os,time',
  'e=os.environ',
  'p=e["OC_BOX_CC_FIFO"]',
  'seq=int(e["OC_BOX_CC_SEQ"])',
  'off=int(e["OC_BOX_CC_OFFSET"])',
  'last=e["OC_BOX_CC_LAST"]=="1"',
  'data=b"".join(base64.b64decode(e["OC_BOX_CC_PART_%d"%i]) for i in range(int(e["OC_BOX_CC_PARTS"])))',
  'end=time.time()+15',
  'while not os.path.exists(p):',
  '    if time.time()>end: raise SystemExit(1)',
  '    time.sleep(0.05)',
  'fcntl.flock(os.open(p+".lock",os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600),fcntl.LOCK_EX)',
  'try:',
  '    with open(p+".seq") as f: done,state=f.read().split()',
  '    done=int(done)',
  'except (OSError,ValueError): done,state=0,"done"',
  'if done>seq or (done==seq and state=="done"): raise SystemExit(0)',
  'if done==seq: raise SystemExit(4)',
  'def mark(state):',
  '    with os.fdopen(os.open(p+".seq.tmp",os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600),"w") as f: f.write("%d %s"%(seq,state))',
  '    os.replace(p+".seq.tmp",p+".seq")',
  'if off or not last:',
  '    f=os.fdopen(os.open(p+".in",os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600),"r+b")',
  '    if os.fstat(f.fileno()).st_size<off: raise SystemExit(3)',
  '    f.seek(off)',
  '    f.write(data)',
  '    f.truncate()',
  '    if last:',
  '        f.seek(0)',
  '        data=f.read()',
  '        os.unlink(p+".in")',
  '    f.close()',
  'if last:',
  '    mark("pending")',
  '    with open(p,"ab") as f: f.write(data)',
  '    mark("done")',
].join('\n')

/** Bytes of the line per environment string (80 000 base64 characters). */
export const BOX_CC_WRITE_PART_BYTES = 60_000
/** Environment strings per exec request. */
export const BOX_CC_WRITE_PARTS_PER_EXEC = 4

/** `seq` numbers the lines of one bridge process from 1. */
export function boxCcWriteExecs(control: BoxCcControl, line: string, seq: number): BoxCcExecRequest[] {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('BOX_CC_LINE_SEQ_INVALID')
  const bytes = Buffer.from(line.endsWith('\n') ? line : `${line}\n`, 'utf8')
  const perExec = BOX_CC_WRITE_PART_BYTES * BOX_CC_WRITE_PARTS_PER_EXEC
  const out: BoxCcExecRequest[] = []
  for (let offset = 0; offset < bytes.length; offset += perExec) {
    const slice = bytes.subarray(offset, offset + perExec)
    const environment: Record<string, string> = {
      HOME: BOX_CC_HOME,
      OC_BOX_CC_FIFO: control.fifo,
      OC_BOX_CC_SEQ: String(seq),
      OC_BOX_CC_OFFSET: String(offset),
      OC_BOX_CC_LAST: offset + perExec >= bytes.length ? '1' : '0',
      OC_BOX_CC_PARTS: String(Math.ceil(slice.length / BOX_CC_WRITE_PART_BYTES)),
    }
    for (let part = 0; part * BOX_CC_WRITE_PART_BYTES < slice.length; part++) {
      environment[`OC_BOX_CC_PART_${part}`] = slice
        .subarray(part * BOX_CC_WRITE_PART_BYTES, (part + 1) * BOX_CC_WRITE_PART_BYTES)
        .toString('base64')
    }
    out.push({ command: 'python3', args: ['-c', BOX_CC_WRITE_SCRIPT], cwd: control.cwd, environment })
  }
  return out
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
  kind: 'stdout' | 'stderr' | 'exit' | 'end'
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

/** Exit code of a finished exec response; null when it carries no exit event. */
export function execExitCode(buffer: Buffer): number | null {
  let code: number | null = null
  for (const event of parseExecFrames(buffer).events) {
    if (event.kind === 'exit') code = event.code ?? 0
  }
  return code
}

/** Strict decoder for paid Box model API traffic. The older CLI bridge keeps
 * its permissive parser for compatibility; this variant never silently drops
 * a malformed frame and then treats a later exit=0 as a complete response.
 */
export function parseExecFramesStrict(buffer: Buffer): { events: ExecFrame[]; rest: Buffer } {
  const events: ExecFrame[] = []
  const utf8 = new TextDecoder('utf-8', { fatal: true })
  const own = (value: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key)
  let offset = 0
  while (offset + 5 <= buffer.length) {
    const flag = buffer[offset]
    const length = buffer.readUInt32BE(offset + 1)
    if (length < 2 || length > 8 * 1024 * 1024) throw new Error('BOX_EXEC_FRAME_LENGTH_INVALID')
    if (offset + 5 + length > buffer.length) break
    let record: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(utf8.decode(buffer.subarray(offset + 5, offset + 5 + length)))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
      record = value as Record<string, unknown>
    } catch { throw new Error('BOX_EXEC_FRAME_JSON_INVALID') }
    offset += 5 + length
    if (flag === 2) {
      // Connect streaming end envelope. The real Box currently emits `{}`;
      // error/metadata variants must be explicitly understood before use.
      if (Object.keys(record).length !== 0) throw new Error('BOX_EXEC_END_INVALID')
      events.push({ kind: 'end' })
      continue
    }
    if (flag !== 0) throw new Error('BOX_EXEC_FRAME_FLAGS_INVALID')
    for (const [camel, snake] of [
      ['stdoutEvent', 'stdout_event'], ['stderrEvent', 'stderr_event'], ['exitEvent', 'exit_event'],
    ]) {
      if (own(record, camel) && own(record, snake)) throw new Error('BOX_EXEC_FRAME_ALIAS_CONFLICT')
    }
    const stdout = record.stdoutEvent ?? record.stdout_event
    const stderr = record.stderrEvent ?? record.stderr_event
    const exit = record.exitEvent ?? record.exit_event
    const variants = Number(stdout !== undefined) + Number(stderr !== undefined) + Number(exit !== undefined)
    if (variants !== 1) throw new Error('BOX_EXEC_FRAME_VARIANT_INVALID')
    if (stdout !== undefined || stderr !== undefined) {
      const value = stdout ?? stderr
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof (value as { data?: unknown }).data !== 'string') {
        throw new Error('BOX_EXEC_FRAME_DATA_INVALID')
      }
      events.push({ kind: stdout !== undefined ? 'stdout' : 'stderr',
        data: (value as { data: string }).data })
    } else {
      if (!exit || typeof exit !== 'object' || Array.isArray(exit)) {
        throw new Error('BOX_EXEC_FRAME_EXIT_INVALID')
      }
      if (own(exit as Record<string, unknown>, 'exitCode')
        && own(exit as Record<string, unknown>, 'exit_code')) {
        throw new Error('BOX_EXEC_FRAME_ALIAS_CONFLICT')
      }
      const code = (exit as { exitCode?: unknown; exit_code?: unknown }).exitCode
        ?? (exit as { exit_code?: unknown }).exit_code
      // Proto3 JSON omits scalar defaults: the real Box emits exitEvent:{}
      // for a successful exit 0. A non-empty object without a numeric code
      // is not that canonical default and must not be treated as success.
      const normalizedCode = code === undefined && Object.keys(exit).length === 0 ? 0 : code
      if (!Number.isSafeInteger(normalizedCode) || Number(normalizedCode) < 0 || Number(normalizedCode) > 255) {
        throw new Error('BOX_EXEC_FRAME_EXIT_INVALID')
      }
      events.push({ kind: 'exit', code: normalizedCode as number })
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
