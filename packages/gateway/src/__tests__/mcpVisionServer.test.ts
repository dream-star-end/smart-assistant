import * as assert from 'node:assert/strict'
import {
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
    process.env.OPENAI_API_KEY = 'sk-secret'
    process.env.OPENCLAUDE_MASTER_TOKEN = 'oc-secret'
    try {
      const env = vision.buildCodexVisionEnv('/tmp/oc-vision-run')
      assert.equal(env.OPENAI_API_KEY, undefined)
      assert.equal(env.OPENCLAUDE_MASTER_TOKEN, undefined)
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
    }
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
