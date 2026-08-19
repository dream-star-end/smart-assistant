/**
 * Locks the experimental oc-zcode wrapper to the live 0.16.3 hosted contract.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/zcodeWrapper.test.ts
 */
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'

const WRAPPER = path.resolve(
  process.cwd(),
  'packages/commercial/agent-sandbox/platform-runtime/bin/oc-zcode.sh',
)

function runWrapper(args: string[], env: NodeJS.ProcessEnv): Promise<{
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
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
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
    assert.match(text, /unset OPENCLAUDE_V3_CONTAINER_TOKEN/)
    assert.match(text, /test auth must not use the production credential path/)
    assert.match(text, /\\"kind\\":\\"anthropic\\"/)
    assert.match(text, /zai-coding-plan\/glm-5.3/)
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
      assert.equal(captured.env.ANTHROPIC_API_KEY, undefined)
      assert.equal(captured.env.OC_ZCODE_RELAY_TOKEN, undefined)
      assert.equal(captured.env.ZAI_CODING_PLAN_KEY, undefined)
      assert.equal(captured.env.OPENCLAUDE_V3_CONTAINER_TOKEN, undefined)
      assert.equal(captured.config.model.main, 'zai-coding-plan/glm-5.3')
      assert.equal(captured.config.provider['zai-coding-plan'].kind, 'anthropic')
      assert.equal(captured.config.provider['zai-coding-plan'].options.apiKey, 'super-secret-zcode-key')
      assert.equal(captured.configMode, 0o600)
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
})
