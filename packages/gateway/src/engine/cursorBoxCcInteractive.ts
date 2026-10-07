/** Route B interactive runner. Same Box exec channel, fifo, write execs, stop
 * exec and stream-json stdio contract as the `claude -p` launch; only the Box
 * process changes: an interactive Claude Code in a tmux PTY, driven by the
 * oc-bridge mod (`box-bridge-mod/`), under a small host that turns the fifo
 * into the mod's input and the mod's frames into this exec's stdout.
 *
 * Node built-ins only: the bridge is spawned as plain node. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOX_CC_HOME,
  BOX_CC_REAP_FUNCTION,
  boxOfficialClaudeModel,
  type BoxCcControl,
  type BoxCcExecRequest,
} from './cursorBoxCcExec.js'

export type BoxCcRunner = 'p' | 'interactive'

/** `OC_BOX_INTERACTIVE=1` enables the runner; `OC_BOX_INTERACTIVE_MODELS`
 * lists the catalog ids that use it (comma-separated). Everything else, the
 * default included, stays on `claude -p`. The per-row catalog `runner` field
 * replaces the model list in P2. */
export function boxCcRunner(env: NodeJS.ProcessEnv, catalogModel: string | undefined): BoxCcRunner {
  if (env.OC_BOX_INTERACTIVE !== '1' || !catalogModel) return 'p'
  const models = (env.OC_BOX_INTERACTIVE_MODELS ?? '').split(',').map((m) => m.trim()).filter(Boolean)
  return models.includes(catalogModel) ? 'interactive' : 'p'
}

/** The value after `flag` in an argv, as Commander reads it. */
export function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  const value = i >= 0 ? argv[i + 1] : undefined
  return value && !value.startsWith('-') ? value : undefined
}

const SAFE_FLAG = new Set(['--model', '--resume', '--permission-mode'])

/** Interactive counterpart of remoteClaudeArgs: the same three adapter-owned
 * flags pass, the stream-json/-p flags do not. Bypass mode also passes the
 * setting that keeps its confirmation dialog away (P0: it blocks the TTY
 * before any hook runs). The host adds `--plugin-dir`. */
export function remoteInteractiveClaudeArgs(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag || !SAFE_FLAG.has(flag)) continue
    const value = argv[i + 1]
    if (!value || value.startsWith('-')) continue
    out.push(flag, flag === '--model' ? (boxOfficialClaudeModel(value) ?? value) : value)
    i++
    if (flag === '--permission-mode' && value === 'bypassPermissions') {
      out.push('--dangerously-skip-permissions', '--settings', '{"skipDangerousModePermissionPrompt":true}')
    }
  }
  return out
}

export interface BoxBridgeMod {
  /** published path -> base64 bytes */
  files: Record<string, string>
  sha256: string
  hostPy: string
}

/** Same digest as host.py `mod_digest`: the host refuses a mod that differs. */
export function boxBridgeModDigest(files: Record<string, Buffer>): string {
  const h = createHash('sha256')
  for (const rel of Object.keys(files).sort()) {
    const data = files[rel]!
    h.update(Buffer.from(`${rel}\0${data.length}\0`, 'utf8'))
    h.update(data)
  }
  return h.digest('hex')
}

export function boxBridgeModRoot(): string {
  return resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'box-bridge-mod')
}

function walk(dir: string, root: string, out: Record<string, Buffer>): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const rel = relative(root, path).split(sep).join('/')
    if (rel.startsWith('.claude-plugin/types') || name.endsWith('.test.ts') || name === 'tsconfig.json') continue
    if (statSync(path).isDirectory()) walk(path, root, out)
    else out[rel] = readFileSync(path)
  }
}

export function loadBoxBridgeMod(root: string = boxBridgeModRoot()): BoxBridgeMod {
  const raw: Record<string, Buffer> = {}
  walk(join(root, 'oc-bridge'), join(root, 'oc-bridge'), raw)
  if (!raw['.claude-plugin/plugin.json'] || !raw['hooks/hooks.json']) throw new Error('BOX_INTERACTIVE_MOD_MISSING')
  const files: Record<string, string> = {}
  for (const [rel, data] of Object.entries(raw)) files[rel] = data.toString('base64')
  return { files, sha256: boxBridgeModDigest(raw), hostPy: readFileSync(join(root, 'host.py'), 'utf8') }
}

/** Launch for the interactive runner. Same fifo discipline as
 * BOX_CC_LAUNCH_SCRIPT (one Claude per session, the fifo held open, the
 * previous launch reaped), with the host as the fifo's reader: the stop
 * exec's reap therefore ends the host, and the host ends its tmux session.
 * Run dir `<fifo>.d`, tmux session `oc-<hash>-<nonce>` on socket `oc-box`. */
export const BOX_CC_INTERACTIVE_LAUNCH_SCRIPT = [
  'set -eu',
  'fifo="$1"',
  'claude="$2"',
  'shift 2',
  ...BOX_CC_REAP_FUNCTION,
  'for old in "${fifo%.*.fifo}".*.fifo; do',
  '  if [ "$old" = "$fifo" ] || [ ! -p "$old" ]; then continue; fi',
  '  reap "$old"',
  // A host that was killed outright leaves its tmux session: end it by name.
  '  ob="${old##*/oc-box-cc-}"',
  '  ob="${ob%.fifo}"',
  '  tmux -L oc-box kill-session -t "=oc-${ob%%.*}-${ob##*.}" 2>/dev/null || true',
  '  rm -f "$old" "$old.in" "$old.seq" "$old.lock"',
  '  rm -rf "${old%.fifo}.d"',
  'done',
  'rm -f "$fifo" "$fifo.in" "$fifo.seq" "$fifo.lock"',
  'mkfifo -m 600 "$fifo"',
  'exec 3<>"$fifo"',
  'base="${fifo##*/oc-box-cc-}"',
  'base="${base%.fifo}"',
  'set +e',
  'python3 -c "$OC_BOX_HOST_PY" "${fifo%.fifo}.d" "oc-${base%%.*}-${base##*.}" "$claude" "$@" <"$fifo"',
  'status=$?',
  'set -e',
  'exec 3>&-',
  'rm -f "$fifo" "$fifo.in" "$fifo.seq" "$fifo.lock"',
  'exit "$status"',
].join('\n')

const BOX_CC_PATH = '/home/box/.local/bin:/home/box/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
/** The kernel refuses any single argv/env string over 128 KiB. */
const MAX_EXEC_STRING = 120 * 1024

export function boxCcInteractiveLaunchExec(
  control: BoxCcControl,
  remoteArgs: readonly string[],
  mod: BoxBridgeMod,
): BoxCcExecRequest {
  const environment: Record<string, string> = {
    HOME: BOX_CC_HOME,
    PATH: BOX_CC_PATH,
    LANG: 'C.UTF-8',
    OC_BOX_HOST_PY: mod.hostPy,
    OC_BOX_MOD_FILES: JSON.stringify(mod.files),
    OC_BOX_MOD_SHA256: mod.sha256,
  }
  for (const value of Object.values(environment)) {
    if (Buffer.byteLength(value) > MAX_EXEC_STRING) throw new Error('BOX_INTERACTIVE_MOD_TOO_LARGE')
  }
  return {
    command: 'sh',
    args: ['-c', BOX_CC_INTERACTIVE_LAUNCH_SCRIPT, 'sh', control.fifo, control.remoteClaude, ...remoteArgs],
    cwd: control.cwd,
    environment,
  }
}
