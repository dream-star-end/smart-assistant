import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseImageModelPolicy } from '../billing/imageModels.js'
import {
  normalizeNativeImageRequest,
  parseAnnotatedImageRequest,
} from '../http/internalCodexRelay.js'

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv

describe('parseImageModelPolicy (OCV5-587)', () => {
  test('defaults to exactly gpt-image-2 for both native and edits', () => {
    const p = parseImageModelPolicy(env({}))
    assert.deepEqual([...p.allowed], ['gpt-image-2'])
    assert.equal(p.editDefault, 'gpt-image-2')
  })

  test('parses a comma list and honours a configured edit model', () => {
    const p = parseImageModelPolicy(
      env({
        OC_IMAGE2_ALLOWED_MODELS: ' gpt-image-2, gpt-image-2.5-flare ,gpt-image-2.5-sunburst,',
        OC_IMAGE2_EDIT_MODEL: 'gpt-image-2.5-sunburst',
      }),
    )
    assert.deepEqual(
      [...p.allowed],
      ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'],
    )
    assert.equal(p.editDefault, 'gpt-image-2.5-sunburst')
  })

  test('drops ids outside gpt-image-* and falls back to gpt-image-2 when nothing valid remains', () => {
    const warnings: string[] = []
    const p = parseImageModelPolicy(
      env({ OC_IMAGE2_ALLOWED_MODELS: 'dall-e-3,gpt-5.5,GPT-IMAGE-2,gpt-image-2;x' }),
      (m) => warnings.push(m),
    )
    assert.deepEqual([...p.allowed], ['gpt-image-2'])
    assert.ok(warnings.length >= 4, 'each rejected id and the fallback are warned')
  })

  test('an edit model outside the allowlist falls back instead of widening the allowlist', () => {
    const p = parseImageModelPolicy(
      env({
        OC_IMAGE2_ALLOWED_MODELS: 'gpt-image-2',
        OC_IMAGE2_EDIT_MODEL: 'gpt-image-2.5-sunburst',
      }),
    )
    assert.equal(p.editDefault, 'gpt-image-2')
    assert.ok(!p.allowed.has('gpt-image-2.5-sunburst'))
    const only25 = parseImageModelPolicy(env({ OC_IMAGE2_ALLOWED_MODELS: 'gpt-image-2.5-flare' }))
    assert.equal(only25.editDefault, 'gpt-image-2.5-flare')
  })
})

describe('normalizeNativeImageRequest model allowlist (OCV5-587)', () => {
  const json = (body: unknown) => Buffer.from(JSON.stringify(body))

  test('default policy rejects gpt-image-2.5 and keeps gpt-image-2 byte-compatible', async () => {
    const p = parseImageModelPolicy(env({}))
    await assert.rejects(
      normalizeNativeImageRequest(
        json({ model: 'gpt-image-2.5-flare', prompt: 'x' }),
        'application/json',
        p,
      ),
      /only model=gpt-image-2 is supported/,
    )
    const ok = await normalizeNativeImageRequest(
      json({ model: 'gpt-image-2', prompt: 'x', n: 9 }),
      'application/json',
      p,
    )
    assert.equal(ok.model, 'gpt-image-2')
    assert.equal(ok.imageCount, 4)
    assert.deepEqual(JSON.parse(String(ok.body)), { model: 'gpt-image-2', prompt: 'x', n: 4 })
  })

  test('an allowlisted 2.5 model is forwarded unchanged and hashes differently from 2', async () => {
    const p = parseImageModelPolicy(
      env({ OC_IMAGE2_ALLOWED_MODELS: 'gpt-image-2,gpt-image-2.5-flare' }),
    )
    const a = await normalizeNativeImageRequest(
      json({ model: 'gpt-image-2.5-flare', prompt: 'x' }),
      'application/json',
      p,
    )
    const b = await normalizeNativeImageRequest(
      json({ model: 'gpt-image-2', prompt: 'x' }),
      'application/json',
      p,
    )
    assert.equal(a.model, 'gpt-image-2.5-flare')
    assert.equal((JSON.parse(String(a.body)) as { model: string }).model, 'gpt-image-2.5-flare')
    assert.notDeepEqual(a.digest, b.digest)
  })

  test('multipart: needs exactly one allowlisted model field and forwards it', async () => {
    const p = parseImageModelPolicy(env({ OC_IMAGE2_ALLOWED_MODELS: 'gpt-image-2.5-sunburst' }))
    const form = new FormData()
    form.set('model', 'gpt-image-2.5-sunburst')
    form.set('prompt', 'x')
    const req = new Request('http://x.invalid', { method: 'POST', body: form })
    const body = Buffer.from(await req.arrayBuffer())
    const ct = req.headers.get('content-type') ?? undefined
    const out = await normalizeNativeImageRequest(body, ct, p)
    assert.equal(out.model, 'gpt-image-2.5-sunburst')
    assert.equal((out.body as FormData).get('model'), 'gpt-image-2.5-sunburst')
    const bad = new FormData()
    bad.set('model', 'gpt-image-2')
    const badReq = new Request('http://x.invalid', { method: 'POST', body: bad })
    await assert.rejects(
      normalizeNativeImageRequest(
        Buffer.from(await badReq.arrayBuffer()),
        badReq.headers.get('content-type') ?? undefined,
        p,
      ),
      /only model=gpt-image-2.5-sunburst is supported/,
    )
  })
})

describe('parseAnnotatedImageRequest optional model (OCV5-587)', () => {
  const base = {
    jobId: 'a'.repeat(32),
    prompt: 'fix it',
    width: 4,
    height: 4,
    sourceBase64: 'AA==',
    maskBase64: 'AA==',
  }
  const b = (v: unknown) => Buffer.from(JSON.stringify(v))

  test('model is optional and passes through when it is a gpt-image id', () => {
    assert.equal(parseAnnotatedImageRequest(b(base)).model, undefined)
    assert.equal(
      parseAnnotatedImageRequest(b({ ...base, model: 'gpt-image-2.5-sunburst' })).model,
      'gpt-image-2.5-sunburst',
    )
  })

  test('a non gpt-image model id is rejected at parse time', () => {
    for (const model of ['dall-e-3', 42, '', 'gpt-image-2 ']) {
      assert.throws(
        () => parseAnnotatedImageRequest(b({ ...base, model })),
        /invalid annotated image request/,
      )
    }
  })
})
