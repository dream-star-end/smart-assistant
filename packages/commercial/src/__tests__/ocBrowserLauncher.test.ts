import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)))
const SOURCE = join(
  REPO_ROOT,
  'packages/commercial/agent-sandbox/platform-runtime/bin/oc-browser.sh',
)

type Result = { code: number | null; stdout: string; stderr: string }

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((done, reject) => {
    const child = spawn(file, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
  })
}

type FixtureOpts = {
  baseConfig?: Record<string, unknown>
  seedConfig?: Record<string, unknown>
  withFakeChrome?: boolean
}

function fixture(opts: FixtureOpts = {}): {
  root: string
  home: string
  launcher: string
  log: string
  state: string
  release: string
  config: string
  seedConfigPath?: string
  env: NodeJS.ProcessEnv
  cleanup(): void
} {
  const root = mkdtempSync(join(tmpdir(), 'oc-browser-launcher-'))
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  const home = join(root, 'home')
  const fakeCli = join(root, 'playwright-cli')
  const config = join(root, 'playwright-cli.config.json')
  const launcher = join(binDir, 'oc-browser')
  const log = join(root, 'calls.log')
  const state = join(root, 'state')
  const release = join(root, 'release')
  const core = join(root, 'node_modules/playwright-core')
  mkdirSync(join(core, 'lib/tools/cli-client'), { recursive: true })
  writeFileSync(join(core, 'package.json'), '{"name":"playwright-core"}\n')
  writeFileSync(join(core, 'lib/tools/cli-client/session.js'), `
exports.Session = class Session {
  async run() {
    return JSON.parse(process.env.OC_BROWSER_TEST_RESULT || '{"text":"ok"}');
  }
};
`)
  writeFileSync(
    fakeCli,
    `#!/usr/bin/env node
const fs = require('node:fs');
const { Session } = require('./node_modules/playwright-core/lib/tools/cli-client/session.js');
const e = process.env, args = process.argv.slice(2);
const extraMcp = Object.keys(e).filter((k) => k.startsWith('PLAYWRIGHT_MCP_') && k !== 'PLAYWRIGHT_MCP_CONFIG').sort().join(',');
fs.appendFileSync(e.OC_BROWSER_TEST_LOG, ['start', e.PLAYWRIGHT_CLI_SESSION,
  e.XDG_CACHE_HOME, process.cwd(), args.join(' '), e.PLAYWRIGHT_MCP_CONFIG,
  e.PLAYWRIGHT_MCP_CDP_ENDPOINT || '', e.PWTEST_SOCKETS_DIR,
  e.DISPLAY || '', e.NODE_OPTIONS || '', extraMcp].join('\\t') + '\\n');
(async () => {
  const deadline = Date.now() + 5000;
  while (args[0] === 'hold' && !fs.existsSync(e.OC_BROWSER_TEST_RELEASE)) {
    if (Date.now() > deadline) throw new Error('test hold was not released');
    await new Promise(r => setTimeout(r, 20));
  }
  if (args[0] === 'tab-list' && e.OC_BROWSER_TEST_TAB_LIST_FAIL === '1') {
    process.exitCode = 1;
    fs.appendFileSync(e.OC_BROWSER_TEST_LOG, 'end\\t' + args.join(' ') + '\\n');
    return;
  }
  const result = await new Session().run();
  console.log(result.text);
  if (e.OC_BROWSER_TEST_EXIT_CODE) process.exitCode = Number(e.OC_BROWSER_TEST_EXIT_CODE);
  fs.appendFileSync(e.OC_BROWSER_TEST_LOG, 'end\\t' + args.join(' ') + '\\n');
})();
`,
  )
  chmodSync(fakeCli, 0o755)
  writeFileSync(config, JSON.stringify(opts.baseConfig ?? {}) + '\n')

  let seedConfigPath: string | undefined
  if (opts.seedConfig) {
    const seedDir = join(root, 'seed')
    mkdirSync(seedDir, { recursive: true })
    seedConfigPath = join(seedDir, 'playwright-cli.config.json')
    writeFileSync(seedConfigPath, JSON.stringify(opts.seedConfig) + '\n')
  }

  const fakeChrome = join(root, 'fake-google-chrome-stable')
  const absentChrome = join(root, 'no-google-chrome')
  if (opts.withFakeChrome) {
    writeFileSync(fakeChrome, '#!/bin/sh\nexit 0\n')
    chmodSync(fakeChrome, 0o755)
  }

  const source = readFileSync(SOURCE, 'utf8')
    .replace('state_dir="/tmp/openclaude-playwright-cli/$agent_key"', `state_dir="${state}/$agent_key"`)
    .replace('cli_bin=/usr/local/bin/playwright-cli', `cli_bin=${fakeCli}`)
    .replace('config_file=/etc/openclaude/playwright-cli.config.json', `config_file=${config}`)
    .replace(
      'chrome_bin_stable=/usr/bin/google-chrome-stable',
      `chrome_bin_stable=${opts.withFakeChrome ? fakeChrome : absentChrome}`,
    )
    .replace('chrome_bin_compat=/usr/bin/google-chrome', `chrome_bin_compat=${absentChrome}`)
  writeFileSync(launcher, source)
  chmodSync(launcher, 0o755)
  mkdirSync(home)
  return {
    root,
    home,
    launcher,
    log,
    state,
    release,
    config,
    seedConfigPath,
    env: {
      OPENCLAUDE_HOME: home,
      OC_BROWSER_TEST_LOG: log,
      OC_BROWSER_TEST_RELEASE: release,
      OPENCLAUDE_AGENT_ID: '',
      OC_AGENT_ID: '',
      OPENCLAUDE_BROWSER_HEADLESS: '1',
      OPENCLAUDE_PLAYWRIGHT_CLI_IDLE_SECONDS: '60',
      OPENCLAUDE_PLAYWRIGHT_CLI_POLL_SECONDS: '1',
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('launcher fails closed without Agent identity and rejects session/global/browser escapes', async () => {
  const f = fixture()
  try {
    let result = await run(f.launcher, ['--version'], f.env)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /Agent identity is unavailable/)

    for (const args of [
      ['-s=other', 'snapshot'],
      ['-sother', 'snapshot'],
      ['--session=other', 'snapshot'],
      ['snapshot', '--', '--session', 'other'],
      ['open', '--profile=/tmp/shared'],
      ['open', '--config=/tmp/other.json'],
      ['open', '--executable-path', '/usr/bin/chromium'],
      ['open', '--executable-path=/usr/bin/chromium'],
      ['open', '--extension'],
      ['open', '--extension=true'],
      ['open', '--endpoint', 'ws://127.0.0.1:9222'],
      ['open', '--endpoint=ws://127.0.0.1:9222'],
      ['open', '--cdp', 'http://127.0.0.1:9222'],
      ['open', '--cdp=http://127.0.0.1:9222'],
      ['open', '--cdp-endpoint', 'http://127.0.0.1:9222'],
      ['open', '--cdp-endpoint=http://127.0.0.1:9222'],
      ['open', '--user-data-dir', '/tmp/shared'],
      ['open', '--user-data-dir=/tmp/shared'],
      ['open', '--storage-state', '/tmp/state.json'],
      ['open', '--storage-state=/tmp/state.json'],
      ['open', '--browser', 'firefox'],
      ['open', '--browser=webkit'],
      ['snapshot', '--', '--cdp-endpoint=http://127.0.0.1:9222'],
      ['kill-all'],
      ['close-all'],
      ['attach', '--cdp=http://127.0.0.1:9222'],
      ['detach'],
    ]) {
      result = await run(f.launcher, args, { ...f.env, OPENCLAUDE_AGENT_ID: 'main' })
      assert.equal(result.code, 2, args.join(' '))
    }
    assert.throws(() => readFileSync(f.log, 'utf8'))
  } finally {
    f.cleanup()
  }
})

test('registry/cache key includes raw Agent identity hash and scrubs all PLAYWRIGHT_MCP_* and NODE_OPTIONS', async () => {
  const f = fixture()
  try {
    for (const agentId of ['a/b', 'a_b']) {
      const result = await run(f.launcher, ['--version'], {
        ...f.env,
        OPENCLAUDE_AGENT_ID: agentId,
        NODE_OPTIONS: '--require=/nonexistent/evil.js',
        PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:9222',
        PLAYWRIGHT_MCP_USER_DATA_DIR: '/tmp/shared-profile',
        PLAYWRIGHT_MCP_EXECUTABLE_PATH: '/tmp/fake-browser',
        PLAYWRIGHT_MCP_BROWSER: 'firefox',
        PLAYWRIGHT_MCP_EXTENSION: '1',
        PLAYWRIGHT_MCP_INIT_SCRIPT: '/tmp/evil-init.js',
        PLAYWRIGHT_MCP_CUSTOM_ESCAPE: 'value\nPLAYWRIGHT_MCP_FAKE=1',
        PWTEST_SOCKETS_DIR: '/tmp/shared-sockets',
      })
      assert.equal(result.code, 0, result.stderr)
    }
    const starts = readFileSync(f.log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('start\t'))
    assert.equal(starts.length, 2)
    const fields = starts.map((line) => line.split('\t'))
    assert.equal(fields[0]?.[1], 'browser')
    assert.equal(fields[1]?.[1], 'browser')
    assert.equal(fields[0]?.[3], f.home)
    assert.equal(fields[1]?.[3], f.home)
    assert.notEqual(fields[0]?.[2], fields[1]?.[2], 'raw-id hash must prevent sanitized collisions')
    assert.ok(fields[0]?.[2]?.startsWith(`${f.state}/a_b-`))
    assert.match(fields[0]?.[2] ?? '', /a_b-[0-9a-f]{16}\/cache$/)
    assert.notEqual(fields[0]?.[7], fields[1]?.[7], 'each Agent must use a distinct socket directory')
    assert.ok(fields[0]?.[7]?.startsWith(`${f.state}/a_b-`))
    assert.match(fields[0]?.[7] ?? '', /a_b-[0-9a-f]{16}\/sockets$/)
    assert.equal(fields[0]?.[5], f.config)
    assert.equal(fields[0]?.[6], '')
    assert.equal(fields[0]?.[9], '', 'NODE_OPTIONS must be unset')
    assert.equal(fields[0]?.[10], '', 'every PLAYWRIGHT_MCP_* other than PLAYWRIGHT_MCP_CONFIG must be unset')
  } finally {
    f.cleanup()
  }
})

test('official structured failures set nonzero exit without interpreting or changing output/argv', async () => {
  const f = fixture()
  try {
    for (const flags of [[], ['--json'], ['--raw']]) {
      for (const isError of [false, true]) {
        const text = flags[0] === '--json'
          ? JSON.stringify({ result: { isError: true, error: 'page data, not tool status' } })
          : '### Result\n### Error\nError: legitimate page text\n多行内容'
        const args = ['eval', '() => "### Error"', ...flags]
        const result = await run(f.launcher, args, {
          ...f.env,
          OPENCLAUDE_AGENT_ID: 'error-test',
          OC_BROWSER_TEST_RESULT: JSON.stringify({ text, isError }),
        })
        assert.equal(result.code, isError ? 1 : 0, result.stderr)
        assert.equal(result.stdout, `${text}\n`)
        assert.equal(result.stderr, '')
        assert.ok(readFileSync(f.log, 'utf8').includes(`\t${args.join(' ')}\t`))
      }
    }
    const result = await run(f.launcher, ['snapshot'], {
      ...f.env,
      OPENCLAUDE_AGENT_ID: 'error-test',
      OC_BROWSER_TEST_RESULT: JSON.stringify({ isError: true, text: 'original error' }),
      OC_BROWSER_TEST_EXIT_CODE: '7',
    })
    assert.equal(result.code, 7, 'an existing nonzero CLI status must be preserved')
  } finally {
    f.cleanup()
  }
})

async function waitForFixtureSignal(ready: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (ready()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  assert.fail(message)
}

async function waitForCall(log: string, command: string): Promise<void> {
  await waitForFixtureSignal(() => existsSync(log) && readFileSync(log, 'utf8').split('\n').some((line) => {
    const fields = line.split('\t')
    return fields[0] === 'start' && fields[4] === command
  }), `CLI did not start ${command}`)
}

test('help/version bypass a held browser lock without activity or reaper side effects', async () => {
  const f = fixture()
  const env = { ...f.env, OPENCLAUDE_AGENT_ID: 'help-test' }
  let holding: Promise<Result> | undefined
  try {
    for (const args of [[], ['--help'], ['-h'], ['--version'], ['-v'], ['snapshot', '--help']]) {
      const result = await run(f.launcher, args, env)
      assert.equal(result.code, 0, result.stderr)
    }
    assert.equal(existsSync(f.state), false, 'help must not create browser state')
    holding = run(f.launcher, ['hold'], env)
    await waitForCall(f.log, 'hold')
    for (const args of [['--help'], ['--version'], ['snapshot', '-h']]) {
      const result = await run(f.launcher, args, env)
      assert.equal(result.code, 0, result.stderr)
      assert.ok(!readFileSync(f.log, 'utf8').includes('end\thold'), 'help must finish before unlock')
    }
  } finally {
    writeFileSync(f.release, '')
    if (holding) await holding
    f.cleanup()
  }
})

test('per-Agent flock serializes commands and detached reaper closes only after activity', async () => {
  const f = fixture()
  const env = {
    ...f.env,
    OPENCLAUDE_AGENT_ID: 'main',
    OPENCLAUDE_PLAYWRIGHT_CLI_IDLE_SECONDS: '1',
  }
  try {
    const holding = run(f.launcher, ['hold'], env)
    await waitForCall(f.log, 'hold')
    const waiting = run(f.launcher, ['snapshot'], env)
    // spawn alone does not mean the second launcher has registered its queue entry.
    const agentState = join(f.state, readdirSync(f.state)[0]!)
    await waitForFixtureSignal(
      () => readdirSync(agentState).some((name) => /^pending\.[1-9]\d*$/.test(name)),
      'second command did not register pending activity',
    )
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    assert.ok(!readFileSync(f.log, 'utf8').split('\n').some((line) =>
      line.startsWith('start\t') && line.split('\t')[4] === 'snapshot'))
    writeFileSync(f.release, '')
    const [held, waited] = await Promise.all([holding, waiting])
    assert.equal(held.code, 0, held.stderr)
    assert.equal(waited.code, 0, waited.stderr)

    const beforeReap = readFileSync(f.log, 'utf8').trim().split('\n')
    const holdEnd = beforeReap.indexOf('end\thold')
    const snapshotStart = beforeReap.findIndex((line) => line.startsWith('start\t') && line.split('\t')[4] === 'snapshot')
    assert.ok(holdEnd >= 0 && snapshotStart > holdEnd, 'second command must wait for the first')

    const deadline = Date.now() + 4_000
    while (Date.now() < deadline) {
      if (readFileSync(f.log, 'utf8').split('\n').some((line) => line.endsWith('\tclose'))) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    const afterReap = readFileSync(f.log, 'utf8').trim().split('\n')
    const snapshotEnd = afterReap.indexOf('end\tsnapshot')
    const closeStart = afterReap.findIndex((line) => line.endsWith('\tclose'))
    assert.ok(closeStart > snapshotEnd, 'idle reaper must close only after queued activity completes')
    const starts = afterReap
      .filter((line) => line.startsWith('start\t'))
      .map((line) => line.split('\t'))
    const snapshot = starts.find((fields) => fields[4] === 'snapshot')
    const close = starts.find((fields) => fields[4] === 'close')
    assert.equal(close?.[7], snapshot?.[7], 'idle reaper must close the same Agent socket')
  } finally {
    f.cleanup()
  }
})

test('positional or cancelled help flags cannot bypass the browser lock', async () => {
  const f = fixture()
  const env = { ...f.env, OPENCLAUDE_AGENT_ID: 'ambiguous-help' }
  const holding = run(f.launcher, ['hold'], env)
  const pending: Promise<Result>[] = []
  try {
    await waitForCall(f.log, 'hold')
    for (const args of [
      ['snapshot', '--', '--help'],
      ['snapshot', '--help', '--help=false'],
      ['snapshot', '--help', 'false'],
    ]) pending.push(run(f.launcher, args, env))
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
    assert.equal(readFileSync(f.log, 'utf8').split('\n').filter((line) => line.startsWith('start\t')).length, 1)
  } finally {
    writeFileSync(f.release, '')
    await Promise.all([holding, ...pending])
    f.cleanup()
  }
})

test('OPENCLAUDE_BROWSER_OPEN_IF_IDLE converts open to tab-list when session exists and opens when idle', async () => {
  const f = fixture()
  const env = { ...f.env, OPENCLAUDE_AGENT_ID: 'open-if-idle' }
  try {
    // When tab-list succeeds, open must switch to tab-list instead of replacing the page.
    let res = await run(f.launcher, ['open', 'https://example.com'], {
      ...env,
      OPENCLAUDE_BROWSER_OPEN_IF_IDLE: '1',
    })
    assert.equal(res.code, 0, res.stderr)
    let cmds = readFileSync(f.log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('start\t'))
      .map((line) => line.split('\t')[4])
    assert.deepEqual(cmds, ['tab-list', 'tab-list'])

    // When tab-list fails (no live session), open proceeds normally.
    writeFileSync(f.log, '')
    res = await run(f.launcher, ['open', 'https://example.com'], {
      ...env,
      OPENCLAUDE_BROWSER_OPEN_IF_IDLE: '1',
      OC_BROWSER_TEST_TAB_LIST_FAIL: '1',
    })
    assert.equal(res.code, 0, res.stderr)
    cmds = readFileSync(f.log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('start\t'))
      .map((line) => line.split('\t')[4])
    assert.deepEqual(cmds, ['tab-list', 'open https://example.com'])
  } finally {
    await run(f.launcher, ['close'], env)
    f.cleanup()
  }
})

test('human-takeover.json blocks agent commands including close, allows internal/list/expired, and protects reaper', async () => {
  const f = fixture()
  const env = {
    ...f.env,
    OPENCLAUDE_AGENT_ID: 'takeover-agent',
    OPENCLAUDE_PLAYWRIGHT_CLI_IDLE_SECONDS: '1',
    OPENCLAUDE_PLAYWRIGHT_CLI_POLL_SECONDS: '1',
  }
  try {
    // Initialize agent state & reaper via an initial command.
    let res = await run(f.launcher, ['open', 'about:blank'], env)
    assert.equal(res.code, 0, res.stderr)
    const agentState = join(f.state, readdirSync(f.state)[0]!)
    const leasePath = join(agentState, 'human-takeover.json')
    const now = Date.now()
    writeFileSync(
      leasePath,
      JSON.stringify({ token: 'tok-1', acquiredAt: now, updatedAt: now, expiresAt: now + 60_000 }),
    )

    // Normal agent commands (including close and delete-data) fail with exit 1 and preserve takeover lease.
    for (const args of [['snapshot'], ['open', 'https://example.com'], ['close'], ['delete-data']]) {
      res = await run(f.launcher, args, env)
      assert.equal(res.code, 1, args.join(' '))
      assert.match(
        res.stderr,
        /oc-browser: browser is currently under human takeover; wait for user to hand back control/,
      )
    }
    assert.equal(existsSync(leasePath), true, 'blocked close must not clear human-takeover.json')
    assert.equal(existsSync(join(agentState, 'activity')), true, 'blocked close must preserve activity')
    assert.ok(
      !readFileSync(f.log, 'utf8').split('\n').some((line) => line.endsWith('\tclose')),
      'blocked external close must never invoke playwright-cli close',
    )

    // Read-only list, help/version, and internal Gateway calls are allowed during takeover.
    res = await run(f.launcher, ['list'], env)
    assert.equal(res.code, 0, res.stderr)
    res = await run(f.launcher, ['--version'], env)
    assert.equal(res.code, 0, res.stderr)
    res = await run(f.launcher, ['snapshot'], { ...env, OPENCLAUDE_LIVE_BROWSER_INTERNAL: '1' })
    assert.equal(res.code, 0, res.stderr)

    // Reaper must NOT close the session while human-takeover.json is unexpired.
    await new Promise((r) => setTimeout(r, 2_200))
    assert.ok(
      !readFileSync(f.log, 'utf8').split('\n').some((line) => line.endsWith('\tclose')),
      'reaper must skip closing while human-takeover.json is active',
    )

    // Internal Gateway close (OPENCLAUDE_LIVE_BROWSER_INTERNAL=1) IS allowed during active takeover.
    res = await run(f.launcher, ['close'], { ...env, OPENCLAUDE_LIVE_BROWSER_INTERNAL: '1' })
    assert.equal(res.code, 0, res.stderr)
    assert.equal(existsSync(leasePath), false, 'internal close must clear human-takeover.json')
    assert.ok(
      readFileSync(f.log, 'utf8').split('\n').some((line) => line.endsWith('\tclose')),
      'internal close must invoke playwright-cli close',
    )

    // Re-open, write an expired lease, and verify agent commands proceed and idle reaper closes.
    writeFileSync(f.log, '')
    res = await run(f.launcher, ['open', 'about:blank'], env)
    assert.equal(res.code, 0, res.stderr)
    writeFileSync(
      leasePath,
      JSON.stringify({ token: 'tok-2', acquiredAt: now - 10_000, updatedAt: now - 10_000, expiresAt: Date.now() - 1000 }),
    )
    res = await run(f.launcher, ['snapshot'], env)
    assert.equal(res.code, 0, res.stderr)

    await waitForFixtureSignal(
      () => readFileSync(f.log, 'utf8').split('\n').some((line) => line.endsWith('\tclose')),
      'reaper did not close after human-takeover lease expired',
    )
  } finally {
    await run(f.launcher, ['close'], { ...env, OPENCLAUDE_LIVE_BROWSER_INTERNAL: '1' })
    f.cleanup()
  }
})

test('profile-dir declaration, stale SingletonLock cleanup, live-process protection, and close vs delete-data retention', async () => {
  const f = fixture()
  const env = { ...f.env, OPENCLAUDE_AGENT_ID: 'profile-agent' }
  let fakeChromeProc: ReturnType<typeof spawn> | undefined
  try {
    let res = await run(f.launcher, ['open', 'about:blank'], env)
    assert.equal(res.code, 0, res.stderr)

    const agentKey = readdirSync(f.state)[0]!
    const agentState = join(f.state, agentKey)
    const profileDir = readFileSync(join(agentState, 'profile-dir'), 'utf8').trim()
    assert.equal(profileDir, join(f.home, 'browser-profiles', agentKey))
    assert.equal(existsSync(profileDir), true)

    // Create a persistent cookie marker + stale dangling SingletonLock/Cookie/Socket/DevToolsActivePort.
    const cookieFile = join(profileDir, 'Cookies')
    writeFileSync(cookieFile, 'cf_clearance=demo')
    symlinkSync('dead-host-999999', join(profileDir, 'SingletonLock'))
    symlinkSync('dead-cookie', join(profileDir, 'SingletonCookie'))
    symlinkSync('/tmp/dead-socket', join(profileDir, 'SingletonSocket'))
    writeFileSync(join(profileDir, 'DevToolsActivePort'), '12345\n/devtools/browser/stale\n')

    // Re-opening with no live Chrome process must clear all stale locks while preserving Cookies.
    res = await run(f.launcher, ['open', 'about:blank'], env)
    assert.equal(res.code, 0, res.stderr)
    for (const stale of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
      assert.throws(() => lstatSync(join(profileDir, stale)), `${stale} must be cleaned`)
    }
    assert.equal(readFileSync(cookieFile, 'utf8'), 'cf_clearance=demo')

    // With a live chrome-named process holding --user-data-dir=<profileDir>, SingletonLock must NOT be deleted.
    const fakeChromeBin = join(f.root, 'fake-chrome')
    symlinkSync(process.execPath, fakeChromeBin)
    fakeChromeProc = spawn(
      fakeChromeBin,
      ['-e', 'setTimeout(() => {}, 30000)', '--', `--user-data-dir=${profileDir}`],
      { stdio: 'ignore' },
    )
    await waitForFixtureSignal(
      () => Boolean(fakeChromeProc?.pid && isPidAlive(fakeChromeProc.pid)),
      'fake-chrome did not start',
    )
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(isPidAlive(fakeChromeProc.pid!), true, 'fake-chrome must remain alive')
    symlinkSync(`live-host-${fakeChromeProc.pid}`, join(profileDir, 'SingletonLock'))
    res = await run(f.launcher, ['open', 'about:blank'], env)
    assert.equal(res.code, 0, res.stderr)
    assert.ok(lstatSync(join(profileDir, 'SingletonLock')).isSymbolicLink(), 'live profile lock must not be removed')

    // close kills orphan Chrome holding profileDir, removes runtime locks, but PRESERVES profileDir & Cookies.
    res = await run(f.launcher, ['close'], env)
    assert.equal(res.code, 0, res.stderr)
    await waitForFixtureSignal(() => !isPidAlive(fakeChromeProc!.pid!), 'close must terminate orphan Chrome process')
    fakeChromeProc = undefined
    assert.equal(existsSync(profileDir), true, 'close must preserve persistent profile directory')
    assert.equal(readFileSync(cookieFile, 'utf8'), 'cf_clearance=demo')
    assert.equal(existsSync(join(agentState, 'profile-dir')), false)
    assert.equal(existsSync(join(agentState, 'runtime-playwright-cli.config.json')), false)

    // delete-data removes profileDir completely.
    res = await run(f.launcher, ['delete-data'], env)
    assert.equal(res.code, 0, res.stderr)
    assert.equal(existsSync(profileDir), false, 'delete-data must delete persistent profile directory')

    // OPENCLAUDE_BROWSER_PROFILE_ROOT allows override strictly within OPENCLAUDE_HOME (still per-Agent isolated)
    const customRoot = join(f.home, 'browser-profile')
    res = await run(f.launcher, ['open', 'about:blank'], {
      ...env,
      OPENCLAUDE_BROWSER_PROFILE_ROOT: customRoot,
    })
    assert.equal(res.code, 0, res.stderr)
    const customProfileDir = readFileSync(join(agentState, 'profile-dir'), 'utf8').trim()
    assert.equal(customProfileDir, join(customRoot, agentKey))
    assert.equal(existsSync(customProfileDir), true)
    await run(f.launcher, ['close'], { ...env, OPENCLAUDE_BROWSER_PROFILE_ROOT: customRoot })

    // Escape attempts outside OPENCLAUDE_HOME (including dangling symlinks) must fail closed (exit 2)
    const danglingLink = join(f.home, 'dangling-profile-link')
    symlinkSync('/tmp/nonexistent-escape-profile-target', danglingLink)
    for (const badRoot of [
      '/tmp/shared-browser-profile',
      join(f.home, '..', 'escape-profile'),
      danglingLink,
      join(danglingLink, 'sub'),
    ]) {
      res = await run(f.launcher, ['open', 'about:blank'], {
        ...env,
        OPENCLAUDE_BROWSER_PROFILE_ROOT: badRoot,
      })
      assert.equal(res.code, 2, `expected escape rejection for ${badRoot}`)
      assert.match(res.stderr, /browser profile path must be a non-symlink directory within browser workspace/)
    }

    // B1: Symlinked final per-Agent profile directory (both default path & override path)
    // and symlinked parent browser-profiles directory MUST fail closed BEFORE mkdir/lock cleanup/Chrome launch!
    const outsideTarget = join(f.root, 'outside-target')
    mkdirSync(outsideTarget, { recursive: true })
    const sentinelLock = join(outsideTarget, 'SingletonLock')
    writeFileSync(sentinelLock, 'keep-me-intact')

    // Case B1-a: default path final agent dir is a symlink to outsideTarget
    mkdirSync(join(f.home, 'browser-profiles'), { recursive: true })
    rmSync(join(f.home, 'browser-profiles', agentKey), { recursive: true, force: true })
    symlinkSync(outsideTarget, join(f.home, 'browser-profiles', agentKey))
    writeFileSync(f.log, '')
    res = await run(f.launcher, ['open', 'about:blank'], env)
    assert.equal(res.code, 2, 'default symlinked agent profile dir must fail closed')
    assert.match(res.stderr, /browser profile path must be a non-symlink directory within browser workspace/)
    assert.equal(existsSync(sentinelLock), true, 'lock cleanup must NOT touch symlink target')
    assert.equal(readFileSync(f.log, 'utf8'), '', 'CLI must NOT be invoked on symlinked profile dir')
    rmSync(join(f.home, 'browser-profiles', agentKey), { force: true })

    // Case B1-b: default parent browser-profiles is itself a symlink to outsideTarget
    rmSync(join(f.home, 'browser-profiles'), { recursive: true, force: true })
    symlinkSync(outsideTarget, join(f.home, 'browser-profiles'))
    res = await run(f.launcher, ['open', 'about:blank'], env)
    assert.equal(res.code, 2, 'default symlinked browser-profiles parent must fail closed')
    assert.match(res.stderr, /browser profile path must be a non-symlink directory within browser workspace/)
    assert.equal(existsSync(sentinelLock), true)
    assert.equal(readFileSync(f.log, 'utf8'), '')
    rmSync(join(f.home, 'browser-profiles'), { force: true })

    // Case B1-c: override root final agent dir is a symlink to outsideTarget
    rmSync(join(customRoot, agentKey), { recursive: true, force: true })
    symlinkSync(outsideTarget, join(customRoot, agentKey))
    res = await run(f.launcher, ['open', 'about:blank'], {
      ...env,
      OPENCLAUDE_BROWSER_PROFILE_ROOT: customRoot,
    })
    assert.equal(res.code, 2, 'override symlinked agent profile dir must fail closed')
    assert.match(res.stderr, /browser profile path must be a non-symlink directory within browser workspace/)
    assert.equal(existsSync(sentinelLock), true)
    assert.equal(readFileSync(f.log, 'utf8'), '')
    rmSync(join(customRoot, agentKey), { force: true })
  } finally {
    if (fakeChromeProc?.pid && isPidAlive(fakeChromeProc.pid)) {
      try { process.kill(fakeChromeProc.pid, 'SIGKILL') } catch {}
    }
    await run(f.launcher, ['close'], env)
    f.cleanup()
  }
})

test('seed config hot-reload priority and runtime config generation (Chrome channel vs Chromium fallback)', async () => {
  const f = fixture({
    baseConfig: { browser: { browserName: 'chromium', launchOptions: { chromiumSandbox: false, args: ['--from-etc'] } } },
    seedConfig: { browser: { browserName: 'chromium', launchOptions: { chromiumSandbox: false, args: ['--from-seed'] } } },
    withFakeChrome: true,
  })
  const env = { ...f.env, OPENCLAUDE_AGENT_ID: 'config-agent' }
  try {
    // Help fast-path must pick $SELF_ROOT/seed/playwright-cli.config.json over /etc fallback.
    let res = await run(f.launcher, ['--version'], env)
    assert.equal(res.code, 0, res.stderr)
    const firstStart = readFileSync(f.log, 'utf8').split('\n').find((l) => l.startsWith('start\t'))!.split('\t')
    assert.equal(firstStart[5], f.seedConfigPath)

    // open generates runtime-playwright-cli.config.json merging seed config + channel:"chrome" + required args.
    res = await run(f.launcher, ['open', 'about:blank'], env)
    assert.equal(res.code, 0, res.stderr)
    const agentKey = readdirSync(f.state)[0]!
    const runtimeCfgPath = join(f.state, agentKey, 'runtime-playwright-cli.config.json')
    const runtimeCfg = JSON.parse(readFileSync(runtimeCfgPath, 'utf8'))
    assert.equal(runtimeCfg.browser.browserName, 'chromium')
    assert.equal(runtimeCfg.browser.isolated, false)
    assert.equal(runtimeCfg.browser.userDataDir, join(f.home, 'browser-profiles', agentKey))
    assert.equal(runtimeCfg.browser.launchOptions.chromiumSandbox, false)
    assert.equal(runtimeCfg.browser.launchOptions.headless, true)
    assert.equal(runtimeCfg.browser.launchOptions.channel, 'chrome')
    assert.equal(runtimeCfg.browser.contextOptions.viewport, null)
    assert.ok(runtimeCfg.browser.launchOptions.args.includes('--from-seed'))
    assert.ok(!runtimeCfg.browser.launchOptions.args.includes('--from-etc'))
    for (const requiredArg of [
      '--remote-debugging-port=0',
      '--disable-dev-shm-usage',
      '--window-size=1440,900',
      '--window-position=0,0',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=zh-CN',
    ]) {
      assert.ok(runtimeCfg.browser.launchOptions.args.includes(requiredArg), `missing ${requiredArg}`)
    }

    // OPENCLAUDE_BROWSER_FORCE_CHROMIUM=1 omits channel even when Chrome binary exists.
    res = await run(f.launcher, ['open', 'about:blank'], { ...env, OPENCLAUDE_BROWSER_FORCE_CHROMIUM: '1' })
    assert.equal(res.code, 0, res.stderr)
    const fallbackCfg = JSON.parse(readFileSync(runtimeCfgPath, 'utf8'))
    assert.equal('channel' in fallbackCfg.browser.launchOptions, false)
  } finally {
    await run(f.launcher, ['close'], env)
    f.cleanup()
  }
})

test('headed Xvfb mode allocates isolated display >= :90, injects DISPLAY, and tears down Xvfb on close', async (t) => {
  if (!existsSync('/usr/bin/Xvfb')) {
    t.skip('Xvfb not installed on host')
    return
  }
  const f = fixture()
  const env = {
    ...f.env,
    OPENCLAUDE_AGENT_ID: 'xvfb-agent',
    OPENCLAUDE_BROWSER_HEADLESS: '0',
  }
  let xvfbPid: number | undefined
  try {
    let res = await run(f.launcher, ['open', 'about:blank'], env)
    assert.equal(res.code, 0, res.stderr)
    const agentKey = readdirSync(f.state)[0]!
    const agentState = join(f.state, agentKey)

    const display = readFileSync(join(agentState, 'xvfb.display'), 'utf8').trim()
    assert.match(display, /^:[0-9]+$/)
    assert.ok(Number(display.slice(1)) >= 90, `expected display >= :90, got ${display}`)
    xvfbPid = Number(readFileSync(join(agentState, 'xvfb.pid'), 'utf8').trim())
    assert.ok(isPidAlive(xvfbPid), 'Xvfb process must be alive after open')
    const xvfbMeta = JSON.parse(readFileSync(join(agentState, 'xvfb.meta'), 'utf8'))
    assert.equal(xvfbMeta.kind, 'xvfb')
    assert.equal(xvfbMeta.pid, xvfbPid)
    assert.equal(xvfbMeta.display, display)
    assert.match(xvfbMeta.starttime, /^[0-9]+$/)

    const runtimeCfg = JSON.parse(readFileSync(join(agentState, 'runtime-playwright-cli.config.json'), 'utf8'))
    assert.equal(runtimeCfg.browser.launchOptions.headless, false)
    assert.equal('channel' in runtimeCfg.browser.launchOptions, false, 'absent Chrome must omit channel')
    assert.equal(runtimeCfg.browser.contextOptions.viewport, null)

    const starts = readFileSync(f.log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('start\t'))
      .map((line) => line.split('\t'))
    assert.equal(starts[0]?.[8], display, 'DISPLAY must be injected into run_cli')

    // Subsequent commands reuse the same live Xvfb display.
    res = await run(f.launcher, ['snapshot'], env)
    assert.equal(res.code, 0, res.stderr)
    const starts2 = readFileSync(f.log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('start\t'))
      .map((line) => line.split('\t'))
    assert.equal(starts2[1]?.[8], display)

    // close terminates Xvfb and cleans xvfb state files.
    res = await run(f.launcher, ['close'], env)
    assert.equal(res.code, 0, res.stderr)
    await waitForFixtureSignal(() => !isPidAlive(xvfbPid!), 'close must terminate Xvfb')
    assert.equal(existsSync(join(agentState, 'xvfb.pid')), false)
    assert.equal(existsSync(join(agentState, 'xvfb.meta')), false)
    assert.equal(existsSync(join(agentState, 'xvfb.display')), false)
  } finally {
    await run(f.launcher, ['close'], env).catch(() => {})
    if (xvfbPid && isPidAlive(xvfbPid)) {
      try { process.kill(xvfbPid, 'SIGKILL') } catch {}
    }
    f.cleanup()
  }
})

test('close refuses to signal unrelated live PIDs written into xvfb.pid or wm.pid and removes stale files', async () => {
  const f = fixture()
  const env = { ...f.env, OPENCLAUDE_AGENT_ID: 'pid-reuse-guard' }
  const decoys: Array<ReturnType<typeof spawn>> = []
  try {
    let res = await run(f.launcher, ['open', 'about:blank'], env)
    assert.equal(res.code, 0, res.stderr)
    const agentState = join(f.state, readdirSync(f.state)[0]!)

    const decoyXvfb = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    const decoyWm = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    decoys.push(decoyXvfb, decoyWm)
    await waitForFixtureSignal(
      () => Boolean(decoyXvfb.pid && isPidAlive(decoyXvfb.pid) && decoyWm.pid && isPidAlive(decoyWm.pid)),
      'decoy processes did not start',
    )

    // Case 1: bare PID files without .meta (simulating legacy/stale pid files pointing to reused PIDs).
    writeFileSync(join(agentState, 'xvfb.display'), ':95\n')
    writeFileSync(join(agentState, 'xvfb.pid'), `${decoyXvfb.pid}\n`)
    writeFileSync(join(agentState, 'wm.pid'), `${decoyWm.pid}\n`)
    res = await run(f.launcher, ['close'], env)
    assert.equal(res.code, 0, res.stderr)
    assert.equal(isPidAlive(decoyXvfb.pid!), true, 'unrelated PID in xvfb.pid (no meta) must NOT be killed')
    assert.equal(isPidAlive(decoyWm.pid!), true, 'unrelated PID in wm.pid (no meta) must NOT be killed')
    assert.equal(existsSync(join(agentState, 'xvfb.pid')), false, 'stale xvfb.pid must be removed')
    assert.equal(existsSync(join(agentState, 'wm.pid')), false, 'stale wm.pid must be removed')

    // Case 2: PID files with mismatched starttime/comm .meta (simulating PID reuse after daemon exit).
    writeFileSync(join(agentState, 'xvfb.display'), ':96\n')
    writeFileSync(join(agentState, 'xvfb.pid'), `${decoyXvfb.pid}\n`)
    writeFileSync(
      join(agentState, 'xvfb.meta'),
      JSON.stringify({ kind: 'xvfb', pid: decoyXvfb.pid, starttime: '1', display: ':96' }) + '\n',
    )
    writeFileSync(join(agentState, 'wm.pid'), `${decoyWm.pid}\n`)
    writeFileSync(
      join(agentState, 'wm.meta'),
      JSON.stringify({ kind: 'wm', pid: decoyWm.pid, starttime: '1', display: ':96' }) + '\n',
    )
    res = await run(f.launcher, ['close'], env)
    assert.equal(res.code, 0, res.stderr)
    assert.equal(isPidAlive(decoyXvfb.pid!), true, 'unrelated PID in xvfb.pid (mismatched meta) must NOT be killed')
    assert.equal(isPidAlive(decoyWm.pid!), true, 'unrelated PID in wm.pid (mismatched meta) must NOT be killed')
    assert.equal(existsSync(join(agentState, 'xvfb.pid')), false, 'stale xvfb.pid must be removed')
    assert.equal(existsSync(join(agentState, 'xvfb.meta')), false, 'stale xvfb.meta must be removed')
    assert.equal(existsSync(join(agentState, 'wm.pid')), false, 'stale wm.pid must be removed')
    assert.equal(existsSync(join(agentState, 'wm.meta')), false, 'stale wm.meta must be removed')
  } finally {
    for (const p of decoys) {
      if (p.pid && isPidAlive(p.pid)) {
        try { process.kill(p.pid, 'SIGKILL') } catch {}
      }
    }
    await run(f.launcher, ['close'], env).catch(() => {})
    f.cleanup()
  }
})
