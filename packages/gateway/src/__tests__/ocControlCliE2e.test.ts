import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import { runOcBrowser } from '../ocBrowserCli.js'
import { ocBrowserAgentDir, ocBrowserSocketPath } from '../ocBrowserShared.js'

type RunResult = { code: number | null; stdout: string; stderr: string }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const TSX = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')

function childEnv(patch: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...patch }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) Reflect.deleteProperty(env, key)
  }
  return env
}

function runTs(entry: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [TSX, join(REPO_ROOT, entry), ...args], {
      cwd: REPO_ROOT,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
  })
}

async function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key])
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

describe('oc-browser real Unix socket CLI transport', () => {
  test('all seven commands send exact wire tools/args and format daemon results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-browser-cli-e2e-'))
    const agentId = 'surface-e2e'
    const requests: Array<{ tool: string; args: Record<string, unknown> }> = []
    try {
      await withEnv(
        {
          OPENCLAUDE_OC_BROWSER_ROOT: root,
          OPENCLAUDE_AGENT_ID: agentId,
        },
        async () => {
          mkdirSync(ocBrowserAgentDir(agentId), { recursive: true })
          const socketPath = ocBrowserSocketPath(agentId)
          const server = createNetServer((socket) => {
            let input = ''
            socket.on('data', (chunk) => {
              input += String(chunk)
              const newline = input.indexOf('\n')
              if (newline < 0) return
              const request = JSON.parse(input.slice(0, newline)) as {
                tool: string
                args: Record<string, unknown>
              }
              requests.push(request)
              socket.end(
                `${JSON.stringify({
                  ok: true,
                  result: { content: [{ type: 'text', text: `${request.tool}-ok` }] },
                })}\n`,
              )
            })
          })
          await new Promise<void>((done) => server.listen(socketPath, done))
          try {
            const cases: Array<{ argv: string[]; tool: string; args: Record<string, unknown> }> = [
              {
                argv: ['navigate', '--url', 'https://example.com'],
                tool: 'browser_navigate',
                args: { url: 'https://example.com' },
              },
              { argv: ['snapshot', '--json'], tool: 'browser_snapshot', args: {} },
              {
                argv: ['click', '--ref', 'e1', '--element', 'Submit'],
                tool: 'browser_click',
                args: { ref: 'e1', element: 'Submit' },
              },
              {
                argv: [
                  'type',
                  '--ref',
                  'e2',
                  '--element',
                  'Search',
                  '--text',
                  'OpenClaude',
                  '--submit',
                ],
                tool: 'browser_type',
                args: { ref: 'e2', element: 'Search', text: 'OpenClaude', submit: true },
              },
              {
                argv: ['press-key', '--key', 'Enter'],
                tool: 'browser_press_key',
                args: { key: 'Enter' },
              },
              {
                argv: ['screenshot', '--path', '/tmp/shot.png', '--full-page'],
                tool: 'browser_take_screenshot',
                args: { filename: '/tmp/shot.png', fullPage: true },
              },
              {
                argv: ['wait-for', '--text', 'Done', '--text-gone', 'Loading', '--time', '0.5'],
                tool: 'browser_wait_for',
                args: { text: 'Done', textGone: 'Loading', time: 0.5 },
              },
            ]

            for (const item of cases) {
              const result = await runOcBrowser(item.argv)
              assert.equal(result.exitCode, 0, result.stderr)
              if (item.argv.includes('--json')) {
                const parsed = JSON.parse(result.stdout)
                assert.equal(parsed.result.content[0].text, `${item.tool}-ok`)
              } else {
                assert.equal(result.stdout, `${item.tool}-ok\n`)
              }
            }
            assert.deepEqual(
              requests,
              cases.map(({ tool, args }) => ({ tool, args })),
            )
          } finally {
            await new Promise<void>((done) => server.close(() => done()))
          }
        },
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('oc-skill real loopback CLI transport', () => {
  test('four commands preserve confirm gate, method, route and body', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-skill-cli-e2e-'))
    const home = join(work, 'home')
    mkdirSync(home)
    const requests: Array<{ method: string; url: string; body: unknown }> = []
    const server = createHttpServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          body: raw ? JSON.parse(raw) : undefined,
        })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ ok: true, route: request.url }))
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    writeFileSync(
      join(home, 'openclaude.json'),
      JSON.stringify({ gateway: { port: address.port } }),
    )
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      OPENCLAUDE_HOME: home,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      ALL_PROXY: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      all_proxy: undefined,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    }
    try {
      let result = await runTs('packages/gateway/src/ocSkillCli.ts', ['train', 'demo'], env)
      assert.equal(result.code, 2)
      assert.match(result.stderr, /取得用户同意/)
      assert.deepEqual(requests, [])

      for (const args of [
        ['train', 'demo', '--confirm', '--focus', 'clarity'],
        ['train-status', 'run-1'],
        ['evals-generate', 'demo', '--confirm'],
        ['evals-gen-status', 'run-2'],
      ]) {
        result = await runTs('packages/gateway/src/ocSkillCli.ts', args, env)
        assert.equal(result.code, 0, result.stderr)
        assert.equal(JSON.parse(result.stdout).ok, true)
      }
      assert.deepEqual(requests, [
        {
          method: 'POST',
          url: '/internal/v3/skill-local/skills/demo/train',
          body: { focus: 'clarity' },
        },
        {
          method: 'GET',
          url: '/internal/v3/skill-local/skill-training/run-1',
          body: undefined,
        },
        {
          method: 'POST',
          url: '/internal/v3/skill-local/skills/demo/evals/generate',
          body: {},
        },
        {
          method: 'GET',
          url: '/internal/v3/skill-local/skill-eval-gen/run-2',
          body: undefined,
        },
      ])
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
      rmSync(work, { recursive: true, force: true })
    }
  })
})

function crc32(value: Buffer): number {
  let crc = 0xffffffff
  for (const byte of value) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function publicationPng(width = 1200, height = 800): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  const row = Buffer.alloc(width * 3, 255)
  for (let y = 0; y < height; y++) {
    row.fill(255)
    if (y >= 150 && y < 650) row.fill(Buffer.from([48, 96, 168]), 200 * 3, 1000 * 3)
    const offset = y * (width * 3 + 1)
    raw[offset] = 0
    row.copy(raw, offset + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const phys = Buffer.alloc(9)
  phys.writeUInt32BE(11_811, 0)
  phys.writeUInt32BE(11_811, 4)
  phys[8] = 1
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('pHYs', phys),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

describe('oc-vision and oc-figcheck real CLI pipeline with isolated Codex backend', () => {
  test('safe PNG flows through runVision and figcheck emits a deterministic PASS', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-vision-cli-e2e-'))
    const home = join(work, 'home')
    const uploads = join(home, 'uploads')
    const codexHome = join(work, 'source-codex-home')
    const lockDir = join(work, 'vision-locks')
    mkdirSync(uploads, { recursive: true })
    mkdirSync(codexHome)
    mkdirSync(lockDir)
    writeFileSync(join(codexHome, 'auth.json'), '{}', { mode: 0o600 })
    const image = join(uploads, 'publication.png')
    writeFileSync(image, publicationPng())

    const log = join(work, 'fake-codex.jsonl')
    const fakeCodex = join(work, 'fake-codex')
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/node
import fs from 'node:fs'
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const record = {
  args,
  image: value('--image'),
  output: value('--output-last-message'),
  prompt: args[args.length - 1],
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(record) + '\\n')
fs.writeFileSync(record.output, 'PASS: publication quality')
`,
    )
    chmodSync(fakeCodex, 0o755)

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      OPENCLAUDE_HOME: home,
      CODEX_HOME: codexHome,
      OPENCLAUDE_VISION_BACKEND: 'codex',
      OPENCLAUDE_VISION_CODEX_CMD: fakeCodex,
      OPENCLAUDE_VISION_CODEX_REFRESH_DISABLED: '1',
      OPENCLAUDE_VISION_LOCK_DIR: lockDir,
      OPENCLAUDE_VISION_TIMEOUT_MS: '10000',
      OPENCLAUDE_V3_MASTER_BASE_URL: undefined,
      OPENCLAUDE_V3_CONTAINER_TOKEN: undefined,
      OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: undefined,
      ANTHROPIC_BASE_URL: undefined,
      OPENAI_API_KEY: undefined,
    }
    try {
      let result = await runTs(
        'packages/gateway/src/ocVisionCli.ts',
        ['understand', image, '--prompt', 'Read the visible labels'],
        env,
      )
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout, 'PASS: publication quality\n')

      result = await runTs(
        'packages/gateway/src/ocFigCheckCli.ts',
        [image, '--kind', 'figure', '--focus', 'axis labels'],
        env,
      )
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /\nVERDICT: PASS\n$/)
      const report = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf('\nVERDICT:')))
      assert.equal(report.kind, 'figure')
      assert.equal(report.deterministic.checks.width, 1200)
      assert.equal(report.deterministic.checks.height, 800)
      assert.equal(report.deterministic.checks.dpi, 300)
      if (report.deterministic.checks.dominantFrac !== undefined) {
        assert.ok(report.deterministic.checks.dominantFrac < 0.92)
        assert.ok(report.deterministic.checks.edgeInkFrac < 0.14)
      }
      assert.deepEqual(report.deterministic.issues, [])
      assert.equal(report.vision.pass, true)
      assert.equal(report.verdict, 'PASS')

      const records = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.equal(records.length, 2)
      assert.match(records[0].prompt, /Read the visible labels/)
      assert.match(records[1].prompt, /axis labels/)
      for (const record of records) {
        assert.equal(record.args[0], 'exec')
        assert.ok(record.args.includes('--ephemeral'))
        assert.equal(basename(record.image), 'image.png')
        assert.equal(basename(record.output), 'last-message.txt')
        assert.notEqual(record.image, image)
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
