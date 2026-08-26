import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const sourceWrapper = join(
  root,
  'packages/commercial/agent-sandbox/platform-runtime/bin/oc-cursor.sh',
)
const dockerfile = join(root, 'packages/commercial/agent-sandbox/Dockerfile.openclaude-runtime')
const buildImageScript = join(root, 'packages/commercial/agent-sandbox/build-image.sh')
const tempRoots: string[] = []

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): {
  dir: string
  wrapper: string
  auth: string
  capture: string
  env: NodeJS.ProcessEnv
} {
  const dir = mkdtempSync(join(tmpdir(), 'oc-cursor-wrapper-test-'))
  tempRoots.push(dir)
  const fakeBin = join(dir, 'cursor-agent')
  const authDir = join(dir, 'auth')
  const auth = join(authDir, 'api-key')
  const capture = join(dir, 'capture')
  const binDir = join(dir, 'bin')
  mkdirSync(authDir)
  mkdirSync(capture)
  mkdirSync(binDir)
  chmodSync(authDir, 0o700)
  writeFileSync(auth, 'crsr_dummy\n', { mode: 0o600 })
  chmodSync(auth, 0o600)

  writeFileSync(
    fakeBin,
    `#!/bin/sh
set -eu
[ -n "\${CURSOR_API_KEY:-}" ]
printf '%s\\n' "$HOME" > "$OC_CURSOR_TEST_CAPTURE/home"
printf '%s\\n' "$@" > "$OC_CURSOR_TEST_CAPTURE/argv"
printf '%s\\n' "\${OPENCLAUDE_CURSOR_MCP_CONFIG-unset}" > "$OC_CURSOR_TEST_CAPTURE/mcp-env"
printf '%s\\n' "\${OPENCLAUDE_CURSOR_RESUME_ID-unset}" > "$OC_CURSOR_TEST_CAPTURE/resume-env"
printf '%s\\n' "\${CURSOR_AGENT_DISABLE_DEBUG_LOG-unset}" > "$OC_CURSOR_TEST_CAPTURE/disable-debug"
if [ "\${OC_CURSOR_TEST_STDERR:-0}" = 1 ]; then
  printf 'FAKE_DEBUG_LINE\\n' >&2
fi
if [ -L "$HOME/.config/cursor/chats" ]; then
  readlink "$HOME/.config/cursor/chats" > "$OC_CURSOR_TEST_CAPTURE/chats-link"
elif [ -e "$HOME/.config/cursor/chats" ]; then
  printf '%s\\n' "not-symlink" > "$OC_CURSOR_TEST_CAPTURE/chats-link"
else
  printf '%s\\n' "missing" > "$OC_CURSOR_TEST_CAPTURE/chats-link"
fi
if [ -f "$HOME/.cursor/mcp.json" ]; then
  /bin/cp "$HOME/.cursor/mcp.json" "$OC_CURSOR_TEST_CAPTURE/mcp.json"
fi
printf '%s\\n' "\${OPENCLAUDE_CURSOR_HOOKS_JSON-unset}" > "$OC_CURSOR_TEST_CAPTURE/hooks-env"
if [ -f "$HOME/.cursor/hooks.json" ]; then
  /bin/cp "$HOME/.cursor/hooks.json" "$OC_CURSOR_TEST_CAPTURE/hooks.json"
fi
/bin/mkdir -p "$HOME/.config/cursor"
printf '%s\\n' "\${CURSOR_API_KEY}" > "$HOME/.config/cursor/auth.json"
printf '%s\\n' "\${CURSOR_API_KEY}" > "$OC_CURSOR_TEST_CAPTURE/key"
if [ -n "\${OC_CURSOR_TEST_FAIL_ON_KEY:-}" ] && [ "\${CURSOR_API_KEY}" = "\${OC_CURSOR_TEST_FAIL_ON_KEY}" ]; then
  printf '%s\\n' '{"type":"result","subtype":"error_during_execution","error":"injected"}'
  exit 1
fi
if [ "\${OC_CURSOR_TEST_SLEEP:-0}" = 1 ]; then
  trap 'printf term > "$OC_CURSOR_TEST_CAPTURE/term"; exit 143' TERM
  while :; do sleep 1; done
fi
if [ "\${OC_CURSOR_TEST_ORPHAN:-0}" = 1 ]; then
  (
    trap 'printf term > "$OC_CURSOR_TEST_CAPTURE/orphan-term"; exit 0' TERM
    : > "$OC_CURSOR_TEST_CAPTURE/orphan-ready"
    while :; do sleep 1; done
  ) </dev/null >/dev/null 2>&1 &
  while [ ! -f "$OC_CURSOR_TEST_CAPTURE/orphan-ready" ]; do sleep 0.01; done
  exit 0
fi
printf '%s\\n' '{"type":"thinking","text":"checking"}'
printf '%s\\n' '{"type":"assistant","text":"done"}'
printf '%s\\n' '{"type":"result","subtype":"success","usage":{"inputTokens":1,"outputTokens":1}}'
`,
    { mode: 0o755 },
  )
  chmodSync(fakeBin, 0o755)

  const wrapper = join(dir, 'oc-cursor')
  const rewritten = readFileSync(sourceWrapper, 'utf8')
    .replace(
      'cursor_bin=/opt/cursor-agent/versions/2026.08.11-e8db854/cursor-agent',
      `cursor_bin=${fakeBin}`,
    )
    .replace('auth_file=/run/oc/cursor-auth/api-key', `auth_file=${auth}`)
    .replaceAll('/usr/bin/sudo -n /usr/bin/test -f', '/usr/bin/test -f')
    .replaceAll('/usr/bin/sudo -n /bin/ls', '/bin/ls')
    .replaceAll('/usr/bin/sudo -n /bin/cat', '/bin/cat')
  writeFileSync(wrapper, rewritten, { mode: 0o755 })
  chmodSync(wrapper, 0o755)
  return {
    dir,
    wrapper,
    auth,
    capture,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      OC_CURSOR_TEST_CAPTURE: capture,
    },
  }
}

describe('oc-cursor wrapper', () => {
  test('pins a checksum-verified official build in the immutable runtime image', () => {
    const source = readFileSync(dockerfile, 'utf8')
    const buildSource = readFileSync(buildImageScript, 'utf8')
    const wrapperSource = readFileSync(sourceWrapper, 'utf8')
    assert.match(source, /OC_CURSOR_AGENT_VERSION=2026\.08\.11-e8db854/)
    assert.match(source, /ARG OC_INCLUDE_CURSOR=0/)
    assert.match(source, /if \[ "\$OC_INCLUDE_CURSOR" = "1" \]/)
    assert.match(
      source,
      /OC_CURSOR_AGENT_SHA256=bfff4bf6f4e9dd30c1d0ef0a70b6077b074015dd2948e4c50685d53afdcfce5a/,
    )
    assert.match(source, /sha256sum -c -/)
    assert.match(source, /chmod -R a-w "\$install_root"/)
    assert.match(source, /cursor-agent --version/)
    assert.match(buildSource, /CURSOR_AGENT_VERSION="2026\.08\.11-e8db854"/)
    assert.match(
      wrapperSource,
      /\/usr\/bin\/sudo -n \/usr\/bin\/test -f "\$auth_file" 2>\/dev\/null/,
    )
    assert.doesNotMatch(wrapperSource, /\[ -e "\$auth_file" \]/)
    assert.match(
      buildSource,
      /CURSOR_AGENT_SHA256="bfff4bf6f4e9dd30c1d0ef0a70b6077b074015dd2948e4c50685d53afdcfce5a"/,
    )
    assert.match(buildSource, /oc\.runtime\.include_cursor=\$\{OC_INCLUDE_CURSOR:-0\}/)
    assert.match(buildSource, /OC_INCLUDE_CURSOR=\$\{OC_INCLUDE_CURSOR:-0\}/)
  })

  // Absolute paths make executable resolution deterministic, but they also
  // make a tool that is absent from the runtime image exit 127 — and every
  // call in the termination path is followed by `|| true`. That is how
  // /bin/kill (procps, which the image does not install) turned the whole
  // Stop path into dead code that still passed on a developer host.
  test('never depends on an absolute-path tool it has not asserted is present', () => {
    const wrapperSource = readFileSync(sourceWrapper, 'utf8')
    const declaration = wrapperSource.match(/for required_tool in ([\s\S]*?); do/)
    assert.ok(declaration, 'the wrapper must assert its required tools up front')
    const declared = new Set(declaration[1]!.split(/\s+/).filter((token) => token.startsWith('/')))
    const body = wrapperSource
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
      .replace(/for required_tool in [\s\S]*?; do/, '')
    const invoked = new Set(body.match(/\/(?:usr\/)?bin\/[A-Za-z0-9_.-]+/g) ?? [])
    // These two resolve SELF_ROOT before `die` exists, and their absence is
    // already fatal through the `[ -d "$SELF_ROOT" ]` guard.
    invoked.delete('/usr/bin/dirname')
    invoked.delete('/usr/bin/readlink')
    assert.deepEqual([...invoked].filter((tool) => !declared.has(tool)).sort(), [])

    assert.doesNotMatch(
      body,
      /\/bin\/kill/,
      'kill must stay the shell builtin: /bin/kill is procps, absent from the runtime image',
    )
    assert.match(body, /kill -TERM "-\$child_pid"/)
    assert.match(body, /kill -KILL "-\$child_pid"/)
  })

  test('fails closed when the runtime image lacks a tool it invokes by absolute path', () => {
    const f = fixture()
    const broken = join(f.dir, 'oc-cursor-missing-tool')
    writeFileSync(
      broken,
      readFileSync(f.wrapper, 'utf8').replace('/usr/bin/stat', '/usr/bin/oc-absent-tool'),
      { mode: 0o755 },
    )
    chmodSync(broken, 0o755)
    const result = spawnSync(broken, ['--', 'hello'], {
      cwd: f.dir,
      env: f.env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /runtime image is missing \/usr\/bin\/oc-absent-tool/)
  })

  test('injects the key only into a one-shot child and preserves stream-json output byte-for-byte', () => {
    const f = fixture()
    const result = spawnSync(
      f.wrapper,
      [
        '--model',
        'composer-2.5-fast',
        '--mode',
        'plan',
        '--force',
        '--',
        'inspect',
        'this',
        'diff',
      ],
      { cwd: f.dir, env: f.env, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      result.stdout,
      '{"type":"thinking","text":"checking"}\n' +
        '{"type":"assistant","text":"done"}\n' +
        '{"type":"result","subtype":"success","usage":{"inputTokens":1,"outputTokens":1}}\n',
    )
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /crsr_dummy/)

    const argv = readFileSync(join(f.capture, 'argv'), 'utf8').trim().split('\n')
    assert.deepEqual(argv, [
      '--force',
      '--mode',
      'plan',
      '--model',
      'composer-2.5-fast',
      '-p',
      '--trust',
      '--workspace',
      f.dir,
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--',
      'inspect this diff',
    ])
    const ephemeralHome = readFileSync(join(f.capture, 'home'), 'utf8').trim()
    assert.ok(ephemeralHome.startsWith('/tmp/openclaude-cursor.'))
    assert.equal(spawnSync('test', ['!', '-e', ephemeralHome]).status, 0)
    assert.doesNotMatch(readFileSync(join(f.capture, 'argv'), 'utf8'), /crsr_dummy/)
  })


  test('copies one validated adapter hooks.json and unsets the source env', () => {
    const f = fixture()
    const hooks = join(f.dir, 'adapter-hooks.json')
    const body = '{"version":1,"hooks":{"beforeShellExecution":[]}}\n'
    writeFileSync(hooks, body, { mode: 0o600 })
    chmodSync(hooks, 0o600)

    const result = spawnSync(f.wrapper, ['--', 'use platform skill'], {
      cwd: f.dir,
      env: { ...f.env, OPENCLAUDE_CURSOR_HOOKS_JSON: hooks },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(f.capture, 'hooks.json'), 'utf8'), body)
    assert.equal(readFileSync(join(f.capture, 'hooks-env'), 'utf8').trim(), 'unset')
    assert.equal(statSync(hooks).mode & 0o777, 0o600)
  })

  test('missing hooks.json fails open and still launches Cursor', () => {
    const f = fixture()
    const result = spawnSync(f.wrapper, ['--', 'use platform skill'], {
      cwd: f.dir,
      env: { ...f.env, OPENCLAUDE_CURSOR_HOOKS_JSON: join(f.dir, 'missing-hooks.json') },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /fail-open/)
    assert.equal(existsSync(join(f.capture, 'hooks.json')), false)
    assert.equal(readFileSync(join(f.capture, 'hooks-env'), 'utf8').trim(), 'unset')
  })

  test('copies one validated adapter MCP config, approves it, and unsets the source env', () => {
    const f = fixture()
    const config = join(f.dir, 'adapter-mcp.json')
    const sentinel = join(f.dir, 'source-parent-sentinel')
    const body = '{"mcpServers":{"openclaude-memory":{"command":"npx"}}}\n'
    writeFileSync(config, body, { mode: 0o600 })
    chmodSync(config, 0o600)
    writeFileSync(sentinel, 'keep')

    const result = spawnSync(f.wrapper, ['--', 'use platform skill'], {
      cwd: f.dir,
      env: { ...f.env, OPENCLAUDE_CURSOR_MCP_CONFIG: config },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const argv = readFileSync(join(f.capture, 'argv'), 'utf8').trim().split('\n')
    assert.ok(argv.includes('--approve-mcps'))
    assert.equal(readFileSync(join(f.capture, 'mcp.json'), 'utf8'), body)
    assert.equal(readFileSync(join(f.capture, 'mcp-env'), 'utf8').trim(), 'unset')
    assert.equal(statSync(config).mode & 0o777, 0o600)
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep')
  })

  test('rejects relative, symlinked, loose-mode, and foreign-owned MCP configs', () => {
    const f = fixture()
    const valid = join(f.dir, 'valid-mcp.json')
    const symlink = join(f.dir, 'symlink-mcp.json')
    const loose = join(f.dir, 'loose-mcp.json')
    writeFileSync(valid, '{}\n', { mode: 0o600 })
    symlinkSync(valid, symlink)
    writeFileSync(loose, '{}\n', { mode: 0o640 })
    chmodSync(loose, 0o640)

    const cases: Array<[string, RegExp]> = [
      ['relative-mcp.json', /must be absolute/],
      [symlink, /must not be a symlink/],
      [loose, /mode must be 0600/],
    ]
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      const foreign = join(f.dir, 'foreign-mcp.json')
      writeFileSync(foreign, '{}\n', { mode: 0o600 })
      chownSync(foreign, 65534, 65534)
      cases.push([foreign, /owner is invalid/])
    }
    for (const [config, message] of cases) {
      const result = spawnSync(f.wrapper, ['--', 'hello'], {
        cwd: f.dir,
        env: { ...f.env, OPENCLAUDE_CURSOR_MCP_CONFIG: config },
        encoding: 'utf8',
      })
      assert.equal(result.status, 2, config)
      assert.match(result.stderr, message)
    }
    assert.equal(existsSync(valid), true)
  })

  test('fails closed without a mount and rejects caller-controlled auth or endpoint flags', () => {
    const f = fixture()
    rmSync(f.auth)
    const missing = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env: f.env,
      encoding: 'utf8',
    })
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /not enabled for this account/)

    writeFileSync(f.auth, 'crsr_dummy\n', { mode: 0o600 })
    for (const args of [
      ['--api-key', 'attacker', '--', 'hello'],
      ['--endpoint=https://example.invalid', '--', 'hello'],
      ['--header', 'X-Test: value', '--', 'hello'],
      ['--output-format', 'text', '--', 'hello'],
      ['--resume', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '--', 'hello'],
      ['--continue', '--', 'hello'],
    ]) {
      const blocked = spawnSync(f.wrapper, args, {
        cwd: f.dir,
        env: f.env,
        encoding: 'utf8',
      })
      assert.equal(blocked.status, 2, args.join(' '))
      assert.match(blocked.stderr, /managed by OpenClaude/)
    }
  })

  test('rejects models outside the pinned official allowlist', () => {
    const f = fixture()
    for (const model of ['gpt-5.6-sol-medium', 'gpt-5.3-codex', 'composer-2.5-fast --force']) {
      const result = spawnSync(f.wrapper, ['--model', model, '--', 'hello'], {
        cwd: f.dir,
        env: f.env,
        encoding: 'utf8',
      })
      assert.equal(result.status, 2)
      assert.match(result.stderr, /model is not allowlisted/)
    }
  })

  test('accepts the Cursor Grok 4.6 High Fast upstream id', () => {
    const f = fixture()
    const result = spawnSync(f.wrapper, ['--model', 'cursor-grok-4.6-high-fast', '--', 'hello'], {
      cwd: f.dir,
      env: f.env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const argv = readFileSync(join(f.capture, 'argv'), 'utf8')
    assert.match(argv, /--model\ncursor-grok-4.6-high-fast\n/)
  })

  test('does not assume an undocumented Cursor API-key prefix', () => {
    const f = fixture()
    const key = 'cursor-key.with-punctuation=='
    writeFileSync(f.auth, `${key}\n`, { mode: 0o600 })
    const result = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env: f.env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
  })

  test('ignores user-writable PATH shims for every security-sensitive executable', () => {
    const f = fixture()
    for (const name of [
      'kill',
      'readlink',
      'dirname',
      'sudo',
      'cat',
      'ls',
      'mktemp',
      'rm',
      'setsid',
      'stat',
      'id',
      'mkdir',
      'cp',
      'chmod',
      'date',
      'ln',
    ]) {
      const marker = join(f.capture, `path-hijack-${name}`)
      const shim = join(f.dir, 'bin', name)
      writeFileSync(shim, `#!/bin/sh\nprintf invoked > ${marker}\nexit 97\n`, { mode: 0o755 })
      chmodSync(shim, 0o755)
    }
    const result = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env: f.env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    for (const name of [
      'kill',
      'readlink',
      'dirname',
      'sudo',
      'cat',
      'ls',
      'mktemp',
      'rm',
      'setsid',
      'stat',
      'id',
      'mkdir',
      'cp',
      'chmod',
      'date',
      'ln',
    ]) {
      assert.equal(
        spawnSync('test', ['!', '-e', join(f.capture, `path-hijack-${name}`)]).status,
        0,
        `${name} must not resolve through user PATH`,
      )
    }
  })

  test(
    'Stop terminates the Cursor process group and removes auth state',
    { timeout: 5_000 },
    async () => {
      const f = fixture()
      const child = spawn(f.wrapper, ['--', 'long task'], {
        cwd: f.dir,
        env: { ...f.env, OC_CURSOR_TEST_SLEEP: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const homeFile = join(f.capture, 'home')
      for (let i = 0; i < 40; i += 1) {
        if (spawnSync('test', ['-f', homeFile]).status === 0) break
        await new Promise((resolveReady) => setTimeout(resolveReady, 50))
      }
      assert.equal(spawnSync('test', ['-f', homeFile]).status, 0, 'fake CLI did not start')
      child.kill('SIGTERM')
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })),
      )
      assert.ok(result.code === 143 || result.signal === 'SIGTERM')
      assert.equal(readFileSync(join(f.capture, 'term'), 'utf8'), 'term')
      const ephemeralHome = readFileSync(homeFile, 'utf8').trim()
      assert.equal(spawnSync('test', ['!', '-e', ephemeralHome]).status, 0)
    },
  )

  test('normal completion terminates lingering tool children that inherited the key', () => {
    const f = fixture()
    const result = spawnSync(f.wrapper, ['--', 'spawn and return'], {
      cwd: f.dir,
      env: { ...f.env, OC_CURSOR_TEST_ORPHAN: '1' },
      encoding: 'utf8',
      timeout: 5_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(f.capture, 'orphan-term'), 'utf8'), 'term')
    const ephemeralHome = readFileSync(join(f.capture, 'home'), 'utf8').trim()
    assert.equal(spawnSync('test', ['!', '-e', ephemeralHome]).status, 0)
  })

  test('single-key accounts keep the legacy path with no rotation stderr', () => {
    const f = fixture()
    const result = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env: f.env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /credential slot/)
    assert.equal(readFileSync(join(f.capture, 'key'), 'utf8'), 'crsr_dummy\n')
  })

  test('prefers the primary slot every turn while it succeeds and never writes rotation state', () => {
    const f = fixture()
    const authDir = dirname(f.auth)
    writeFileSync(join(authDir, 'api-key.2'), 'crsr_second\n', { mode: 0o600 })
    const rotation = join(f.dir, 'rotation')
    const env = { ...f.env, OC_CURSOR_KEY_ROTATION_FILE: rotation }
    for (let turn = 0; turn < 3; turn += 1) {
      const result = spawnSync(f.wrapper, ['--', 'hello'], {
        cwd: f.dir,
        env,
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(readFileSync(join(f.capture, 'key'), 'utf8'), 'crsr_dummy\n')
      assert.match(result.stderr, /credential slot 1\/2/)
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /crsr_dummy|crsr_second/)
    }
    assert.equal(existsSync(rotation), false)
  })

  test('a failing primary fails over to the backup and is probed again after the cooldown', () => {
    const f = fixture()
    const authDir = dirname(f.auth)
    writeFileSync(join(authDir, 'api-key.2'), 'crsr_second\n', { mode: 0o600 })
    const rotation = join(f.dir, 'rotation')
    const env = {
      ...f.env,
      OC_CURSOR_KEY_ROTATION_FILE: rotation,
      OC_CURSOR_TEST_FAIL_ON_KEY: 'crsr_dummy',
    }

    // Primary fails: non-zero exit, failover armed with a future expiry.
    const first = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env,
      encoding: 'utf8',
    })
    assert.equal(first.status, 1, first.stderr)
    assert.match(first.stderr, /credential slot 1\/2/)
    assert.doesNotMatch(`${first.stdout}${first.stderr}`, /crsr_dummy|crsr_second/)
    const armed = readFileSync(rotation, 'utf8').trim().split(' ')
    assert.equal(armed[0], '1')
    assert.ok(Number(armed[1]) > Math.floor(Date.now() / 1000))

    // Cooldown still active: the backup serves and the state is untouched.
    const second = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env,
      encoding: 'utf8',
    })
    assert.equal(second.status, 0, second.stderr)
    assert.match(second.stderr, /credential slot 2\/2/)
    assert.equal(readFileSync(join(f.capture, 'key'), 'utf8'), 'crsr_second\n')
    assert.equal(readFileSync(rotation, 'utf8').trim(), armed.join(' '))

    // Cooldown elapsed: the primary is probed again and re-armed on failure.
    writeFileSync(rotation, `1 1\n`)
    const third = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env,
      encoding: 'utf8',
    })
    assert.equal(third.status, 1, third.stderr)
    assert.match(third.stderr, /credential slot 1\/2/)
    assert.match(readFileSync(rotation, 'utf8').trim(), /^1 \d+$/)
  })

  test('ignores non-canonical extra names and keeps one effective slot', () => {
    const f = fixture()
    const authDir = dirname(f.auth)
    for (const name of [
      'api-key.1',
      'api-key.02',
      'api-key.0',
      'api-key.foo',
      'api-key.txt',
      'api-key.3.bak',
      'staging.tmp',
    ]) {
      writeFileSync(join(authDir, name), 'crsr_junk\n', { mode: 0o600 })
    }
    const rotation = join(f.dir, 'rotation')
    for (let turn = 0; turn < 2; turn += 1) {
      const result = spawnSync(f.wrapper, ['--', 'hello'], {
        cwd: f.dir,
        env: { ...f.env, OC_CURSOR_KEY_ROTATION_FILE: rotation },
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stderr, /credential slot/)
      assert.equal(readFileSync(join(f.capture, 'key'), 'utf8'), 'crsr_dummy\n')
    }
    assert.equal(existsSync(rotation), false)
  })

  test('a malformed failover slot fails its own turn and the pool self-heals', () => {
    const f = fixture()
    const authDir = dirname(f.auth)
    writeFileSync(join(authDir, 'api-key.2'), 'crsr_bad\ncrsr_second\n', { mode: 0o600 })
    const rotation = join(f.dir, 'rotation')
    const env = { ...f.env, OC_CURSOR_KEY_ROTATION_FILE: rotation }

    // Arm the failover with a live cooldown, as a primary failure would.
    writeFileSync(rotation, `1 ${Math.floor(Date.now() / 1000) + 3600}\n`)

    const first = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env,
      encoding: 'utf8',
    })
    assert.equal(first.status, 2)
    assert.match(first.stderr, /Cursor credential is malformed/)
    assert.doesNotMatch(first.stderr, /crsr_bad|crsr_second/)
    // The dead slot is skipped: wraparound back to the primary under cooldown.
    assert.match(readFileSync(rotation, 'utf8').trim(), /^0 \d+$/)

    const second = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env,
      encoding: 'utf8',
    })
    assert.equal(second.status, 0, second.stderr)
    assert.equal(readFileSync(join(f.capture, 'key'), 'utf8'), 'crsr_dummy\n')
  })

  test('resumes via env, links durable chats, and keeps the store after HOME is removed', () => {
    const f = fixture()
    const ocHome = join(f.dir, 'oc-home')
    mkdirSync(ocHome, { mode: 0o700 })
    const resumeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const result = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env: {
        ...f.env,
        OPENCLAUDE_HOME: ocHome,
        OPENCLAUDE_CURSOR_RESUME_ID: resumeId,
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const argv = readFileSync(join(f.capture, 'argv'), 'utf8').trim().split('\n')
    const sep = argv.indexOf('--')
    const resumeAt = argv.indexOf('--resume')
    assert.ok(resumeAt >= 0, argv.join(' '))
    assert.ok(sep > resumeAt, argv.join(' '))
    assert.equal(argv[resumeAt + 1], resumeId)
    assert.ok(argv.includes('--output-format'))
    assert.ok(argv.includes('stream-json'))
    assert.ok(argv.indexOf('--output-format') < sep)
    assert.ok(argv.indexOf('stream-json') < sep)
    assert.equal(readFileSync(join(f.capture, 'chats-link'), 'utf8').trim(), join(ocHome, 'cursor-chats'))
    assert.equal(statSync(join(ocHome, 'cursor-chats')).isDirectory(), true)
    assert.equal(statSync(join(ocHome, 'cursor-chats')).isSymbolicLink(), false)
    const ephemeralHome = readFileSync(join(f.capture, 'home'), 'utf8').trim()
    assert.ok(ephemeralHome.startsWith('/tmp/openclaude-cursor.'))
    assert.equal(spawnSync('test', ['!', '-e', ephemeralHome]).status, 0)
    assert.equal(existsSync(join(ocHome, 'cursor-chats')), true)
    assert.equal(readFileSync(join(f.capture, 'resume-env'), 'utf8').trim(), 'unset')
  })

  test('rejects a malformed Cursor resume id without invoking the CLI', () => {
    const f = fixture()
    const ocHome = join(f.dir, 'oc-home')
    mkdirSync(ocHome, { mode: 0o700 })
    const pwned = join(f.dir, 'pwned')
    for (const bad of ['not-a-uuid', `$(touch ${pwned})`]) {
      const result = spawnSync(f.wrapper, ['--', 'hello'], {
        cwd: f.dir,
        env: {
          ...f.env,
          OPENCLAUDE_HOME: ocHome,
          OPENCLAUDE_CURSOR_RESUME_ID: bad,
        },
        encoding: 'utf8',
      })
      assert.notEqual(result.status, 0, bad)
      assert.match(result.stderr, /invalid Cursor resume id/)
      assert.equal(existsSync(join(f.capture, 'home')), false, `CLI invoked for ${bad}`)
      assert.equal(existsSync(pwned), false)
    }
  })

  test('refuses to resume when OPENCLAUDE_HOME is unset', () => {
    const f = fixture()
    const env: NodeJS.ProcessEnv = {
      ...f.env,
      OPENCLAUDE_CURSOR_RESUME_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    }
    delete env.OPENCLAUDE_HOME
    const result = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /Cursor resume requires durable chats directory/)
    assert.equal(existsSync(join(f.capture, 'home')), false)
  })

  test('Other Models skip cursor_only and emit the full-pool slot_result', () => {
    const f = fixture()
    const authDir = dirname(f.auth)
    writeFileSync(join(authDir, 'api-key.2'), 'crsr_second\n', { mode: 0o600 })
    writeFileSync(
      join(authDir, '.quota-class'),
      '# quota-class v1\napi-key cursor_only\napi-key.2 unknown\n',
      { mode: 0o600 },
    )
    const result = spawnSync(
      f.wrapper,
      ['--model', 'claude-opus-5-thinking-high', '--', 'hello world'],
      { cwd: f.dir, env: f.env, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(f.capture, 'key'), 'utf8').trim(), 'crsr_second')
    assert.match(result.stderr, /slot_result 2 ok/)
    assert.match(readFileSync(join(f.capture, 'argv'), 'utf8'), /hello world/)
  })

  test('Cursor Models still use a cursor_only primary', () => {
    const f = fixture()
    const authDir = dirname(f.auth)
    writeFileSync(join(authDir, 'api-key.2'), 'crsr_second\n', { mode: 0o600 })
    writeFileSync(
      join(authDir, '.quota-class'),
      '# quota-class v1\napi-key cursor_only\napi-key.2 unknown\n',
      { mode: 0o600 },
    )
    const result = spawnSync(f.wrapper, ['--model', 'cursor-grok-4.6-high', '--', 'hello'], {
      cwd: f.dir,
      env: f.env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(f.capture, 'key'), 'utf8').trim(), 'crsr_dummy')
    assert.match(result.stderr, /slot_result 1 ok/)
  })


  test('passes -H x-cursor-client-type: sand and sets NODE_OPTIONS hook when .sand-mode is enabled for the chosen slot', () => {
    const f = fixture()
    const authDir = dirname(f.auth)
    writeFileSync(
      join(authDir, '.sand-mode'),
      '# sand-mode v1\napi-key 1\n',
      { mode: 0o600 },
    )
    const result = spawnSync(
      f.wrapper,
      ['--model', 'cursor-grok-4.6-high', '--', 'hello sand'],
      { cwd: f.dir, env: f.env, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const argv = readFileSync(join(f.capture, 'argv'), 'utf8').trim().split('\n')
    const headerIdx = argv.indexOf('-H')
    assert.ok(headerIdx >= 0, 'argv must include -H flag')
    assert.equal(argv[headerIdx + 1], 'x-cursor-client-type: sand')
  })

  test('does not pass -H x-cursor-client-type: sand when .sand-mode is 0 or missing', () => {
    const f = fixture()
    const authDir = dirname(f.auth)
    writeFileSync(
      join(authDir, '.sand-mode'),
      '# sand-mode v1\napi-key 0\n',
      { mode: 0o600 },
    )
    const result = spawnSync(
      f.wrapper,
      ['--model', 'cursor-grok-4.6-high', '--', 'hello normal'],
      { cwd: f.dir, env: f.env, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const argv = readFileSync(join(f.capture, 'argv'), 'utf8').trim().split('\n')
    assert.equal(argv.includes('-H'), false, 'argv must not include -H flag')
  })

  test('Other Models periodically recheck an all-cursor_only pool and recover on success', () => {
    const f = fixture()
    const recheckFile = join(f.dir, 'other-models-recheck')
    writeFileSync(
      join(dirname(f.auth), '.quota-class'),
      '# quota-class v1\napi-key cursor_only\n',
      { mode: 0o600 },
    )
    const result = spawnSync(
      f.wrapper,
      ['--model', 'claude-opus-5-thinking-high', '--', 'hello'],
      {
        cwd: f.dir,
        env: { ...f.env, OC_CURSOR_OTHER_MODELS_RECHECK_FILE: recheckFile },
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(f.capture, 'key'), 'utf8').trim(), 'crsr_dummy')
    assert.match(result.stderr, /slot_result 1 ok/)
    assert.equal(existsSync(recheckFile), false)
  })

  test('a failed all-cursor_only recheck is throttled, then retried after expiry', () => {
    const f = fixture()
    const recheckFile = join(f.dir, 'other-models-recheck')
    const captureKey = join(f.capture, 'key')
    writeFileSync(
      join(dirname(f.auth), '.quota-class'),
      '# quota-class v1\napi-key cursor_only\n',
      { mode: 0o600 },
    )
    const env = {
      ...f.env,
      OC_CURSOR_OTHER_MODELS_RECHECK_FILE: recheckFile,
      OC_CURSOR_TEST_FAIL_ON_KEY: 'crsr_dummy',
    }

    const first = spawnSync(
      f.wrapper,
      ['--model', 'claude-opus-5-thinking-high', '--', 'hello'],
      { cwd: f.dir, env, encoding: 'utf8' },
    )
    assert.equal(first.status, 1)
    assert.match(first.stderr, /slot_result 1 fail/)
    assert.match(readFileSync(recheckFile, 'utf8'), /^\d+\n$/)

    rmSync(captureKey, { force: true })
    const throttled = spawnSync(
      f.wrapper,
      ['--model', 'claude-opus-5-thinking-high', '--', 'hello'],
      { cwd: f.dir, env, encoding: 'utf8' },
    )
    assert.equal(throttled.status, 2)
    assert.match(throttled.stderr, /other-models quota unavailable/)
    assert.equal(existsSync(captureKey), false)

    writeFileSync(recheckFile, '0\n', { mode: 0o600 })
    const recovered = spawnSync(
      f.wrapper,
      ['--model', 'claude-opus-5-thinking-high', '--', 'hello'],
      {
        cwd: f.dir,
        env: { ...f.env, OC_CURSOR_OTHER_MODELS_RECHECK_FILE: recheckFile },
        encoding: 'utf8',
      },
    )
    assert.equal(recovered.status, 0, recovered.stderr)
    assert.match(recovered.stderr, /slot_result 1 ok/)
    assert.equal(existsSync(recheckFile), false)
  })
})

// ── 冷启动诊断门(OPENCLAUDE_CURSOR_AGENT_DEBUG,INC-20260824)────────────────

describe('oc-cursor debug gate', () => {
  function sessionHash(sessionKey: string): string {
    return createHash('sha256').update(sessionKey).digest('hex').slice(0, 16)
  }

  test('默认关:CLI 收到 CURSOR_AGENT_DISABLE_DEBUG_LOG=1,不建日志目录', () => {
    const f = fixture()
    const ocHome = join(f.dir, 'ochome')
    mkdirSync(ocHome, { recursive: true })
    const result = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env: { ...f.env, OPENCLAUDE_HOME: ocHome, OC_SESSION_KEY: 'agent:main:webchat:dm:g1' },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(f.capture, 'disable-debug'), 'utf8').trim(), '1')
    assert.equal(existsSync(join(ocHome, 'logs', 'cursor-cli')), false)
  })

  test('开:stderr 双写入 0600 日志、仍回传网关、退出码透传、临时 HOME 已删', () => {
    const f = fixture()
    const ocHome = join(f.dir, 'ochome')
    mkdirSync(ocHome, { recursive: true })
    const sessionKey = 'agent:main:webchat:dm:debug1'
    const result = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env: {
        ...f.env,
        OPENCLAUDE_HOME: ocHome,
        OC_SESSION_KEY: sessionKey,
        OPENCLAUDE_CURSOR_AGENT_DEBUG: '1',
        OC_CURSOR_TEST_STDERR: '1',
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    // stderr 照常回传(tee 不吞流)。
    assert.match(result.stderr, /FAKE_DEBUG_LINE/)
    // stdout 逐字节不变(无管道污染)。
    assert.match(result.stdout, /"type":"result"/)
    // CLI 自己的 debug 日志未被禁用。
    assert.equal(readFileSync(join(f.capture, 'disable-debug'), 'utf8').trim(), 'unset')
    // durable 日志:0600 文件、0700 目录、内容含 stderr。
    const logDir = join(ocHome, 'logs', 'cursor-cli')
    const logFile = join(logDir, `cursor-cli-${sessionHash(sessionKey)}.log`)
    assert.ok(existsSync(logFile), 'durable debug log must exist')
    assert.equal(statSync(logDir).mode & 0o777, 0o700)
    assert.equal(statSync(logFile).mode & 0o777, 0o600)
    assert.match(readFileSync(logFile, 'utf8'), /FAKE_DEBUG_LINE/)
    // 临时 HOME 已随 turn 销毁(debug 不改变一次性生命周期)。
    const ephemeralHome = readFileSync(join(f.capture, 'home'), 'utf8').trim()
    assert.equal(spawnSync('test', ['!', '-e', ephemeralHome]).status, 0)
    // 密钥不进日志。
    assert.doesNotMatch(readFileSync(logFile, 'utf8'), /crsr_dummy/)
  })

  test('开 + CLI 失败:非零退出码原样透传(tee 不吞状态)', () => {
    const f = fixture()
    const ocHome = join(f.dir, 'ochome')
    mkdirSync(ocHome, { recursive: true })
    const result = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env: {
        ...f.env,
        OPENCLAUDE_HOME: ocHome,
        OC_SESSION_KEY: 'agent:main:webchat:dm:debug2',
        OPENCLAUDE_CURSOR_AGENT_DEBUG: '1',
        OC_CURSOR_TEST_FAIL_ON_KEY: 'crsr_dummy',
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
  })

  test('日志目录被 symlink 劫持 → fail-open 无日志,turn 正常完成', () => {
    const f = fixture()
    const ocHome = join(f.dir, 'ochome')
    const evil = join(f.dir, 'evil-target')
    mkdirSync(join(ocHome, 'logs'), { recursive: true })
    mkdirSync(evil, { recursive: true })
    symlinkSync(evil, join(ocHome, 'logs', 'cursor-cli'))
    const result = spawnSync(f.wrapper, ['--', 'hello'], {
      cwd: f.dir,
      env: {
        ...f.env,
        OPENCLAUDE_HOME: ocHome,
        OC_SESSION_KEY: 'agent:main:webchat:dm:debug3',
        OPENCLAUDE_CURSOR_AGENT_DEBUG: '1',
        OC_CURSOR_TEST_STDERR: '1',
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    // symlink 目标不得收到任何日志;CLI 回到禁用 debug 的默认行为。
    assert.equal(spawnSync('sh', ['-c', `ls -A ${evil} | wc -l`], { encoding: 'utf8' }).stdout.trim(), '0')
    assert.equal(readFileSync(join(f.capture, 'disable-debug'), 'utf8').trim(), '1')
  })
})
