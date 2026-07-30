import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
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
  env: NodeJS.ProcessEnv
  cleanup(): void
} {
  const root = mkdtempSync(join(tmpdir(), 'oc-browser-launcher-'))
  const home = join(root, 'home')
  const fakeCli = join(root, 'playwright-cli')
  const config = join(root, 'playwright-cli.config.json')
  const launcher = join(root, 'oc-browser')
  const log = join(root, 'calls.log')
  writeFileSync(
    fakeCli,
    `#!/bin/sh
printf 'start\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$PLAYWRIGHT_CLI_SESSION" "$XDG_CACHE_HOME" "$PWD" "$*" "$PLAYWRIGHT_MCP_CONFIG" "\${PLAYWRIGHT_MCP_CDP_ENDPOINT:-}" "$PWTEST_SOCKETS_DIR" >> "$OC_BROWSER_TEST_LOG"
if [ "\${1:-}" = hold ]; then sleep 2; fi
printf 'end\\t%s\\n' "$*" >> "$OC_BROWSER_TEST_LOG"
`,
  )
  chmodSync(fakeCli, 0o755)
  writeFileSync(config, '{}\n')
  const source = readFileSync(SOURCE, 'utf8')
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
    env: {
      OPENCLAUDE_HOME: home,
      OC_BROWSER_TEST_LOG: log,
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
    assert.match(fields[0]?.[2] ?? '', /\/tmp\/openclaude-playwright-cli\/a_b-[0-9a-f]{16}\/cache$/)
    assert.notEqual(fields[0]?.[7], fields[1]?.[7], 'each Agent must use a distinct socket directory')
    assert.match(fields[0]?.[7] ?? '', /\/tmp\/openclaude-playwright-cli\/a_b-[0-9a-f]{16}\/sockets$/)
    assert.equal(fields[0]?.[5], join(f.root, 'playwright-cli.config.json'))
    assert.equal(fields[0]?.[6], '')
  } finally {
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
    const waiting = run(f.launcher, ['snapshot'], env)
    const [held, waited] = await Promise.all([holding, waiting])
    assert.equal(held.code, 0, held.stderr)
    assert.equal(waited.code, 0, waited.stderr)

    const beforeReap = readFileSync(f.log, 'utf8').trim().split('\n')
    const holdEnd = beforeReap.indexOf('end\thold')
    const snapshotStart = beforeReap.findIndex((line) => line.endsWith('\tsnapshot'))
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
