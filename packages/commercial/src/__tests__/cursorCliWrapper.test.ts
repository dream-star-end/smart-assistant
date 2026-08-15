import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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
if [ -f "$HOME/.cursor/mcp.json" ]; then
  /bin/cp "$HOME/.cursor/mcp.json" "$OC_CURSOR_TEST_CAPTURE/mcp.json"
fi
printf '%s\\n' "\${OPENCLAUDE_CURSOR_HOOKS_JSON-unset}" > "$OC_CURSOR_TEST_CAPTURE/hooks-env"
if [ -f "$HOME/.cursor/hooks.json" ]; then
  /bin/cp "$HOME/.cursor/hooks.json" "$OC_CURSOR_TEST_CAPTURE/hooks.json"
fi
/bin/mkdir -p "$HOME/.config/cursor"
printf '%s\\n' "\${CURSOR_API_KEY}" > "$HOME/.config/cursor/auth.json"
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
    .replace('/usr/bin/sudo -n /usr/bin/test -f', '/usr/bin/test -f')
    .replace('/usr/bin/sudo -n /bin/cat', '/bin/cat')
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
      'mktemp',
      'rm',
      'setsid',
      'stat',
      'id',
      'mkdir',
      'cp',
      'chmod',
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
      'mktemp',
      'rm',
      'setsid',
      'stat',
      'id',
      'mkdir',
      'cp',
      'chmod',
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
})
