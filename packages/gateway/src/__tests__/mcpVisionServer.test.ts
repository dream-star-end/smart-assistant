import * as assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'oc-vision-home-'))
process.env.OPENCLAUDE_HOME = home

const vision = await import('../mcpVisionServer.js')

const uploads = join(home, 'uploads')
mkdirSync(uploads, { recursive: true })

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T | Promise<T>) {
  const old = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    old.set(key, process.env[key])
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

describe('openclaude-vision MCP input validation', () => {
  it('accepts a raster image under uploadsDir', () => {
    const p = join(uploads, 'ok.png')
    writeFileSync(p, PNG)
    const resolved = vision.resolveVisionInput({ image_file: p, question: 'what is this?' })
    assert.equal(resolved.imagePath, p)
    assert.match(resolved.prompt, /what is this\?/)
  })

  it('rejects image_url in v1', () => {
    assert.throws(
      () => vision.resolveVisionInput({ image_url: 'https://example.com/a.png' }),
      /image_url is disabled/,
    )
  })

  it('rejects an uploads symlink that points outside uploadsDir', () => {
    const outside = join(home, 'outside.png')
    writeFileSync(outside, PNG)
    const link = join(uploads, 'link.png')
    symlinkSync(outside, link)
    assert.throws(() => vision.resolveVisionInput({ image_file: link }), /uploads directory/)
  })

  it('rejects text renamed as png', () => {
    const p = join(uploads, 'fake.png')
    writeFileSync(p, 'not an image')
    assert.throws(() => vision.resolveVisionInput({ image_file: p }), /supported raster image/)
  })

  it('rejects svg even though it is an image upload type elsewhere', () => {
    const p = join(uploads, 'vector.svg')
    writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    assert.throws(() => vision.resolveVisionInput({ image_file: p }), /supported raster image/)
  })

  it('builds a no-shell codex exec argv with image input and output file', () => {
    const runDir = '/tmp/oc-vision-run'
    const args = vision.buildCodexVisionArgs(
      { imagePath: '/tmp/a.png', prompt: 'describe', model: 'gpt-5.5' },
      '/tmp/out.txt',
      runDir,
    )
    assert.deepEqual(args.slice(0, 5), [
      'exec',
      '--ephemeral',
      '--ignore-rules',
      '--ignore-user-config',
      '--skip-git-repo-check',
    ])
    assert.deepEqual(args.slice(args.indexOf('--cd'), args.indexOf('--cd') + 2), ['--cd', runDir])
    assert.ok(args.includes('features.shell_tool=false'))
    assert.ok(args.includes('features.unified_exec=false'))
    assert.ok(args.includes('web_search="disabled"'))
    assert.ok(args.includes('--image'))
    assert.ok(args.includes('/tmp/a.png'))
    assert.ok(args.includes('--output-last-message'))
    assert.ok(args.includes('/tmp/out.txt'))
    assert.ok(args.includes('gpt-5.5'))
  })

  it('stages the image inside the one-shot run directory before Codex sees it', () => {
    const p = join(uploads, 'stage-source.png')
    writeFileSync(p, PNG)
    const runDir = mkdtempSync(join(tmpdir(), 'oc-vision-run-'))
    const staged = vision.stageVisionImage(p, runDir)
    assert.equal(staged, join(runDir, 'image.png'))
    assert.ok(existsSync(staged))
    assert.deepEqual(readFileSync(staged), PNG)
  })

  it('does not pass OpenClaude or API secrets to the Codex child process', () => {
    const oldOpenAI = process.env.OPENAI_API_KEY
    const oldOpenClaude = process.env.OPENCLAUDE_MASTER_TOKEN
    const oldContainerToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    const oldMasterBase = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
    process.env.OPENAI_API_KEY = 'sk-secret'
    process.env.OPENCLAUDE_MASTER_TOKEN = 'oc-secret'
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3-secret'
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = 'http://172.30.0.1:18791'
    try {
      const env = vision.buildCodexVisionEnv('/tmp/oc-vision-run')
      assert.equal(env.OPENAI_API_KEY, undefined)
      assert.equal(env.OPENCLAUDE_MASTER_TOKEN, undefined)
      assert.equal(env.OPENCLAUDE_V3_CONTAINER_TOKEN, undefined)
      assert.equal(env.OPENCLAUDE_V3_MASTER_BASE_URL, undefined)
      assert.equal(env.HOME, '/tmp/oc-vision-run/home')
      assert.equal(env.CODEX_HOME, '/tmp/oc-vision-run/codex-home')
      assert.match(env.CODEX_SQLITE_HOME ?? '', /oc-vision-run/)
      assert.equal(env.TMPDIR, '/tmp/oc-vision-run')
    } finally {
      if (oldOpenAI === undefined) Reflect.deleteProperty(process.env, 'OPENAI_API_KEY')
      else process.env.OPENAI_API_KEY = oldOpenAI
      if (oldOpenClaude === undefined)
        Reflect.deleteProperty(process.env, 'OPENCLAUDE_MASTER_TOKEN')
      else process.env.OPENCLAUDE_MASTER_TOKEN = oldOpenClaude
      if (oldContainerToken === undefined)
        Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_CONTAINER_TOKEN')
      else process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = oldContainerToken
      if (oldMasterBase === undefined)
        Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_MASTER_BASE_URL')
      else process.env.OPENCLAUDE_V3_MASTER_BASE_URL = oldMasterBase
    }
  })

  it('skips commercial Codex auth refresh outside v3 containers', async () => {
    await withEnv(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: undefined,
        OPENCLAUDE_V3_CONTAINER_TOKEN: undefined,
      },
      async () => {
        let called = false
        const result = await vision.refreshCommercialCodexAuthForVision(async () => {
          called = true
          throw new Error('should not fetch')
        })
        assert.equal(result, 'skipped')
        assert.equal(called, false)
      },
    )
  })

  it('preflights commercial Codex auth refresh without consuming returned token', async () => {
    await withEnv(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.30.0.1:18791/',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-secret',
      },
      async () => {
        const calls: Array<{ url: string; init: any }> = []
        const result = await vision.refreshCommercialCodexAuthForVision(async (url, init) => {
          calls.push({ url, init })
          return {
            ok: true,
            status: 200,
            async text() {
              throw new Error('success body should not be read')
            },
          }
        })
        assert.equal(result, 'refreshed')
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url, 'http://172.30.0.1:18791/internal/v3/codex/token-refresh')
        assert.equal(calls[0].init.headers.Authorization, 'Bearer container-secret')
        assert.equal(JSON.parse(calls[0].init.body).reason, 'openclaude_vision')
      },
    )
  })

  it('can read the commercial container token from a 0600 token file', async () => {
    const tokenFile = join(home, 'v3-container-token')
    writeFileSync(tokenFile, 'file-container-secret\n')
    chmodSync(tokenFile, 0o600)
    await withEnv(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.30.0.1:18791/',
        OPENCLAUDE_V3_CONTAINER_TOKEN: undefined,
        OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: tokenFile,
      },
      async () => {
        const calls: Array<{ url: string; init: any }> = []
        const result = await vision.refreshCommercialCodexAuthForVision(async (url, init) => {
          calls.push({ url, init })
          return {
            ok: true,
            status: 200,
            async text() {
              throw new Error('success body should not be read')
            },
          }
        })
        assert.equal(result, 'refreshed')
        assert.equal(calls.length, 1)
        assert.equal(calls[0].init.headers.Authorization, 'Bearer file-container-secret')
      },
    )
  })

  it('retries a refresh failure once so the master can disable/rebind a bad account', async () => {
    await withEnv(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.30.0.1:18791',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-secret',
      },
      async () => {
        let calls = 0
        const result = await vision.refreshCommercialCodexAuthForVision(async () => {
          calls += 1
          if (calls === 1) {
            return {
              ok: false,
              status: 502,
              async text() {
                return '{"error":{"code":"REFRESH_FAILED","message":"token failed"}}'
              },
            }
          }
          return {
            ok: true,
            status: 200,
            async text() {
              return '{"accessToken":"secret"}'
            },
          }
        })
        assert.equal(result, 'refreshed')
        assert.equal(calls, 2)
      },
    )
  })

  it('retries binding-drift refresh responses once', async () => {
    await withEnv(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.30.0.1:18791',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-secret',
      },
      async () => {
        let calls = 0
        const result = await vision.refreshCommercialCodexAuthForVision(async () => {
          calls += 1
          if (calls === 1) {
            return {
              ok: false,
              status: 409,
              async text() {
                return '{"error":{"code":"CONTAINER_BINDING_CHANGED"}}'
              },
            }
          }
          return {
            ok: true,
            status: 200,
            async text() {
              return '{"accessToken":"secret"}'
            },
          }
        })
        assert.equal(result, 'refreshed')
        assert.equal(calls, 2)
      },
    )
  })

  it('returns sanitized refresh failures', async () => {
    await withEnv(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.30.0.1:18791',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-secret',
      },
      async () => {
        await assert.rejects(
          () =>
            vision.refreshCommercialCodexAuthForVision(async () => ({
              ok: false,
              status: 401,
              async text() {
                return '{"error":{"code":"UNAUTHORIZED","message":"leaked-secret-token"}}'
              },
            })),
          (err: unknown) => {
            assert.ok(err instanceof Error)
            assert.match(err.message, /HTTP 401 UNAUTHORIZED/)
            assert.doesNotMatch(err.message, /leaked-secret-token|container-secret/)
            return true
          },
        )
      },
    )
  })

  it('detects Codex auth failures for one-shot retry', () => {
    assert.equal(
      vision.isCodexVisionAuthFailureForTest(
        new Error('Codex vision failed (exit 1): 401 Unauthorized'),
      ),
      true,
    )
    assert.equal(vision.isCodexVisionAuthFailureForTest(new Error('timeout')), false)
  })

  it('retries once when one-shot Codex reports an invalidated auth token', async () => {
    const sourceHome = mkdtempSync(join(tmpdir(), 'oc-vision-codex-source-'))
    writeFileSync(join(sourceHome, 'auth.json'), '{"tokens":{"access_token":"stale"}}')

    const p = join(uploads, 'retry-auth.png')
    writeFileSync(p, PNG)

    const fakeDir = mkdtempSync(join(tmpdir(), 'oc-vision-fake-codex-'))
    const stateFile = join(fakeDir, 'attempts.txt')
    const fakeCodex = join(fakeDir, 'codex')
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env bash
set -euo pipefail
state=${JSON.stringify(stateFile)}
if [ ! -f "$state" ]; then
  printf '1' > "$state"
  printf '%s\\n' '401 Unauthorized: Your authentication token has been invalidated' >&2
  exit 1
fi
printf '2' > "$state"
out=''
prev=''
for arg in "$@"; do
  if [ "$prev" = '--output-last-message' ]; then
    out="$arg"
    break
  fi
  prev="$arg"
done
printf '%s\\n' 'retry succeeded' > "$out"
printf '%s\\n' 'session id: fake'
`,
    )
    chmodSync(fakeCodex, 0o700)

    await withEnv(
      {
        CODEX_HOME: sourceHome,
        OPENCLAUDE_VISION_CODEX_CMD: fakeCodex,
        OPENCLAUDE_VISION_CODEX_REFRESH_DISABLED: '1',
      },
      async () => {
        const text = await vision.runCodexVisionForTest(
          vision.resolveVisionInput({ image_file: p, question: 'describe' }),
        )
        assert.equal(text, 'retry succeeded')
        assert.equal(readFileSync(stateFile, 'utf8'), '2')
      },
    )
  })

  it('copies Codex auth into the one-shot run directory instead of using host CODEX_HOME', () => {
    const oldCodexHome = process.env.CODEX_HOME
    const sourceHome = mkdtempSync(join(tmpdir(), 'oc-vision-codex-source-'))
    writeFileSync(join(sourceHome, 'auth.json'), '{"access_token":"secret"}')
    process.env.CODEX_HOME = sourceHome
    try {
      const runDir = mkdtempSync(join(tmpdir(), 'oc-vision-run-'))
      const codexHome = vision.prepareCodexVisionHome(runDir)
      assert.equal(codexHome, join(runDir, 'codex-home'))
      assert.equal(readFileSync(join(codexHome, 'auth.json'), 'utf8'), '{"access_token":"secret"}')
    } finally {
      if (oldCodexHome === undefined) Reflect.deleteProperty(process.env, 'CODEX_HOME')
      else process.env.CODEX_HOME = oldCodexHome
    }
  })

  it('reaps stale malformed vision lock directories', () => {
    const lockDir = join(tmpdir(), 'openclaude-vision-codex.99.lock')
    rmSync(lockDir, { recursive: true, force: true })
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'owner.json'), '{not-json')
    const oldTime = new Date(Date.now() - 120_000)
    utimesSync(join(lockDir, 'owner.json'), oldTime, oldTime)
    utimesSync(lockDir, oldTime, oldTime)
    const release = vision.tryAcquireVisionLockSlotForTest(99, 1000)
    assert.equal(typeof release, 'function')
    release?.()
    assert.equal(existsSync(lockDir), false)
  })
})
