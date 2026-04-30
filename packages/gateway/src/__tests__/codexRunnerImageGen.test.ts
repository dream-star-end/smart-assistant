import * as assert from 'node:assert/strict'
/**
 * Tests for CodexRunner's image_gen surfacing path. Codex's built-in
 * `image_gen` tool persists images to `~/.codex/generated_images/<thread>/`
 * but does NOT emit any `item.*` event on the `--json` exec stream (only an
 * empty `agent_message` + `turn.completed`), so without this path the web
 * client sees `assistantChars=0` and reports "no content".
 *
 * We test `finalizeTurn` (private) directly with overridden image-dir
 * resolvers + a private `_invokeFinalizeTurn` shim that constructs the args
 * bag exactly like the real close handler does. No subprocess is spawned.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/codexRunnerImageGen.test.ts
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { CodexRunner } from '../codexRunner.js'

// ── Test harness ────────────────────────────────────────────────────────────

interface Harness {
  runner: CodexRunner
  srcRoot: string // tmp root standing in for ~/.codex/generated_images
  dstDir: string // tmp dir standing in for paths.generatedDir
  messages: any[]
  cleanup: () => Promise<void>
}

async function makeHarness(opts: { resumeSessionId?: string } = {}): Promise<Harness> {
  const baseTmp = await mkdtemp(join(tmpdir(), 'codex-runner-imggen-'))
  const srcRoot = join(baseTmp, 'src')
  const dstDir = join(baseTmp, 'dst')
  await mkdir(srcRoot, { recursive: true })
  await mkdir(dstDir, { recursive: true })

  const runner = new CodexRunner({
    sessionKey: 'test',
    agentId: 'test',
    cwd: '/tmp',
    resumeSessionId: opts.resumeSessionId,
  })
  // Override path resolvers to use the tmp dirs
  ;(runner as any).getCodexImageDir = (threadId: string) => join(srcRoot, threadId)
  ;(runner as any).getPublicGeneratedDir = () => dstDir

  const messages: any[] = []
  runner.on('message', (m: any) => messages.push(m))

  return {
    runner,
    srcRoot,
    dstDir,
    messages,
    cleanup: () => rm(baseTmp, { recursive: true, force: true }),
  }
}

/**
 * Invoke the private finalizeTurn helper on a runner with a controllable
 * mutable assistant text closure, returning the final state.
 */
async function invokeFinalize(
  runner: CodexRunner,
  args: {
    code: number | null
    initialAssistantText?: string
    baselineFiles?: Set<string>
    stderrBuf?: string
  },
): Promise<{ finalText: string }> {
  let assistantText = args.initialAssistantText ?? ''
  let settled = false
  await new Promise<void>((resolve) => {
    ;(runner as any)
      .finalizeTurn({
        code: args.code,
        signal: null,
        startedAt: Date.now() - 100,
        baselineFiles: args.baselineFiles ?? new Set<string>(),
        stderrBuf: args.stderrBuf ?? '',
        getLastAssistantText: () => assistantText,
        setLastAssistantText: (v: string) => {
          assistantText = v
        },
        usage: undefined,
        settled: () => settled,
        settle: () => {
          settled = true
          resolve()
        },
      })
      .catch((err: unknown) => {
        // finalizeTurn shouldn't throw — but if it does, fail fast.
        settled = true
        resolve()
        throw err
      })
  })
  return { finalText: assistantText }
}

async function placeImage(srcRoot: string, threadId: string, name: string): Promise<string> {
  const dir = join(srcRoot, threadId)
  await mkdir(dir, { recursive: true })
  const p = join(dir, name)
  // Minimal valid PNG signature so file is non-empty / has plausible content.
  await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return p
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('CodexRunner.finalizeTurn — image_gen surfacing', () => {
  let h: Harness
  afterEach(async () => {
    if (h) await h.cleanup()
  })

  it('fresh turn: empty baseline, one new image → emits text_delta + result.text contains public path', async () => {
    h = await makeHarness()
    const threadId = 'thread-fresh-001'
    ;(h.runner as any).threadId = threadId
    await placeImage(h.srcRoot, threadId, 'ig_aaaa.png')

    const { finalText } = await invokeFinalize(h.runner, {
      code: 0,
      initialAssistantText: '',
      baselineFiles: new Set(),
    })

    const expectedPublic = join(h.dstDir, `codex-${threadId}-ig_aaaa.png`)
    // text_delta event
    const deltas = h.messages.filter((m) => m.type === 'stream_event')
    assert.equal(deltas.length, 1, `expected 1 text_delta, got ${deltas.length}`)
    assert.ok(deltas[0].event.delta.text.includes(expectedPublic))
    // result event with non-empty text containing public path
    const result = h.messages.find((m) => m.type === 'result')
    assert.ok(result)
    assert.equal(result.is_error, false)
    assert.ok(
      result.result.includes(expectedPublic),
      `result.result missing public path: ${result.result}`,
    )
    // file actually exists at public dst
    const copied = await readFile(expectedPublic)
    assert.equal(copied.length, 8) // PNG sig
    // finalText (the last assistant text accumulated) contains public path
    assert.ok(finalText.includes(expectedPublic))
  })

  it('resume turn: baseline has old image, only new images surfaced', async () => {
    h = await makeHarness({ resumeSessionId: 'thread-resume-002' })
    const threadId = 'thread-resume-002'
    await placeImage(h.srcRoot, threadId, 'ig_old.png')
    await placeImage(h.srcRoot, threadId, 'ig_new.png')

    const { finalText } = await invokeFinalize(h.runner, {
      code: 0,
      baselineFiles: new Set(['ig_old.png']),
    })

    const expectedNew = join(h.dstDir, `codex-${threadId}-ig_new.png`)
    const expectedOld = join(h.dstDir, `codex-${threadId}-ig_old.png`)
    assert.ok(finalText.includes(expectedNew))
    assert.ok(!finalText.includes(expectedOld), 'old image should not be re-surfaced')
  })

  it('resume turn no new images: result.text remains empty (no text_delta emitted)', async () => {
    h = await makeHarness({ resumeSessionId: 'thread-resume-003' })
    const threadId = 'thread-resume-003'
    await placeImage(h.srcRoot, threadId, 'ig_old.png')

    const { finalText } = await invokeFinalize(h.runner, {
      code: 0,
      baselineFiles: new Set(['ig_old.png']),
    })

    assert.equal(finalText, '')
    const deltas = h.messages.filter((m) => m.type === 'stream_event')
    assert.equal(deltas.length, 0)
    const result = h.messages.find((m) => m.type === 'result')
    assert.equal(result.result, '')
  })

  it('non-empty agent_message + new image: text appended (not replaced)', async () => {
    h = await makeHarness()
    const threadId = 'thread-append-004'
    ;(h.runner as any).threadId = threadId
    await placeImage(h.srcRoot, threadId, 'ig_x.png')

    const { finalText } = await invokeFinalize(h.runner, {
      code: 0,
      initialAssistantText: 'Here is the image you asked for:',
    })

    assert.ok(finalText.startsWith('Here is the image you asked for:'))
    assert.ok(finalText.includes(join(h.dstDir, `codex-${threadId}-ig_x.png`)))
  })

  it('agent_message mentions source path or basename: STILL emits public path (no false dedupe)', async () => {
    // Per Codex review: dedupe only against the public path. Mentioning the
    // ~/.codex source path or a bare basename in model prose must NOT block
    // the public path emission — both are unrenderable from the web client,
    // so suppressing would regress to the original "no image visible" bug.
    h = await makeHarness()
    const threadId = 'thread-dedupe-005'
    ;(h.runner as any).threadId = threadId
    await placeImage(h.srcRoot, threadId, 'ig_dup.png')

    const { finalText } = await invokeFinalize(h.runner, {
      code: 0,
      initialAssistantText: 'Saved at ~/.codex/generated_images/.../ig_dup.png',
    })

    const expectedPublic = join(h.dstDir, `codex-${threadId}-ig_dup.png`)
    const deltas = h.messages.filter((m) => m.type === 'stream_event')
    assert.equal(deltas.length, 1, 'public path must still be surfaced')
    assert.ok(deltas[0].event.delta.text.includes(expectedPublic))
    assert.ok(finalText.includes(expectedPublic))
    // Original prose preserved alongside the new public-path append
    assert.ok(finalText.startsWith('Saved at ~/.codex/generated_images/.../ig_dup.png'))
  })

  it('agent_message already mentions the public path: skipped (real dedupe)', async () => {
    h = await makeHarness()
    const threadId = 'thread-dedupe-005b'
    ;(h.runner as any).threadId = threadId
    await placeImage(h.srcRoot, threadId, 'ig_dup.png')
    const expectedPublic = join(h.dstDir, `codex-${threadId}-ig_dup.png`)

    const { finalText } = await invokeFinalize(h.runner, {
      code: 0,
      initialAssistantText: `Already linked: ${expectedPublic}`,
    })

    const deltas = h.messages.filter((m) => m.type === 'stream_event')
    assert.equal(deltas.length, 0, 'public-path mention should suppress duplicate emit')
    assert.equal(finalText, `Already linked: ${expectedPublic}`)
  })

  it('public dst dir does not exist: copyImagesToPublicDir auto-creates it', async () => {
    h = await makeHarness()
    const threadId = 'thread-mkdir-005c'
    ;(h.runner as any).threadId = threadId
    await placeImage(h.srcRoot, threadId, 'ig_mk.png')

    // Repoint dst to a path that doesn't exist yet (nested under tmp).
    const missingDst = join(h.dstDir, 'nested', 'sub')
    ;(h.runner as any).getPublicGeneratedDir = () => missingDst

    const { finalText } = await invokeFinalize(h.runner, { code: 0 })

    const expected = join(missingDst, `codex-${threadId}-ig_mk.png`)
    assert.ok(
      finalText.includes(expected),
      `expected auto-created dst path in finalText, got: ${finalText}`,
    )
    const data = await readFile(expected)
    assert.equal(data.length, 8)
  })

  it('multiple images: stable sort by filename, all surfaced', async () => {
    h = await makeHarness()
    const threadId = 'thread-multi-006'
    ;(h.runner as any).threadId = threadId
    await placeImage(h.srcRoot, threadId, 'ig_b.png')
    await placeImage(h.srcRoot, threadId, 'ig_a.png')
    await placeImage(h.srcRoot, threadId, 'ig_c.png')

    const { finalText } = await invokeFinalize(h.runner, { code: 0 })

    const ia = join(h.dstDir, `codex-${threadId}-ig_a.png`)
    const ib = join(h.dstDir, `codex-${threadId}-ig_b.png`)
    const ic = join(h.dstDir, `codex-${threadId}-ig_c.png`)
    // Filename sort: a < b < c
    const idxA = finalText.indexOf(ia)
    const idxB = finalText.indexOf(ib)
    const idxC = finalText.indexOf(ic)
    assert.ok(idxA >= 0 && idxB > idxA && idxC > idxB, `expected a<b<c order, got ${finalText}`)
  })

  it('readdir ENOENT: fallback empty set, no scan, normal empty result', async () => {
    h = await makeHarness()
    const threadId = 'thread-noent-007'
    ;(h.runner as any).threadId = threadId
    // Note: no placeImage call → dir does not exist

    const { finalText } = await invokeFinalize(h.runner, { code: 0 })

    assert.equal(finalText, '')
    const deltas = h.messages.filter((m) => m.type === 'stream_event')
    assert.equal(deltas.length, 0)
    const result = h.messages.find((m) => m.type === 'result')
    assert.equal(result.is_error, false)
  })

  it('copyFile failure: surfaces "copy failed" note instead of unreachable source path', async () => {
    h = await makeHarness()
    const threadId = 'thread-copyfail-008'
    ;(h.runner as any).threadId = threadId
    await placeImage(h.srcRoot, threadId, 'ig_x.png')
    // Force copy failure by pointing public dir at a non-existent path under
    // an unwritable parent (or by overriding copyImagesToPublicDir directly).
    // Simpler: override the method to simulate a failure.
    ;(h.runner as any).copyImagesToPublicDir = async (_tid: string, names: string[]) => ({
      copied: [],
      failedNames: names,
    })

    const { finalText } = await invokeFinalize(h.runner, { code: 0 })

    assert.match(finalText, /image copy failed: ig_x\.png/)
    // No source path leaked
    assert.ok(!finalText.includes('/.codex/generated_images/'))
  })

  it('code !== 0: skip scan, error surfaced from stderr', async () => {
    h = await makeHarness()
    const threadId = 'thread-err-009'
    ;(h.runner as any).threadId = threadId
    await placeImage(h.srcRoot, threadId, 'ig_x.png')

    const { finalText } = await invokeFinalize(h.runner, {
      code: 1,
      stderrBuf: 'codex: something broke',
    })

    // No scan / no copy / no text_delta
    const deltas = h.messages.filter((m) => m.type === 'stream_event')
    assert.equal(deltas.length, 0)
    // result is error with stderr text
    const result = h.messages.find((m) => m.type === 'result')
    assert.equal(result.is_error, true)
    assert.ok(result.result.includes('codex: something broke'))
    assert.equal(finalText, '')
    // The image file in src dir was NOT copied (we don't even try on error)
  })

  it('stable filename: codex-${threadId}-${basename}', async () => {
    h = await makeHarness()
    const threadId = 'abc-123-def'
    ;(h.runner as any).threadId = threadId
    await placeImage(h.srcRoot, threadId, 'ig_hash.png')

    await invokeFinalize(h.runner, { code: 0 })

    const expected = join(h.dstDir, `codex-${threadId}-ig_hash.png`)
    assert.equal(basename(expected), 'codex-abc-123-def-ig_hash.png')
    const data = await readFile(expected)
    assert.ok(data.length > 0)
  })
})
