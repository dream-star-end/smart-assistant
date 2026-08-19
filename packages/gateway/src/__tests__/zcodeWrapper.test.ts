/**
 * Locks the experimental oc-zcode wrapper to the live 0.15.0 hosted contract.
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
  test('script pins yolo, root-only auth, and never echoes the key', () => {
    const text = readFileSync(WRAPPER, 'utf8')
    assert.match(text, /hosted permission mode is locked to yolo/)
    assert.match(text, /\/run\/oc\/zcode-auth\/api-key/)
    assert.match(text, /< \/dev\/null/)
    assert.doesNotMatch(text, /echo "\$api_key"/)
    assert.match(text, /experimental community/)
    assert.match(text, /test hook requires OC_ZCODE_TEST_BIN and OC_ZCODE_TEST_AUTH_FILE together/)
    assert.match(text, /stat -c '%u %a'/)
    assert.match(text, /unset ZCODE_API_KEY/)
    assert.match(text, /unset ZAI_API_KEY/)
    assert.match(text, /provider\.<id>\.options\.apiKey/)
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
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
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
          OC_ZCODE_UPSTREAM_MODEL: 'zai/glm-5.1',
          FAKE_ZCODE_CAPTURE: capture,
        },
      )
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stderr.includes('super-secret-zcode-key'), false)
      assert.match(result.stdout, /sess_w/)
      const captured = JSON.parse(await readFile(capture, 'utf8')) as {
        argv: string[]
        env: Record<string, string | undefined>
        config: { provider: { zai: { options: { apiKey: string } } } }
        configMode: number
      }
      assert.equal(captured.argv[captured.argv.indexOf('--mode') + 1], 'yolo')
      assert.ok(captured.argv.includes('--json'))
      assert.equal(captured.env.ZCODE_MODEL, 'zai/glm-5.1')
      assert.match(String(captured.env.HOME), /openclaude-zcode\./)
      assert.equal(captured.env.ZCODE_API_KEY, undefined)
      assert.equal(captured.env.ZAI_API_KEY, undefined)
      assert.equal(captured.env.ANTHROPIC_API_KEY, undefined)
      assert.equal(captured.config.provider.zai.options.apiKey, 'super-secret-zcode-key')
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
