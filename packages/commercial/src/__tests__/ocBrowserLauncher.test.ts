import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      timeout: 10_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
  })
}

function fixture(): {
  root: string
  home: string
  launcher: string
  log: string
  state: string
  release: string
  env: NodeJS.ProcessEnv
  cleanup(): void
} {
  const root = mkdtempSync(join(tmpdir(), 'oc-browser-launcher-'))
  const home = join(root, 'home')
  const fakeCli = join(root, 'playwright-cli')
  const config = join(root, 'playwright-cli.config.json')
  const launcher = join(root, 'oc-browser')
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
fs.appendFileSync(e.OC_BROWSER_TEST_LOG, ['start', e.PLAYWRIGHT_CLI_SESSION,
  e.XDG_CACHE_HOME, process.cwd(), args.join(' '), e.PLAYWRIGHT_MCP_CONFIG,
  e.PLAYWRIGHT_MCP_CDP_ENDPOINT || '', e.PWTEST_SOCKETS_DIR].join('\\t') + '\\n');
(async () => {
  const deadline = Date.now() + 5000;
  while (args[0] === 'hold' && !fs.existsSync(e.OC_BROWSER_TEST_RELEASE)) {
    if (Date.now() > deadline) throw new Error('test hold was not released');
    await new Promise(r => setTimeout(r, 20));
  }
  const result = await new Session().run();
  console.log(result.text);
  if (e.OC_BROWSER_TEST_EXIT_CODE) process.exitCode = Number(e.OC_BROWSER_TEST_EXIT_CODE);
  fs.appendFileSync(e.OC_BROWSER_TEST_LOG, 'end\\t' + args.join(' ') + '\\n');
})();
`,
  )
  chmodSync(fakeCli, 0o755)
  writeFileSync(config, '{}\n')
  const source = readFileSync(SOURCE, 'utf8')
    .replace('state_dir="/tmp/openclaude-playwright-cli/$agent_key"', `state_dir="${state}/$agent_key"`)
    .replace('cli_bin=/usr/local/bin/playwright-cli', `cli_bin=${fakeCli}`)
    .replace(
      'config_file=/etc/openclaude/playwright-cli.config.json',
      `config_file=${config}`,
    )
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
    env: {
      OPENCLAUDE_HOME: home,
      OC_BROWSER_TEST_LOG: log,
      OC_BROWSER_TEST_RELEASE: release,
      OPENCLAUDE_AGENT_ID: '',
      OC_AGENT_ID: '',
      OPENCLAUDE_PLAYWRIGHT_CLI_IDLE_SECONDS: '60',
      OPENCLAUDE_PLAYWRIGHT_CLI_POLL_SECONDS: '1',
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('launcher fails closed without Agent identity and rejects session/global escapes', async () => {
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

test('registry/cache key includes raw Agent identity hash and CLI receives fixed session/cwd', async () => {
  const f = fixture()
  try {
    for (const agentId of ['a/b', 'a_b']) {
      const result = await run(f.launcher, ['--version'], {
        ...f.env,
        OPENCLAUDE_AGENT_ID: agentId,
        PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:9222',
        PLAYWRIGHT_MCP_USER_DATA_DIR: '/tmp/shared-profile',
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
    assert.equal(fields[0]?.[5], join(f.root, 'playwright-cli.config.json'))
    assert.equal(fields[0]?.[6], '')
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

async function waitForCall(log: string, command: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (existsSync(log) && readFileSync(log, 'utf8').split('\n').some((line) => {
      const fields = line.split('\t')
      return fields[0] === 'start' && fields[4] === command
    })) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  assert.fail(`CLI did not start ${command}`)
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
