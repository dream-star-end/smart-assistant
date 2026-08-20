/**
 * Locks the experimental oc-zcode wrapper to the live 0.16.3 hosted contract.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/zcodeWrapper.test.ts
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const WRAPPER = path.resolve(
  process.cwd(),
  'packages/commercial/agent-sandbox/platform-runtime/bin/oc-zcode.sh',
)

function runWrapper(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 0): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [WRAPPER, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* already exited */ }
        }, timeoutMs)
      : null
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

describe('oc-zcode wrapper', () => {
  test('script pins yolo, loopback relay, and never echoes the token', () => {
    const text = readFileSync(WRAPPER, 'utf8')
    assert.match(text, /hosted permission mode is locked to yolo/)
    assert.match(text, /internal\/v5\/zcode-relay\/route/)
    assert.doesNotMatch(text, /sudo -n \/bin\/cat -- "\$auth_file"/)
    assert.match(text, /< \/dev\/null/)
    assert.doesNotMatch(text, /echo "\$api_key"/)
    assert.match(text, /experimental community/)
    assert.match(text, /test hook requires OC_ZCODE_TEST_BIN and OC_ZCODE_TEST_AUTH_FILE together/)
    assert.match(text, /unset ZCODE_API_KEY/)
    assert.match(text, /unset ZAI_API_KEY/)
    assert.match(text, /unset OC_ZCODE_RELAY_TOKEN/)
    assert.match(text, /unset ZAI_CODING_PLAN_KEY/)
    assert.match(text, /unset ANTHROPIC_AUTH_TOKEN/)
    assert.match(text, /unset OPENCLAUDE_V3_CONTAINER_TOKEN/)
    assert.match(text, /export ANTHROPIC_API_KEY=/)
    assert.match(text, /export ANTHROPIC_BASE_URL=/)
    assert.doesNotMatch(text, /unset ANTHROPIC_API_KEY/)
    assert.match(text, /baseURL\\":\\"\$anthropic_base\\"/)
    assert.doesNotMatch(text, /baseURL\\":\\"\$relay_base\\"/)
    assert.match(text, /test auth must not use the production credential path/)
    assert.match(text, /\\"kind\\":\\"anthropic\\"/)
    assert.match(text, /zai-coding-plan\/glm-5.3/)
    assert.match(text, /\/home\/agent\/\.openclaude/)
    assert.match(text, /try_storage_root/)
    assert.match(text, /stat -c '%u'/)
    assert.match(text, /\/bin\/rm -rf -- "\$zcode_home"/)
    assert.doesNotMatch(text, /rm -rf -- "\$storage_dir"/)
    assert.doesNotMatch(text, /rm -rf -- "\$ZCODE_STORAGE_DIR"/)
    assert.match(text, /durable ZCode storage is unavailable/)
    assert.match(text, /ZCODE_SESSION_DB_PATH/)
    assert.match(text, /session_db_dir="\$storage_dir\/cli\/db"/)
    assert.match(text, /session_db_path="\$session_db_dir\/db\.sqlite"/)
    assert.match(text, /unset ZCODE_SESSION_DB/)
    assert.doesNotMatch(text, /unset ZCODE_SESSION_DB_PATH/)
    assert.doesNotMatch(text, /rm -rf -- "\$session_db/)
    assert.doesNotMatch(text, /rm -rf -- "\$ZCODE_SESSION_DB_PATH"/)
  })

  test('selfhost runtime build profile persistently includes ZCode 0.16.3', () => {
    const profile = readFileSync(
      path.resolve(process.cwd(), 'deploy/v5-selfhost/runtime-build.env'),
      'utf8',
    )
    const build = readFileSync(
      path.resolve(process.cwd(), 'packages/commercial/agent-sandbox/build-image.sh'),
      'utf8',
    )
    const dockerfile = readFileSync(
      path.resolve(process.cwd(), 'packages/commercial/agent-sandbox/Dockerfile.openclaude-runtime'),
      'utf8',
    )
    assert.match(profile, /^OC_INCLUDE_ZCODE=1$/m)
    assert.match(profile, /^OC_ZCODE_CLI_VERSION=0\.16\.3$/m)
    assert.match(profile, /^OC_INCLUDE_GROK=1$/m)
    assert.match(profile, /^OC_INCLUDE_CURSOR=1$/m)
    assert.match(profile, /^OC_EMBED_SOURCE=0$/m)
    assert.match(build, /SANDBOX_DIR\/\.\.\/\.\.\/\.\./)
    assert.match(build, /deploy\/v5-selfhost\/runtime-build\.env/)
    assert.match(build, /oc\.runtime\.include_zcode=\$\{OC_INCLUDE_ZCODE:-0\}/)
    assert.match(build, /OC_INCLUDE_ZCODE=\$\{OC_INCLUDE_ZCODE:-0\}/)
    assert.match(dockerfile, /ARG OC_INCLUDE_ZCODE=0/)
    assert.match(dockerfile, /OC_ZCODE_CLI_VERSION=0\.16\.3/)
    assert.match(dockerfile, /4eb1c759aa1dba923045c8cd8bc3ac0354e99f6be3c7fab3624372c1df940e62/)
    assert.match(dockerfile, /--appimage-extract/)
  })

  test('executes the fake CLI with locked flags and does not print the secret', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-wrapper-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const auth = path.join(dir, 'api-key')
    const capture = path.join(dir, 'capture.json')
    await writeFile(auth, 'super-secret-zcode-key\n')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const cfgPath = path.join(process.env.HOME, '.zcode/cli/config.json')
const st = fs.statSync(cfgPath)
fs.writeFileSync(process.env.FAKE_ZCODE_CAPTURE, JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    ZCODE_MODEL: process.env.ZCODE_MODEL,
    HOME: process.env.HOME,
    ZCODE_API_KEY: process.env.ZCODE_API_KEY,
    ZAI_API_KEY: process.env.ZAI_API_KEY,
    ZAI_CODING_PLAN_KEY: process.env.ZAI_CODING_PLAN_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    OC_ZCODE_RELAY_TOKEN: process.env.OC_ZCODE_RELAY_TOKEN,
    OPENCLAUDE_V3_CONTAINER_TOKEN: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
  },
  config: JSON.parse(fs.readFileSync(cfgPath, 'utf8')),
  configMode: st.mode & 0o777,
}))
process.stdout.write(JSON.stringify({ sessionId: 'sess_w', response: 'wrapped', eventCount: 0 }) + '\\n')
`)
    await chmod(fake, 0o755)
    try {
      const result = await runWrapper(
        ['--prompt', 'hello', '--json', '--mode', 'yolo', '--no-color', '--cwd', dir, '--resume', 'sess_prior'],
        {
          PATH: process.env.PATH,
          OC_ZCODE_TEST_BIN: fake,
          OC_ZCODE_TEST_AUTH_FILE: auth,
          OC_ZCODE_UPSTREAM_MODEL: 'zai-coding-plan/glm-5.3',
          OC_ZCODE_RELAY_BASE_URL: 'http://127.0.0.1:18791/internal/v5/zcode-relay/route/ab',
          ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1',
          ZAI_CODING_PLAN_KEY: 'must-not-inherit',
          OPENCLAUDE_V3_CONTAINER_TOKEN: 'must-not-inherit',
          FAKE_ZCODE_CAPTURE: capture,
        },
      )
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr.includes('super-secret-zcode-key'), false)
      assert.match(result.stdout, /sess_w/)
      const captured = JSON.parse(await readFile(capture, 'utf8')) as {
        argv: string[]
        env: Record<string, string | undefined>
        config: {
          model: { main: string }
          provider: { 'zai-coding-plan': { kind: string; options: { apiKey: string; baseURL: string } } }
        }
        configMode: number
      }
      assert.equal(captured.argv[captured.argv.indexOf('--mode') + 1], 'yolo')
      assert.ok(captured.argv.includes('--json'))
      assert.equal(captured.env.ZCODE_MODEL, 'zai-coding-plan/glm-5.3')
      assert.match(String(captured.env.HOME), /openclaude-zcode\./)
      assert.equal(captured.env.ZCODE_API_KEY, undefined)
      assert.equal(captured.env.ZAI_API_KEY, undefined)
      assert.equal(captured.env.ANTHROPIC_API_KEY, 'super-secret-zcode-key')
      assert.equal(
        captured.env.ANTHROPIC_BASE_URL,
        'http://127.0.0.1:18791/internal/v5/zcode-relay/route/ab/v1',
      )
      assert.equal(captured.env.ANTHROPIC_AUTH_TOKEN, undefined)
      assert.equal(captured.env.OC_ZCODE_RELAY_TOKEN, undefined)
      assert.equal(captured.env.ZAI_CODING_PLAN_KEY, undefined)
      assert.equal(captured.env.OPENCLAUDE_V3_CONTAINER_TOKEN, undefined)
      assert.equal(captured.config.model.main, 'zai-coding-plan/glm-5.3')
      assert.equal(captured.config.provider['zai-coding-plan'].kind, 'anthropic')
      assert.equal(captured.config.provider['zai-coding-plan'].options.apiKey, 'super-secret-zcode-key')
      assert.equal(
        captured.config.provider['zai-coding-plan'].options.baseURL,
        'http://127.0.0.1:18791/internal/v5/zcode-relay/route/ab/v1',
      )
      assert.equal(captured.configMode, 0o600)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('merges only managed MCP/hooks keys while provider credentials remain wrapper-owned', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-wrapper-platform-'))
    const context = await mkdtemp(path.join(tmpdir(), 'oc-zcode-context-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const auth = path.join(dir, 'api-key')
    const capture = path.join(dir, 'capture.json')
    const platform = path.join(context, 'platform-config.json')
    await chmod(context, 0o700)
    await writeFile(auth, 'relay-secret\n', { mode: 0o600 })
    await writeFile(platform, JSON.stringify({
      features: { mcp: true },
      mcp: { servers: { probe: { type: 'stdio', command: '/bin/true' } } },
      hooks: { enabled: true, events: {} },
    }), { mode: 0o600 })
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.zcode/cli/config.json'), 'utf8'))
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(cfg))
process.stdout.write(JSON.stringify({ sessionId: 'sess_platform', response: 'ok', eventCount: 0 }) + '\\n')
`)
    await chmod(fake, 0o755)
    try {
      const result = await runWrapper(
        ['--prompt', 'hello', '--json', '--mode', 'yolo', '--no-color', '--cwd', dir],
        {
          PATH: process.env.PATH,
          HOME: dir,
          OC_ZCODE_TEST_BIN: fake,
          OC_ZCODE_TEST_NODE: process.execPath,
          OC_ZCODE_TEST_AUTH_FILE: auth,
          OC_ZCODE_PLATFORM_CONFIG_FILE: platform,
          OC_ZCODE_RELAY_BASE_URL: 'http://127.0.0.1:18791/internal/v5/zcode-relay/route/test',
          FAKE_ZCODE_CAPTURE: capture,
        },
      )
      assert.equal(result.code, 0, result.stderr)
      const cfg = JSON.parse(await readFile(capture, 'utf8')) as any
      assert.equal(cfg.features.mcp, true)
      assert.equal(cfg.mcp.servers.probe.command, '/bin/true')
      assert.equal(cfg.hooks.enabled, true)
      assert.equal(cfg.model.main, 'zai-coding-plan/glm-5.3')
      assert.equal(cfg.provider['zai-coding-plan'].options.apiKey, 'relay-secret')
      assert.equal(
        cfg.provider['zai-coding-plan'].options.baseURL,
        'http://127.0.0.1:18791/internal/v5/zcode-relay/route/test/v1',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(context, { recursive: true, force: true })
    }
  })

  test('does not double /v1 when the minted relay base already includes it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-wrapper-v1-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const auth = path.join(dir, 'api-key')
    const capture = path.join(dir, 'capture.json')
    await writeFile(auth, 'super-secret-zcode-key\n')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const cfgPath = path.join(process.env.HOME, '.zcode/cli/config.json')
fs.writeFileSync(process.env.FAKE_ZCODE_CAPTURE, JSON.stringify({
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  },
  config: JSON.parse(fs.readFileSync(cfgPath, 'utf8')),
}))
process.stdout.write(JSON.stringify({ sessionId: 'sess_w', response: 'wrapped', eventCount: 0 }) + '\\n')
`)
    await chmod(fake, 0o755)
    try {
      const result = await runWrapper(
        ['--prompt', 'hello', '--json', '--mode', 'yolo', '--no-color', '--cwd', dir],
        {
          PATH: process.env.PATH,
          OC_ZCODE_TEST_BIN: fake,
          OC_ZCODE_TEST_AUTH_FILE: auth,
          OC_ZCODE_RELAY_BASE_URL: 'http://127.0.0.1:18791/internal/v5/zcode-relay/route/ab/v1',
          FAKE_ZCODE_CAPTURE: capture,
        },
      )
      assert.equal(result.code, 0, result.stderr)
      const captured = JSON.parse(await readFile(capture, 'utf8')) as {
        env: Record<string, string | undefined>
        config: { provider: { 'zai-coding-plan': { options: { baseURL: string } } } }
      }
      assert.equal(
        captured.env.ANTHROPIC_BASE_URL,
        'http://127.0.0.1:18791/internal/v5/zcode-relay/route/ab/v1',
      )
      assert.equal(
        captured.config.provider['zai-coding-plan'].options.baseURL,
        'http://127.0.0.1:18791/internal/v5/zcode-relay/route/ab/v1',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects plan/build and --force', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-wrapper-deny-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const auth = path.join(dir, 'api-key')
    await writeFile(auth, 'k')
    await writeFile(fake, '#!/usr/bin/env node\nprocess.exit(0)\n')
    await chmod(fake, 0o755)
    try {
      const plan = await runWrapper(
        ['--prompt', 'x', '--json', '--mode', 'plan', '--no-color', '--cwd', dir],
        { PATH: process.env.PATH, OC_ZCODE_TEST_BIN: fake, OC_ZCODE_TEST_AUTH_FILE: auth },
      )
      assert.notEqual(plan.code, 0)
      assert.match(plan.stderr, /locked to yolo/)
      const force = await runWrapper(
        ['--prompt', 'x', '--json', '--mode', 'yolo', '--no-color', '--cwd', dir, '--force'],
        { PATH: process.env.PATH, OC_ZCODE_TEST_BIN: fake, OC_ZCODE_TEST_AUTH_FILE: auth },
      )
      assert.notEqual(force.code, 0)
      assert.match(force.stderr, /managed by OpenClaude/)
      const oldUpstream = await runWrapper(
        ['--prompt', 'x', '--json', '--mode', 'yolo', '--no-color', '--cwd', dir],
        {
          PATH: process.env.PATH,
          OC_ZCODE_TEST_BIN: fake,
          OC_ZCODE_TEST_AUTH_FILE: auth,
          OC_ZCODE_UPSTREAM_MODEL: 'zai/glm-5.1',
        },
      )
      assert.notEqual(oldUpstream.code, 0)
      assert.match(oldUpstream.stderr, /not allowlisted/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('any OC_ZCODE_TEST_* without the matching pair never reads production auth', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-wrapper-partial-'))
    const fake = path.join(dir, 'fake-zcode.cjs')
    const marker = path.join(dir, 'sudo-ran')
    const sudo = path.join(dir, 'sudo')
    await writeFile(fake, '#!/usr/bin/env node\nprocess.exit(0)\n')
    await chmod(fake, 0o755)
    await writeFile(sudo, `#!/bin/sh\necho ran >> "${marker}"\nexit 0\n`)
    await chmod(sudo, 0o755)
    try {
      const onlyBin = await runWrapper(
        ['--prompt', 'x', '--json', '--mode', 'yolo', '--no-color', '--cwd', dir],
        { PATH: `${dir}:${process.env.PATH}`, OC_ZCODE_TEST_BIN: fake },
      )
      assert.notEqual(onlyBin.code, 0)
      assert.match(onlyBin.stderr, /together/)
      assert.equal(onlyBin.stderr.includes('/run/oc/zcode-auth'), false)

      const onlyAuth = await runWrapper(
        ['--prompt', 'x', '--json', '--mode', 'yolo', '--no-color', '--cwd', dir],
        { PATH: `${dir}:${process.env.PATH}`, OC_ZCODE_TEST_AUTH_FILE: path.join(dir, 'api-key') },
      )
      assert.notEqual(onlyAuth.code, 0)
      assert.match(onlyAuth.stderr, /together/)

      const prodPath = await runWrapper(
        ['--prompt', 'x', '--json', '--mode', 'yolo', '--no-color', '--cwd', dir],
        {
          PATH: `${dir}:${process.env.PATH}`,
          OC_ZCODE_TEST_BIN: fake,
          OC_ZCODE_TEST_AUTH_FILE: '/run/oc/zcode-auth/api-key',
        },
      )
      assert.notEqual(prodPath.code, 0)
      assert.match(prodPath.stderr, /production credential path/)
      assert.equal(await readFile(marker, 'utf8').catch(() => ''), '')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('empty OPENCLAUDE_HOME still uses durable storage under the caller home contract', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-wrapper-empty-home-'))
    const agentHome = path.join(dir, 'agent-home')
    const ocHome = path.join(agentHome, '.openclaude')
    const fake = path.join(dir, 'fake-zcode.cjs')
    const auth = path.join(dir, 'api-key')
    const capture = path.join(dir, 'capture.json')
    await writeFile(auth, 'super-secret-zcode-key\n')
    await mkdir(ocHome, { recursive: true, mode: 0o700 })
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.FAKE_ZCODE_CAPTURE, JSON.stringify({
  storage: process.env.ZCODE_STORAGE_DIR || null,
  sessionDb: process.env.ZCODE_SESSION_DB_PATH || null,
  sessionDbAlias: process.env.ZCODE_SESSION_DB || null,
  home: process.env.HOME || null,
  anthropic: process.env.ANTHROPIC_API_KEY || null,
}))
process.stdout.write(JSON.stringify({ sessionId: 'sess_w', response: 'wrapped', eventCount: 0 }) + '\\n')
`)
    await chmod(fake, 0o755)
    try {
      const result = await runWrapper(
        ['--prompt', 'hello', '--json', '--mode', 'yolo', '--no-color', '--cwd', dir],
        {
          PATH: process.env.PATH,
          HOME: agentHome,
          OPENCLAUDE_HOME: '',
          OC_ZCODE_TEST_BIN: fake,
          OC_ZCODE_TEST_AUTH_FILE: auth,
          FAKE_ZCODE_CAPTURE: capture,
        },
      )
      assert.equal(result.code, 0, result.stderr)
      const captured = JSON.parse(await readFile(capture, 'utf8')) as {
        storage: string | null
        sessionDb: string | null
        sessionDbAlias: string | null
        home: string | null
        anthropic: string | null
      }
      assert.equal(captured.storage, path.join(ocHome, 'zcode-cli'))
      assert.equal(captured.sessionDb, path.join(ocHome, 'zcode-cli', 'cli', 'db', 'db.sqlite'))
      assert.equal(captured.sessionDbAlias, null)
      assert.match(String(captured.home), /openclaude-zcode\./)
      assert.notEqual(captured.home, agentHome)
      assert.equal(captured.anthropic, 'super-secret-zcode-key')
      const listing = await readdir(path.join(ocHome, 'zcode-cli'))
      assert.equal(listing.some((name) => name.toLowerCase().includes('secret') || name.includes('key')), false)
      const st = await stat(path.join(ocHome, 'zcode-cli'))
      assert.equal(st.mode & 0o777, 0o700)
      const dbDir = path.join(ocHome, 'zcode-cli', 'cli', 'db')
      const dbDirSt = await stat(dbDir)
      assert.equal(dbDirSt.isDirectory(), true)
      assert.equal(dbDirSt.mode & 0o777, 0o700)
      assert.equal(result.stderr.includes('super-secret-zcode-key'), false)
      assert.equal(result.stdout.includes('super-secret-zcode-key'), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('two spawns share durable storage and r2 resume sees the r1 session marker', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-wrapper-share-'))
    const ocHome = path.join(dir, 'oc-home')
    const fake = path.join(dir, 'fake-zcode.cjs')
    const auth = path.join(dir, 'api-key')
    const capture1 = path.join(dir, 'capture1.json')
    const capture2 = path.join(dir, 'capture2.json')
    await writeFile(auth, 'super-secret-zcode-key\n')
    await mkdir(ocHome, { recursive: true, mode: 0o700 })
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const store = process.env.ZCODE_STORAGE_DIR
const sessionDb = process.env.ZCODE_SESSION_DB_PATH
if (!store) {
  process.stderr.write('missing ZCODE_STORAGE_DIR\\n')
  process.exit(1)
}
if (!sessionDb || !sessionDb.endsWith('/cli/db/db.sqlite') || !sessionDb.startsWith(store + '/')) {
  process.stderr.write('missing ZCODE_SESSION_DB_PATH\\n')
  process.exit(1)
}
const marker = path.join(store, 'sess_shared.json')
const resumeAt = process.argv.indexOf('--resume')
const capture = process.env.FAKE_ZCODE_CAPTURE
if (resumeAt >= 0) {
  if (!fs.existsSync(marker)) {
    process.stderr.write('Session not found: ' + process.argv[resumeAt + 1] + '\\n')
    process.exit(1)
  }
  const prior = JSON.parse(fs.readFileSync(marker, 'utf8'))
  fs.writeFileSync(capture, JSON.stringify({
    storage: store,
    sessionDb,
    home: process.env.HOME,
    resume: process.argv[resumeAt + 1],
    prior,
    secretInStore: fs.readdirSync(store).join(','),
  }))
} else {
  fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(marker, JSON.stringify({ sessionId: 'sess_shared', turn: 1 }))
  fs.writeFileSync(capture, JSON.stringify({
    storage: store,
    sessionDb,
    home: process.env.HOME,
    resume: null,
    secretInStore: fs.readdirSync(store).join(','),
  }))
}
process.stdout.write(JSON.stringify({ sessionId: 'sess_shared', response: 'ok', eventCount: 0 }) + '\\n')
`)
    await chmod(fake, 0o755)
    const baseEnv = {
      PATH: process.env.PATH,
      OPENCLAUDE_HOME: ocHome,
      OC_ZCODE_TEST_BIN: fake,
      OC_ZCODE_TEST_AUTH_FILE: auth,
    }
    try {
      const r1 = await runWrapper(
        ['--prompt', 'round-1', '--json', '--mode', 'yolo', '--no-color', '--cwd', dir],
        { ...baseEnv, FAKE_ZCODE_CAPTURE: capture1 },
      )
      assert.equal(r1.code, 0, r1.stderr)
      const r2 = await runWrapper(
        ['--prompt', 'round-2', '--json', '--mode', 'yolo', '--no-color', '--cwd', dir, '--resume', 'sess_shared'],
        { ...baseEnv, FAKE_ZCODE_CAPTURE: capture2 },
      )
      assert.equal(r2.code, 0, r2.stderr)
      const c1 = JSON.parse(await readFile(capture1, 'utf8')) as {
        storage: string
        sessionDb: string
        home: string
        resume: string | null
        secretInStore: string
      }
      const c2 = JSON.parse(await readFile(capture2, 'utf8')) as {
        storage: string
        sessionDb: string
        home: string
        resume: string | null
        prior: { sessionId: string; turn: number }
        secretInStore: string
      }
      assert.equal(c1.storage, path.join(ocHome, 'zcode-cli'))
      assert.equal(c2.storage, c1.storage)
      assert.equal(c1.sessionDb, path.join(ocHome, 'zcode-cli', 'cli', 'db', 'db.sqlite'))
      assert.equal(c2.sessionDb, c1.sessionDb)
      assert.notEqual(c1.home, c2.home)
      assert.match(c1.home, /openclaude-zcode\./)
      assert.match(c2.home, /openclaude-zcode\./)
      assert.equal(c1.resume, null)
      assert.equal(c2.resume, 'sess_shared')
      assert.equal(c2.prior.sessionId, 'sess_shared')
      assert.equal(c1.secretInStore.includes('super-secret'), false)
      assert.equal(c2.secretInStore.includes('super-secret'), false)
      assert.equal(c1.secretInStore.includes('api-key'), false)
      const durable = await readFile(path.join(ocHome, 'zcode-cli', 'sess_shared.json'), 'utf8')
      assert.equal(durable.includes('super-secret-zcode-key'), false)
      assert.equal(r1.stderr.includes('super-secret-zcode-key'), false)
      assert.equal(r2.stdout.includes('super-secret-zcode-key'), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  const REAL_ZCODE_CJS = '/opt/zcode-cli/versions/0.16.3/zcode.cjs'
  const REAL_NODE = '/usr/local/bin/node'

  function runRealCli(
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(REAL_NODE, [REAL_ZCODE_CJS, ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      }, timeoutMs)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.on('data', (chunk: string) => { stderr += chunk })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 1, stdout, stderr })
      })
    })
  }

  test(
    'real CLI 0.16.3 --resume reads sqlite from ZCODE_SESSION_DB_PATH across two ephemeral HOMEs',
    { skip: !existsSync(REAL_ZCODE_CJS) || !existsSync(REAL_NODE) },
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'oc-zcode-real-sqlite-'))
      const home1 = path.join(dir, 'home1')
      const home2 = path.join(dir, 'home2')
      const store = path.join(dir, 'store')
      const cwd = path.join(dir, 'cwd')
      const sessionId = 'sess_aaaaaaa1-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      const sessionDb = path.join(store, 'cli', 'db', 'db.sqlite')
      const dummyKey = 'diag-not-a-real-key'
      const config = JSON.stringify({
        model: { main: 'zai-coding-plan/glm-5.3' },
        provider: {
          'zai-coding-plan': {
            kind: 'anthropic',
            name: 'diag',
            options: {
              apiKeyRequired: true,
              baseURL: 'http://127.0.0.1:9/v1',
              apiKey: dummyKey,
            },
          },
        },
      })
      await mkdir(path.join(home1, '.zcode', 'cli'), { recursive: true, mode: 0o700 })
      await mkdir(path.join(home2, '.zcode', 'cli'), { recursive: true, mode: 0o700 })
      await mkdir(path.join(store, 'cli', 'db'), { recursive: true, mode: 0o700 })
      await mkdir(cwd, { recursive: true })
      await writeFile(path.join(home1, '.zcode', 'cli', 'config.json'), config, { mode: 0o600 })
      await writeFile(path.join(home2, '.zcode', 'cli', 'config.json'), config, { mode: 0o600 })
      const cliEnv = (home: string): NodeJS.ProcessEnv => ({
        PATH: process.env.PATH,
        HOME: home,
        ZCODE_STORAGE_DIR: store,
        ZCODE_SESSION_DB_PATH: sessionDb,
      })
      try {
        const r1 = await runRealCli(
          ['--prompt', 'round-1', '--json', '--mode', 'yolo', '--no-color', '--cwd', cwd, '--resume', sessionId],
          cliEnv(home1),
          20_000,
        )
        assert.match(r1.stderr, /Session not found:\s*sess_aaaaaaa1-bbbb-4ccc-8ddd-eeeeeeeeeeee/)
        assert.equal(existsSync(sessionDb), true)
        assert.equal(existsSync(path.join(home1, '.zcode', 'cli', 'db', 'db.sqlite')), false)

        const db = new DatabaseSync(sessionDb)
        try {
          const now = Date.now()
          db.prepare(`
            insert into session (
              id, project_id, workspace_id, parent_id, trace_id, task_type, slug, directory, path,
              title, title_source, title_message_id, version, share_url, revert, permission,
              time_created, time_updated, time_title_updated, time_compacting, time_archived
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            sessionId, 'proj_diag', null, null, null, 'interactive', 'diag', cwd, null,
            'diag', 'first_input', null, '1', null, null, null,
            now, now, now, null, null,
          )
          const countRow = db.prepare('select count(*) as n from session where id = ?').get(sessionId) as { n: number }
          assert.equal(countRow.n, 1)
        } finally {
          db.close()
        }

        await rm(home1, { recursive: true, force: true })
        const r2 = await runRealCli(
          ['--prompt', 'round-2', '--json', '--mode', 'yolo', '--no-color', '--cwd', cwd, '--resume', sessionId],
          cliEnv(home2),
          20_000,
        )
        assert.doesNotMatch(r2.stderr, /Session not found:\s*sess_/)
        assert.equal(existsSync(path.join(home2, '.zcode', 'cli', 'db', 'db.sqlite')), false)
        const db2 = new DatabaseSync(sessionDb)
        try {
          const row = db2.prepare('select id, directory from session where id = ?').get(sessionId) as
            | { id: string; directory: string }
            | undefined
          assert.equal(row?.id, sessionId)
          assert.equal(row?.directory, cwd)
        } finally {
          db2.close()
        }
        const sqliteBytes = await readFile(sessionDb)
        assert.equal(sqliteBytes.includes(Buffer.from(dummyKey)), false)
        assert.equal(r1.stderr.includes(dummyKey), false)
        assert.equal(r2.stderr.includes(dummyKey), false)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )
})
