/**
 * OCV5-591 A2-0 media provider registry: config parsing never throws, missing keys read as
 * "not configured", music has no default provider, candidate ordering, reservation bounds, and
 * no key material in any view or warning. Pure unit test: fake hubs / runners, no upstream.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Image2RunError } from '../billing/image2Run.js'
import { HttpError } from '../http/util.js'
import {
  BUILTIN_ADAPTERS,
  type BuiltinAdapterDeps,
} from '../media-studio/providers/adapters/index.js'
import { speechCharBound } from '../media-studio/providers/adapters/minimaxSpeech.js'
import { museJobIdFor, uuidV5 } from '../media-studio/providers/adapters/muse.js'
import {
  type AdapterFactory,
  createProviderRegistry,
  parseProviderConfig,
  resolveEntryKey,
} from '../media-studio/providers/registry.js'
import { MediaProviderError, type MediaRunContext } from '../media-studio/providers/types.js'

const SENTINEL_KEY = 'sk-SENTINEL-do-not-leak-0123456789'
const SENTINEL_PATH = '/secret/path/sentinel-key-file'
const USER = { id: '247', role: 'user' }

function ctx(over: Partial<MediaRunContext> = {}): MediaRunContext {
  return {
    userId: 247n,
    execRequestId: 'studio:11111111-2222-4333-8444-555555555555',
    maxCostCredits: 1_000n,
    signal: new AbortController().signal,
    readInput: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...over,
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function fakeDeps(over: Partial<BuiltinAdapterDeps> = {}): BuiltinAdapterDeps & {
  calls: unknown[]
} {
  const calls: unknown[] = []
  return {
    calls,
    image2: {
      enabled: true,
      policy: {
        allowed: new Set(['gpt-image-2', 'gpt-image-2.5-flare']),
        editDefault: 'gpt-image-2',
      },
      async run(input) {
        calls.push(input)
        return {
          images: [PNG],
          model: input.model ?? 'gpt-image-2',
          costCredits: 50n,
          requestId: 'r1',
          charged: true,
        }
      },
    },
    muse: {
      hub: {
        bridgeOnline: () => true,
        isAllowed: () => true,
        async submit(_u, _c, spec, opts) {
          calls.push({ spec, opts })
          return opts?.jobId ?? 'mj_x'
        },
        async view(_u, jobId) {
          return {
            job_id: jobId,
            kind: 'video',
            status: 'succeeded',
            files: [{ idx: 0, filename: 'a.mp4', mime: 'video/mp4', bytes: 3, sha256: 'x' }],
            snapshot_id: 'snap-1',
            charged_credits: '50',
          }
        },
        async fileFor(_u, _j, idx) {
          return {
            path: `/muse/${idx}.bin`,
            file: { idx, filename: 'a.mp4', mime: 'video/mp4', bytes: 3, sha256: 'x' },
          }
        },
      },
      prices: { image: 10n, video: 50n },
      readFile: async () => Buffer.from('mp4'),
    },
    minimax: { mediaKey: { source: 'none' }, client: { pool: {} as never } },
    ...over,
  }
}

function build(entries: string | undefined, deps = fakeDeps(), env: NodeJS.ProcessEnv = {}) {
  const warnings: string[] = []
  const warn = (m: string) => warnings.push(m)
  const registry = createProviderRegistry({
    entries: parseProviderConfig(entries, warn),
    factories: BUILTIN_ADAPTERS,
    deps,
    env,
    readFile: (p) => {
      if (p === SENTINEL_PATH) return `${SENTINEL_KEY}\n`
      throw new Error(`ENOENT ${p}`)
    },
    warn,
  })
  return { registry, warnings, deps }
}

const kindView = (r: ReturnType<typeof build>['registry'], kind: string) =>
  r.describe(USER).kinds.find((k) => k.kind === kind)!

describe('default providers (no OC_STUDIO_PROVIDERS)', () => {
  it('lists all four kinds; music has no provider; missing MiniMax key is "not configured"', () => {
    const { registry, warnings } = build(undefined)
    assert.deepEqual(
      registry.describe(USER).kinds.map((k) => [k.kind, k.state]),
      [
        ['image', 'ready'],
        ['video', 'ready'],
        ['voice', 'unconfigured'],
        ['music', 'unconfigured'],
      ],
    )
    assert.equal(kindView(registry, 'music').reason, 'NO_PROVIDER')
    assert.deepEqual(kindView(registry, 'music').providers, [])
    const voice = kindView(registry, 'voice').providers[0]!
    assert.equal(voice.state, 'unconfigured')
    assert.equal(voice.reason, 'MISSING_KEY')
    assert.deepEqual(warnings, [])
  })

  it('follows today switches: Image 2 off → disabled, bridge offline → offline, Muse not allowed', () => {
    const deps = fakeDeps()
    deps.image2!.enabled = false
    deps.muse!.hub.bridgeOnline = () => false
    const { registry } = build(undefined, deps)
    const image = kindView(registry, 'image')
    assert.deepEqual(
      image.providers.map((p) => [p.id, p.state, p.reason]),
      [
        ['gpt-image', 'disabled', 'FEATURE_OFF'],
        ['muse-image', 'offline', 'BRIDGE_OFFLINE'],
      ],
    )
    assert.equal(image.state, 'offline')
    deps.muse!.hub.isAllowed = (uid: string) => uid !== '247'
    assert.equal(kindView(registry, 'video').providers[0]!.reason, 'NOT_ALLOWED_FOR_USER')
  })

  it('uses the Image 2 allowlist as the GPT model list, default = edit model', () => {
    const { registry } = build(undefined)
    const gpt = kindView(registry, 'image').providers.find((p) => p.id === 'gpt-image')!
    assert.deepEqual(
      gpt.models.map((m) => [m.id, m.isDefault]),
      [
        ['gpt-image-2', true],
        ['gpt-image-2.5-flare', false],
      ],
    )
  })

  it('a present MiniMax media key makes voice ready', () => {
    const deps = fakeDeps({
      minimax: {
        mediaKey: { key: SENTINEL_KEY, source: 'file' },
        client: { pool: {} as never },
      },
    })
    assert.equal(kindView(build(undefined, deps).registry, 'voice').state, 'ready')
  })
})

describe('OC_STUDIO_PROVIDERS parsing never throws', () => {
  for (const [name, raw] of [
    ['not JSON', '{oops'],
    ['not an array', '{"id":"x"}'],
  ] as const) {
    it(`${name} → nothing configured, one warning`, () => {
      const { registry, warnings } = build(raw)
      assert.ok(registry.describe(USER).kinds.every((k) => k.state === 'unconfigured'))
      assert.equal(warnings.length, 1)
    })
  }

  it('bad entries are dropped or disabled one by one; good ones still work', () => {
    const { registry, warnings } = build(
      JSON.stringify([
        { id: 'muse' }, // missing adapter
        { id: 'Bad Id', adapter: 'muse-video' },
        { id: 'x1', adapter: 'no-such-adapter' },
        { id: 'leak', adapter: 'gpt-image', apiKey: SENTINEL_KEY },
        { id: 'gpt-image', adapter: 'gpt-image', models: ['gpt-image-9'] },
        { id: 'muse-video', adapter: 'muse-video', priority: 5 },
        { id: 'muse-video', adapter: 'muse-video' },
        { id: 'opts', adapter: 'muse-image', options: { baseUrl: 'https://x' } },
      ]),
    )
    assert.deepEqual(
      registry.list().map((p) => [p.id, p.status(USER).state]),
      [
        ['gpt-image', 'disabled'],
        ['muse-video', 'ready'],
        ['opts', 'disabled'],
      ],
    )
    assert.equal(warnings.length, 8)
    for (const w of warnings) assert.ok(!w.includes(SENTINEL_KEY), w)
  })

  it('caps the entry count', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, adapter: 'muse-image' }))
    const { registry, warnings } = build(JSON.stringify(many))
    assert.equal(registry.list().length, 32)
    assert.equal(warnings.length, 1)
  })

  it('enabled:false and model narrowing / defaultModel', () => {
    const { registry, warnings } = build(
      JSON.stringify([
        {
          id: 'gpt-image',
          adapter: 'gpt-image',
          models: ['gpt-image-2.5-flare'],
          defaultModel: 'gpt-image-2.5-flare',
        },
        { id: 'muse-video', adapter: 'muse-video', enabled: false },
      ]),
    )
    assert.deepEqual(warnings, [])
    const gpt = kindView(registry, 'image').providers[0]!
    assert.deepEqual(
      gpt.models.map((m) => [m.id, m.isDefault]),
      [['gpt-image-2.5-flare', true]],
    )
    assert.deepEqual(kindView(registry, 'video').providers[0]!, {
      id: 'muse-video',
      label: 'Muse',
      state: 'disabled',
      reason: 'DISABLED_BY_CONFIG',
      models: kindView(registry, 'video').providers[0]!.models,
    })
  })
})

describe('keys', () => {
  it('keyFile / keyEnv resolution; unreadable and missing are distinguished', () => {
    const read = (p: string) => {
      if (p === SENTINEL_PATH) return `  ${SENTINEL_KEY}\n`
      throw new Error('nope')
    }
    assert.deepEqual(resolveEntryKey({ keyFile: SENTINEL_PATH }, {}, read), { key: SENTINEL_KEY })
    assert.deepEqual(resolveEntryKey({ keyFile: '/missing' }, {}, read), {
      missing: 'KEY_UNREADABLE',
    })
    assert.deepEqual(resolveEntryKey({ keyEnv: 'MY_KEY' }, {}, read), { missing: 'MISSING_KEY' })
    assert.deepEqual(resolveEntryKey({ keyEnv: 'MY_KEY' }, { MY_KEY: 'two words' }, read), {
      missing: 'KEY_UNREADABLE',
    })
    assert.equal(resolveEntryKey({}, {}, read), undefined)
  })

  it('never exposes a key, its path or env name in the view or warnings', () => {
    const music: AdapterFactory<BuiltinAdapterDeps> = {
      adapter: 'test-music',
      kind: 'music',
      label: 'Test Music',
      models: () => [{ id: 'm1', label: 'M1', ops: ['music.generate'], isDefault: true }],
      create: ({ key }) => {
        assert.equal(key, SENTINEL_KEY)
        return {
          status: () => null,
          estimateMaxCost: () => 5n,
          chargedFor: async () => 0n,
          run: async () => {
            throw new Error('unused')
          },
        }
      },
    }
    const warnings: string[] = []
    const registry = createProviderRegistry({
      entries: parseProviderConfig(
        JSON.stringify([
          { id: 'music-a', adapter: 'test-music', keyFile: SENTINEL_PATH },
          { id: 'music-b', adapter: 'test-music', keyFile: '/nope/SENTINEL_NAME' },
          { id: 'music-c', adapter: 'test-music', keyEnv: 'SENTINEL_ENV_NAME' },
        ]),
        (m) => warnings.push(m),
      ),
      factories: [...BUILTIN_ADAPTERS, music],
      deps: fakeDeps(),
      env: {},
      readFile: (p) => {
        if (p === SENTINEL_PATH) return SENTINEL_KEY
        throw new Error(p)
      },
      warn: (m) => warnings.push(m),
    })
    const view = registry.describe(USER)
    assert.deepEqual(
      view.kinds.find((k) => k.kind === 'music')!.providers.map((p) => [p.id, p.state, p.reason]),
      [
        ['music-a', 'ready', undefined],
        ['music-b', 'unconfigured', 'KEY_UNREADABLE'],
        ['music-c', 'unconfigured', 'MISSING_KEY'],
      ],
    )
    const blob = JSON.stringify(view) + warnings.join('\n')
    for (const s of [SENTINEL_KEY, SENTINEL_PATH, 'SENTINEL_NAME', 'SENTINEL_ENV_NAME']) {
      assert.ok(!blob.includes(s), `leaked ${s}`)
    }
  })
})

describe('candidates', () => {
  it('ready only by default; includeOffline appends offline; prefer and exclude', () => {
    const deps = fakeDeps()
    const { registry } = build(
      JSON.stringify([
        { id: 'muse-image', adapter: 'muse-image', priority: 20 },
        { id: 'gpt-image', adapter: 'gpt-image', priority: 10 },
        { id: 'gpt-b', adapter: 'gpt-image', priority: 10 },
        { id: 'gpt-off', adapter: 'gpt-image', enabled: false },
      ]),
      deps,
    )
    const ids = (o?: Parameters<typeof registry.candidates>[3]) =>
      registry.candidates('image', 'image.generate', USER, o).map((p) => p.id)
    assert.deepEqual(ids(), ['gpt-b', 'gpt-image', 'muse-image'])
    assert.deepEqual(ids({ prefer: 'muse-image' }), ['muse-image', 'gpt-b', 'gpt-image'])
    assert.deepEqual(ids({ exclude: ['gpt-b'] }), ['gpt-image', 'muse-image'])
    deps.muse!.hub.bridgeOnline = () => false
    assert.deepEqual(ids(), ['gpt-b', 'gpt-image'])
    assert.deepEqual(ids({ includeOffline: true }), ['gpt-b', 'gpt-image', 'muse-image'])
    assert.deepEqual(
      registry.candidates('video', 'video.from_image', USER, { includeOffline: true }),
      [],
    )
    assert.equal(registry.get('muse-image')!.affinity(), 'muse')
    assert.equal(registry.get('gpt-image')!.affinity(), null)
  })

  it('music has no candidates by default', () => {
    assert.deepEqual(
      build(undefined).registry.candidates('music', 'music.generate', USER, {
        includeOffline: true,
      }),
      [],
    )
  })
})

describe('adapters', () => {
  it('gpt-image: requestKey = execRequestId, size from aspect, replay keeps the original cost', async () => {
    const deps = fakeDeps()
    deps.image2!.run = async (input) => {
      deps.calls.push(input)
      return {
        images: [PNG],
        model: 'gpt-image-2',
        costCredits: 50n,
        requestId: 'r1',
        charged: false,
      }
    }
    const p = build(undefined, deps).registry.get('gpt-image')!
    const out = await p.run(ctx(), { op: 'image.generate', prompt: 'fox', aspect: '9:16' })
    const call = deps.calls[0] as Record<string, unknown>
    assert.equal(call.requestKey, ctx().execRequestId)
    assert.equal(call.size, '1024x1536')
    assert.equal(call.model, 'gpt-image-2')
    assert.equal(out.outputs[0]!.mime, 'image/png')
    assert.equal(out.costCredits, 50n)
    assert.equal(out.charged, false)
    assert.equal(out.overReservation, false)
    assert.deepEqual(out.providerRef, { table: 'image_generation_usage_records', id: 'r1' })
  })

  it('gpt-image: daily limit is not retryable; edit needs a source', async () => {
    const deps = fakeDeps()
    deps.image2!.run = async () => {
      throw new Image2RunError('IMAGE_DAILY_LIMIT', 'cap')
    }
    const p = build(undefined, deps).registry.get('gpt-image')!
    await assert.rejects(p.run(ctx(), { op: 'image.generate', prompt: 'x' }), (e: unknown) => {
      assert.ok(e instanceof MediaProviderError)
      assert.equal(e.code, 'IMAGE_DAILY_LIMIT')
      assert.equal(e.retryable, false)
      return true
    })
    await assert.rejects(p.run(ctx(), { op: 'image.edit', prompt: 'x' }), {
      code: 'INVALID_REQUEST',
    })
    await assert.rejects(p.run(ctx(), { op: 'video.from_text' }), { code: 'UNSUPPORTED_OP' })
    await assert.rejects(p.run(ctx(), { op: 'image.generate', model: 'gpt-image-9' }), {
      code: 'UNSUPPORTED_OP',
    })
  })

  it('muse: deterministic job id per execution, outputs read from the hub, snapshot in meta', async () => {
    const deps = fakeDeps()
    const p = build(undefined, deps).registry.get('muse-video')!
    const out = await p.run(ctx(), {
      op: 'video.from_image',
      prompt: 'run',
      aspect: '16:9',
      inputs: [{ role: 'first_frame', blobSha: 'a'.repeat(64) }],
    })
    const sub = deps.calls[0] as { spec: Record<string, unknown>; opts: { jobId: string } }
    assert.equal(sub.opts.jobId, museJobIdFor(ctx().execRequestId))
    assert.match(sub.opts.jobId, /^mj_[0-9a-f-]{36}$/)
    assert.equal(museJobIdFor(ctx().execRequestId), sub.opts.jobId)
    assert.notEqual(museJobIdFor('studio:other'), sub.opts.jobId)
    assert.equal(sub.spec.orientation, 'landscape')
    assert.equal((sub.spec.source_images as string[]).length, 1)
    assert.equal(out.outputs[0]!.mime, 'video/mp4')
    assert.equal(out.costCredits, 50n)
    assert.deepEqual(out.meta, { snapshotId: 'snap-1' })
    await assert.rejects(p.run(ctx(), { op: 'video.extend', prompt: 'x' }), {
      code: 'INVALID_REQUEST',
    })
  })

  it('muse: failed outcome keeps its retryable flag', async () => {
    const deps = fakeDeps()
    deps.muse!.hub.view = async (_u, jobId) => ({
      job_id: jobId,
      kind: 'video',
      status: 'failed',
      error: { code: 'MUSE_TIMEOUT', message: 't', retryable: true, upstream_error_code: null },
    })
    const p = build(undefined, deps).registry.get('muse-video')!
    await assert.rejects(p.run(ctx(), { op: 'video.from_text', prompt: 'x' }), {
      code: 'MUSE_TIMEOUT',
      retryable: true,
    })
  })

  it('uuidV5 matches the RFC 4122 test vector', () => {
    // python: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
    assert.equal(
      uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    )
  })

  it('minimax-speech: reservation bound covers upstream counting; design / clone validate their input', async () => {
    // r1 P1-1: 50 ASCII chars locally, upstream bills 51 → the bound still covers it.
    assert.ok(speechCharBound('a'.repeat(50)) >= 51)
    assert.ok(speechCharBound('清晨，北方的雪松林慢慢醒来。') >= 26)
    const deps = fakeDeps({
      minimax: {
        mediaKey: { key: SENTINEL_KEY, source: 'file' },
        client: { pool: {} as never },
      },
    })
    const p = build(undefined, deps).registry.get('minimax-speech')!
    assert.equal(p.estimateMaxCost({ op: 'voice.tts', text: 'a'.repeat(50) }), 3n)
    await assert.rejects(p.run(ctx(), { op: 'voice.design', text: 'x', voiceId: 'v' }), {
      code: 'INVALID_REQUEST',
    })
    await assert.rejects(p.run(ctx(), { op: 'voice.clone', text: 'x', voiceId: 'v' }), {
      code: 'INVALID_REQUEST',
    })
    await assert.rejects(p.run(ctx(), { op: 'voice.tts', text: 'x' }), { code: 'INVALID_REQUEST' })
  })

  it('minimax-speech lists system voices with its own keyFile key (code r1 P1)', async () => {
    const seen: string[] = []
    let gotKey: string | undefined
    const deps = fakeDeps({
      minimax: {
        mediaKey: { source: 'none' },
        client: { pool: {} as never },
        fetchVoices: async (key) => {
          seen.push(key)
          return [{ voiceId: 'v1', voiceName: 'v1', description: [] }]
        },
        speech: (async (d: { key?: string; voices: { get(): Promise<unknown> } }) => {
          gotKey = d.key
          await d.voices.get()
          return {
            audio: Buffer.from('ID3'),
            format: 'mp3',
            usageCharacters: 2,
            settled: {
              usageId: 1n,
              ledgerId: 1n,
              costCredits: 1n,
              debitedCredits: 1n,
              balanceAfter: 9n,
              clamped: false,
              replayed: false,
            },
          }
        }) as never,
      },
    })
    const { registry } = build(
      JSON.stringify([{ id: 'minimax-speech', adapter: 'minimax-speech', keyFile: SENTINEL_PATH }]),
      deps,
    )
    const p = registry.get('minimax-speech')!
    assert.equal(p.status(USER).state, 'ready')
    const out = await p.run(ctx(), { op: 'voice.tts', text: 'hi', voiceId: 'v1' })
    assert.equal(gotKey, SENTINEL_KEY)
    assert.deepEqual(seen, [SENTINEL_KEY])
    assert.equal(out.costCredits, 1n)
    assert.equal(out.charged, true)
  })

  it('minimax-speech reports the real debit: clamped settle, and a replay reads the ledger (code r1 P1)', async () => {
    const settled = {
      usageId: 7n,
      ledgerId: 1n,
      costCredits: 3n,
      debitedCredits: 1n as bigint | null,
      balanceAfter: 0n,
      clamped: true,
      replayed: false,
    }
    const asked: bigint[] = []
    const deps = fakeDeps({
      minimax: {
        mediaKey: { key: SENTINEL_KEY, source: 'file' },
        client: { pool: {} as never },
        speech: (async () => ({
          audio: Buffer.from('ID3'),
          format: 'mp3',
          usageCharacters: 9,
          settled,
        })) as never,
        debitedFor: async (id) => {
          asked.push(id)
          return 1n
        },
      },
    })
    const p = build(undefined, deps).registry.get('minimax-speech')!
    const first = await p.run(ctx(), { op: 'voice.tts', text: 'x', voiceId: 'v' })
    assert.equal(first.costCredits, 1n)
    assert.equal(first.charged, true)
    Object.assign(settled, { debitedCredits: null, clamped: false, replayed: true })
    const replay = await p.run(ctx(), { op: 'voice.tts', text: 'x', voiceId: 'v' })
    assert.deepEqual(asked, [7n])
    assert.equal(replay.costCredits, 1n, 'the original debit, not the 3-credit list price')
    assert.equal(replay.charged, false)
  })

  it('refuses to run when the reservation is below the bound; flags an overrun', async () => {
    const deps = fakeDeps()
    const p = build(undefined, deps).registry.get('muse-video')!
    await assert.rejects(
      p.run(ctx({ maxCostCredits: 49n }), { op: 'video.from_text', prompt: 'x' }),
      {
        code: 'RESERVATION_TOO_SMALL',
      },
    )
    deps.muse!.prices.video = 10n
    const out = await p.run(ctx({ maxCostCredits: 10n }), { op: 'video.from_text', prompt: 'x' })
    assert.equal(out.costCredits, 50n)
    assert.equal(out.overReservation, true)
  })

  it('unavailable providers refuse to run', async () => {
    const { registry } = build(undefined)
    await assert.rejects(
      registry.get('minimax-speech')!.run(ctx(), { op: 'voice.tts', text: 'x', voiceId: 'v' }),
      { code: 'PROVIDER_UNAVAILABLE' },
    )
  })

  it('an unavailable provider cannot tell what it charged: unknown, never 0 (code r1 P1)', async () => {
    const { registry } = build(undefined)
    await assert.rejects(registry.get('minimax-speech')!.chargedFor(247n, 'studio:t1'), {
      code: 'PROVIDER_UNAVAILABLE',
    })
  })

  it('minimax-speech chargedFor counts a design / clone settlement too (code r1 P1)', async () => {
    let ledgerIds: unknown = null
    const pool = {
      query: async (sql: string, args: unknown[]) => {
        if (sql.includes('credit_ledger')) {
          ledgerIds = args[1]
          return { rows: [{ debited: '991' }] }
        }
        if (sql.includes('ANY')) return { rows: [{ id: '5' }] }
        return { rows: [] }
      },
    }
    const deps = fakeDeps({
      minimax: {
        mediaKey: { key: SENTINEL_KEY, source: 'file' },
        client: { pool: pool as never },
      } as never,
    })
    const p = build(undefined, deps).registry.get('minimax-speech')!
    assert.equal(await p.chargedFor(247n, 'studio:t1'), 991n)
    assert.deepEqual(ledgerIds, ['5'])
  })
})

describe('MiniMax voice design / clone (user decision 2026-10-23 13:03)', () => {
  const settled = {
    usageId: 3n,
    ledgerId: 1n,
    costCredits: 991n,
    debitedCredits: 991n,
    balanceAfter: 0n,
    clamped: false,
    replayed: false,
  }
  function voiceDeps(over: Record<string, unknown> = {}) {
    return fakeDeps({
      minimax: {
        mediaKey: { key: SENTINEL_KEY, source: 'file' },
        client: { pool: {} as never },
        ...over,
      } as never,
    })
  }

  it('design: exec id as request id, preview becomes the output, voice id in meta', async () => {
    const calls: unknown[] = []
    const deps = voiceDeps({
      design: async (_d: unknown, args: unknown) => {
        calls.push(args)
        return { voiceId: 'oc247xdesigned1', trialAudio: Buffer.from('ID3'), settled }
      },
    })
    const p = build(undefined, deps).registry.get('minimax-speech')!
    assert.equal(p.estimateMaxCost({ op: 'voice.design', text: '清晨' }), 991n)
    const out = await p.run(ctx({ maxCostCredits: 991n }), {
      op: 'voice.design',
      prompt: '沉稳男声',
      text: '清晨',
      label: '旁白',
    })
    assert.deepEqual(calls[0], {
      userId: 247n,
      requestId: ctx().execRequestId,
      prompt: '沉稳男声',
      previewText: '清晨',
      label: '旁白',
    })
    assert.equal(out.meta?.voiceId, 'oc247xdesigned1')
    assert.equal(out.outputs[0]?.mime, 'audio/mpeg')
    assert.equal(out.costCredits, 991n)
  })

  it('clone: needs consent and a sample; preview fetched from the demo url', async () => {
    const calls: Array<Record<string, unknown>> = []
    const deps = voiceDeps({
      clone: async (_d: unknown, args: Record<string, unknown>) => {
        calls.push(args)
        return { voiceId: 'oc247xcloned01', demoAudioUrl: 'https://cdn.example/demo.mp3', settled }
      },
      fetchPreview: async () => Buffer.from('ID3demo'),
    })
    const p = build(undefined, deps).registry.get('minimax-speech')!
    const consent = { statement: 'self_or_authorized' as const, acceptedAt: '2026-10-23T05:00:00Z' }
    await assert.rejects(p.run(ctx({ maxCostCredits: 991n }), { op: 'voice.clone', consent }), {
      code: 'INVALID_REQUEST',
    })
    await assert.rejects(
      p.run(ctx({ maxCostCredits: 991n }), {
        op: 'voice.clone',
        inputs: [{ role: 'source', blobSha: 'a'.repeat(64) }],
      }),
      {
        code: 'CLONE_CONSENT_REQUIRED',
      },
    )
    const out = await p.run(ctx({ maxCostCredits: 991n }), {
      op: 'voice.clone',
      label: '我的声音',
      inputs: [{ role: 'source', blobSha: 'a'.repeat(64) }],
      consent,
    })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]!.consent, consent)
    assert.equal(out.meta?.voiceId, 'oc247xcloned01')
    assert.equal(out.outputs[0]?.bytes.toString(), 'ID3demo')
  })

  it('MiniMax plan / account refusals become clear, non-retryable codes', async () => {
    const deps = voiceDeps({
      design: async () => {
        throw new HttpError(
          502,
          'MINIMAX_UPSTREAM_ERROR',
          'your current token plan not support model, voice_design',
        )
      },
      clone: async () => {
        throw new HttpError(502, 'MINIMAX_UPSTREAM_ERROR', 'voice clone user forbidden')
      },
    })
    const p = build(undefined, deps).registry.get('minimax-speech')!
    await assert.rejects(
      p.run(ctx({ maxCostCredits: 991n }), { op: 'voice.design', prompt: 'x', text: 'y' }),
      {
        code: 'MINIMAX_PLAN_NO_VOICE_DESIGN',
        retryable: false,
      },
    )
    await assert.rejects(
      p.run(ctx({ maxCostCredits: 991n }), {
        op: 'voice.clone',
        inputs: [{ role: 'source', blobSha: 'a'.repeat(64) }],
        consent: { statement: 'self_or_authorized', acceptedAt: '2026-10-23T05:00:00Z' },
      }),
      { code: 'MINIMAX_CLONE_NOT_ENABLED', retryable: false },
    )
  })
})
