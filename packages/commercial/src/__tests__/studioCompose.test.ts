import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, type Writable } from 'node:stream'
import { after, describe, test } from 'node:test'

import { escapeAssText, toAss, toSrt } from '../media-studio/compose/ass.js'
import {
  COMPOSE_LABEL,
  ComposeRunner,
  ComposeRunnerError,
  type DockerLike,
  inProcessHostLock,
  isOwnerDead,
  processOwnerToken,
} from '../media-studio/compose/runner.js'
import {
  type ComposeSpec,
  ComposeSpecError,
  buildCommand,
  peaksFromPcm,
  validateMusicEdit,
} from '../media-studio/compose/spec.js'

const TEST_LOCK = inProcessHostLock()

const base = (over: Partial<ComposeSpec> = {}): ComposeSpec => ({
  width: 1280,
  height: 720,
  fps: 24,
  clips: [
    { file: 's1.mp4', inSec: 0, outSec: 5 },
    { file: 's2.mp4', inSec: 1, outSec: 6 },
  ],
  ...over,
})

const MUSIC_BASE = {
  width: 1280 as const,
  height: 720 as const,
  fps: 24 as const,
  clips: [
    { file: 'a.mp4', inSec: 0, outSec: 10 },
    { file: 'b.mp4', inSec: 0, outSec: 10 },
  ],
  voice: [{ file: 'v.mp3', startSec: 1 }],
}

describe('compose music edit (OCV5-591 M1)', () => {
  const graphOf = (music: Record<string, unknown>) => {
    const cmd = buildCommand({
      op: 'compose',
      spec: { ...MUSIC_BASE, music: { file: 'm.mp3', ...music } } as never,
    })
    return cmd.argv[cmd.argv.indexOf('-filter_complex') + 1]!
  }

  const graphOfSpan = (spec: Record<string, unknown>, music: Record<string, unknown>) => {
    const cmd = buildCommand({
      op: 'compose',
      spec: { ...spec, music: { file: 'm.mp3', ...music } } as never,
    })
    return cmd.argv[cmd.argv.indexOf('-filter_complex') + 1]!
  }

  test('without placement the graph is the A0 one', () => {
    const g = graphOf({ gainDb: -6 })
    assert.match(g, /volume=-6dB,afade=t=in:st=0:d=1,afade=t=out:st=17\.5:d=2\.5\[mus\]/)
    assert.match(g, /attack=20:release=400/)
  })

  test('trims, loops with crossfades, places and fades the span; duck timing is applied', () => {
    const g = graphOf({
      inSec: 8,
      outSec: 14,
      startSec: 2,
      endSec: 18,
      loop: { crossfadeSec: 1 },
      duck: { attackMs: 50, releaseMs: 800 },
    })
    assert.match(g, /atrim=start=8:end=14,asetpts=PTS-STARTPTS/)
    // 16 s span from a 6 s part with 1 s crossfades → 3 copies, 2 crossfades
    assert.match(g, /asplit=3\[mrep0\]\[mrep1\]\[mrep2\]/)
    assert.equal((g.match(/acrossfade=d=1:c1=tri:c2=tri/g) ?? []).length, 2)
    assert.match(
      g,
      /atrim=end=16,afade=t=in:st=0:d=1,afade=t=out:st=13\.5:d=2\.5,adelay=2000\|2000,apad\[mus\]/,
    )
    assert.match(g, /attack=50:release=800/)
  })

  test('a loop without crossfade concatenates; a short span is never looped', () => {
    assert.match(graphOf({ outSec: 5, loop: {} }), /concat=n=4:v=0:a=1\[mloop\]/)
    assert.doesNotMatch(graphOf({ outSec: 30, loop: {} }), /\[mrep0\]/)
  })

  test('a loop that would need too many repeats is refused, never cut short with silence (code r1 P1)', () => {
    assert.throws(
      () => validateMusicEdit({ inSec: 0, outSec: 1, startSec: 0, endSec: 60, loop: {} }),
      /more than 24 repeats/,
    )
    // Span only known from the film: refused when the command is built.
    const long = { ...MUSIC_BASE, clips: [{ file: 'a.mp4', inSec: 0, outSec: 60 }] }
    assert.throws(
      () =>
        buildCommand({
          op: 'compose',
          spec: { ...long, music: { file: 'm.mp3', outSec: 1, loop: {} } } as never,
        }),
      /more than 24 repeats/,
    )
    assert.match(graphOfSpan(long, { outSec: 3, loop: {} }), /asplit=20/)
  })

  test('refuses edits that cannot be cut', () => {
    for (const [why, edit, re] of [
      ['loop needs the part to repeat', { loop: {} }, /needs outSec/],
      ['crossfade under half the part', { outSec: 3, loop: { crossfadeSec: 2 } }, /under half/],
      ['at least 1 s of music', { startSec: 5, endSec: 5.5 }, /at least 1 s/],
      ['unknown field', { tempo: 2 }, /not supported/],
      ['duck attack range', { duck: { attackMs: 0 } }, /attackMs/],
    ] as const) {
      assert.throws(() => validateMusicEdit(edit), re, why)
    }
    assert.deepEqual(validateMusicEdit({ inSec: 1, outSec: 9, loop: { crossfadeSec: 0.5 } }), {
      inSec: 1,
      outSec: 9,
      loop: { crossfadeSec: 0.5 },
    })
  })
})

describe('compose spec → argv (OCV5-588)', () => {
  test('probe and frames use fixed argv shapes under /work', () => {
    assert.deepEqual(buildCommand({ op: 'probe', file: 'a.mp4' }).argv.slice(-1), [
      '/work/in/a.mp4',
    ])
    const f = buildCommand({ op: 'frames', file: 'a.mp4', times: [0, 9.95] })
    assert.deepEqual(f.outputs, ['frame-0.png', 'frame-1.png'])
    assert.ok(f.argv.includes('9.95'))
    assert.ok(f.argv.every((a) => !a.includes('..')))
  })

  test('file names that could escape or inject are rejected', () => {
    for (const bad of [
      '../x.mp4',
      'a;b.mp4',
      'a,b.mp4',
      'a:b.mp4',
      'a b.mp4',
      '.hidden',
      'x/y.mp4',
      'a[1].mp4',
      '',
    ]) {
      assert.throws(() => buildCommand({ op: 'probe', file: bad }), ComposeSpecError, bad)
      assert.throws(
        () =>
          buildCommand({
            op: 'compose',
            spec: base({ clips: [{ file: bad, inSec: 0, outSec: 2 }] }),
          }),
        ComposeSpecError,
        bad,
      )
    }
  })

  test('numeric ranges are enforced', () => {
    const bad: Partial<ComposeSpec>[] = [
      { clips: [] },
      { clips: Array.from({ length: 41 }, () => ({ file: 's.mp4', inSec: 0, outSec: 1 })) },
      { clips: [{ file: 's.mp4', inSec: 3, outSec: 3.2 }] },
      { clips: [{ file: 's.mp4', inSec: -1, outSec: 2 }] },
      { clips: [{ file: 's.mp4', inSec: 0, outSec: Number.NaN }] },
      { width: 1080 as never },
      { fps: 60 as never },
      { music: { file: 'm.mp3', gainDb: 20 } },
      { voice: [{ file: 'v.mp3', startSec: 0, gainDb: -99 }] },
      { transitions: { kind: 'fade', durSec: 5 } },
      { grade: 'neon' as never },
    ]
    for (const over of bad)
      assert.throws(
        () => buildCommand({ op: 'compose', spec: base(over) }),
        ComposeSpecError,
        JSON.stringify(over),
      )
  })

  test('compose builds one filter graph with concat, grade, burned subtitles, ducked music and loudnorm', () => {
    const cmd = buildCommand({
      op: 'compose',
      spec: base({
        grade: 'warm',
        subtitles: { file: 'subs.ass', burn: true },
        voice: [
          { file: 'v1.mp3', startSec: 0.6 },
          { file: 'v2.mp3', startSec: 6 },
        ],
        music: { file: 'm.mp3', gainDb: -8, duckDb: 12 },
      }),
    })
    const graph = cmd.argv[cmd.argv.indexOf('-filter_complex') + 1]!
    assert.match(graph, /concat=n=2:v=1:a=0\[vcat\]/)
    assert.match(graph, /subtitles=filename=\/work\/in\/subs\.ass:fontsdir=\/usr\/share\/fonts/)
    assert.match(graph, /adelay=600\|600/)
    assert.match(graph, /sidechaincompress=/)
    assert.match(graph, /loudnorm=I=-16/)
    assert.ok(cmd.argv.includes('/work/out/final.mp4'))
    assert.equal(cmd.argv[cmd.argv.lastIndexOf('-t') + 1], '10')
    assert.deepEqual(cmd.outputs, ['final.mp4'])
    assert.equal(cmd.argv[0], 'ffmpeg')
  })

  test('fade transitions shorten the timeline by the overlaps', () => {
    const cmd = buildCommand({
      op: 'compose',
      spec: base({ transitions: { kind: 'fade', durSec: 0.5 } }),
    })
    const graph = cmd.argv[cmd.argv.indexOf('-filter_complex') + 1]!
    assert.match(graph, /xfade=transition=fade:duration=0\.5:offset=4\.5\[vcat\]/)
    assert.equal(cmd.argv[cmd.argv.lastIndexOf('-t') + 1], '9.5')
  })

  test('peaks are normalised maxima per bucket', () => {
    const pcm = Buffer.alloc(8)
    pcm.writeInt16LE(16384, 0)
    pcm.writeInt16LE(-32768, 6)
    assert.deepEqual(peaksFromPcm(pcm, 2), [0.5, 1])
    assert.deepEqual(peaksFromPcm(Buffer.alloc(0), 3), [0, 0, 0])
  })
})

describe('subtitles (OCV5-588)', () => {
  test('ASS escaping neutralises override tags, escapes and control characters', () => {
    assert.equal(escapeAssText('{\\pos(0,0)}hi'), '\\{\\\\pos(0,0)\\}hi')
    assert.equal(escapeAssText('a\nb\r\nc'), 'a\\Nb\\Nc')
    assert.equal(escapeAssText('x\u0000\u0007y'), 'xy')
    assert.equal(escapeAssText('雪 🦊'), '雪 🦊')
  })

  test('toAss writes the house style and one dialogue per cue; toSrt mirrors the timing', () => {
    const cues = [{ startSec: 0.6, endSec: 4.4, text: '清晨，北方的雪松林慢慢醒来。' }]
    const ass = toAss(cues, 1280, 720)
    assert.match(ass, /PlayResX: 1280/)
    assert.match(ass, /Style: Default,Noto Sans CJK SC,32,/)
    assert.match(ass, /Dialogue: 0,0:00:00\.60,0:00:04\.40,Default,,0,0,0,,清晨/)
    assert.equal(toSrt(cues), '1\n00:00:00,600 --> 00:00:04,400\n清晨，北方的雪松林慢慢醒来。\n')
    assert.throws(() => toAss([{ startSec: 3, endSec: 2, text: 'x' }], 1280, 720))
  })
})

type Created = { opts: Record<string, unknown>; removed: boolean; killed: boolean }

function fakeDocker(behaviour: {
  status?: number
  stdout?: string
  hang?: boolean
  write?: (outDir: string) => Promise<void>
  outDir?: string
  killRejects?: boolean
  waitNever?: boolean
  removeRejects?: boolean
  killHangs?: boolean
  removeHangs?: boolean
  stdoutDelayMs?: number
}) {
  const created: Created[] = []
  const docker = {
    created,
    modem: {
      demuxStream(stream: NodeJS.ReadableStream, out: Writable, _err: Writable) {
        stream.on('data', (c: Buffer) => out.write(c))
      },
    },
    async createContainer(opts: Record<string, unknown>) {
      const rec: Created = { opts, removed: false, killed: false }
      created.push(rec)
      const stream = new PassThrough()
      let release: (v: { StatusCode: number }) => void = () => {}
      const waited = new Promise<{ StatusCode: number }>((r) => {
        release = r
      })
      return {
        async attach() {
          return stream
        },
        async start() {
          if (behaviour.write && behaviour.outDir) await behaviour.write(behaviour.outDir)
          if (!behaviour.hang && !behaviour.waitNever)
            release({ StatusCode: behaviour.status ?? 0 })
          const emit = () => {
            if (behaviour.stdout) stream.write(behaviour.stdout)
            stream.end()
          }
          if (behaviour.stdoutDelayMs) setTimeout(emit, behaviour.stdoutDelayMs)
          else emit()
        },
        async wait() {
          return waited
        },
        async kill() {
          rec.killed = true
          if (behaviour.killHangs) await new Promise(() => {})
          if (behaviour.killRejects) throw new Error('docker kill failed')
          if (!behaviour.waitNever) release({ StatusCode: 137 })
        },
        async remove() {
          if (behaviour.removeHangs) await new Promise(() => {})
          if (behaviour.removeRejects)
            throw Object.assign(new Error('docker unavailable'), { statusCode: 500 })
          rec.removed = true
        },
      }
    },
    removedIds: [] as string[],
    async listContainers(opts?: { filters?: { label?: string[] } }) {
      const all = [
        {
          Id: 'running-live-other',
          State: 'running',
          Labels: { 'com.openclaude.studio.owner': 'live-other' },
        },
        {
          Id: 'running-dead-owner',
          State: 'running',
          Labels: { 'com.openclaude.studio.owner': 'dead' },
        },
        { Id: 'exited', State: 'exited', Labels: { 'com.openclaude.studio.owner': 'live-other' } },
        {
          Id: 'created-live',
          State: 'created',
          Labels: { 'com.openclaude.studio.owner': 'live-other' },
        },
        { Id: 'running-mine', State: 'running', Labels: { 'com.openclaude.studio.owner': 'me' } },
      ]
      const removed = (docker as unknown as { removedIds: string[] }).removedIds
      const ownerFilter = opts?.filters?.label?.find((l) =>
        l.startsWith('com.openclaude.studio.owner='),
      )
      return all.filter(
        (c) =>
          !removed.includes(c.Id) &&
          (!ownerFilter ||
            `com.openclaude.studio.owner=${c.Labels['com.openclaude.studio.owner']}` ===
              ownerFilter),
      )
    },
    getContainer(id: string) {
      return {
        remove: async () => {
          ;(docker as unknown as { removedIds: string[] }).removedIds.push(id)
        },
      }
    },
  }
  return docker as unknown as DockerLike & { created: Created[] }
}

describe('ComposeRunner (OCV5-588)', () => {
  const roots: string[] = []
  after(async () => {
    for (const r of roots) await rm(r, { recursive: true, force: true })
  })
  const IMAGE = `sha256:${'a'.repeat(64)}`
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'oc-compose-'))
    roots.push(root)
    return root
  }

  test('unconfigured image refuses to run', async () => {
    const root = await setup()
    const r = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: undefined,
      root,
      chownOutput: false,
    })
    await assert.rejects(
      r.run('job-00000001', { op: 'probe', file: 'a.mp4' }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_NOT_CONFIGURED',
    )
  })

  test('container is isolated (no network, ro rootfs, caps dropped, limits, ro input) and always removed', async () => {
    const root = await setup()
    const r = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    const { inDir, outDir } = await r.prepare('job-00000002')
    await writeFile(join(inDir, 'a.mp4'), 'x')
    const d2 = fakeDocker({
      status: 0,
      outDir,
      write: async (o) => writeFile(join(o, 'frame-0.png'), PNG),
    })
    const r2 = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: d2,
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    const res = await r2.run('job-00000002', { op: 'frames', file: 'a.mp4', times: [1] })
    assert.equal(res.outputs[0]!.name, 'frame-0.png')
    const c = d2.created[0]!
    const host = c.opts.HostConfig as Record<string, unknown>
    assert.equal(host.NetworkMode, 'none')
    assert.equal(c.opts.NetworkDisabled, true)
    assert.equal(host.ReadonlyRootfs, true)
    assert.deepEqual(host.CapDrop, ['ALL'])
    assert.deepEqual(host.SecurityOpt, ['no-new-privileges'])
    assert.equal(c.opts.User, '1000:1000')
    assert.equal(host.PidsLimit, 256)
    const mounts = host.Mounts as Array<{ Target: string; ReadOnly: boolean; Source: string }>
    assert.deepEqual(
      mounts.map((m) => [m.Target, m.ReadOnly]),
      [
        ['/work/in', true],
        ['/work/out', false],
      ],
    )
    assert.equal(mounts[0]!.Source, inDir)
    assert.deepEqual((c.opts.Labels as Record<string, string>)[COMPOSE_LABEL], '1')
    assert.deepEqual(c.opts.Entrypoint, [])
    assert.equal((c.opts.Cmd as string[])[0], 'ffmpeg')
    assert.equal(c.removed, true)
  })

  test('non-zero exit and missing outputs fail; the container is still removed', async () => {
    const root = await setup()
    const r0 = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    const { inDir } = await r0.prepare('job-00000003')
    await writeFile(join(inDir, 'a.mp4'), 'x')
    const failing = fakeDocker({ status: 1 })
    await assert.rejects(
      new ComposeRunner({
        hostLock: TEST_LOCK,
        docker: failing,
        imageId: IMAGE,
        root,
        chownOutput: false,
      }).run('job-00000003', { op: 'frames', file: 'a.mp4', times: [1] }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_FAILED',
    )
    assert.equal(failing.created[0]!.removed, true)
    const silent = fakeDocker({ status: 0 })
    await assert.rejects(
      new ComposeRunner({
        hostLock: TEST_LOCK,
        docker: silent,
        imageId: IMAGE,
        root,
        chownOutput: false,
      }).run('job-00000003', { op: 'frames', file: 'a.mp4', times: [1] }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_OUTPUT',
    )
  })

  test('an output that fails the magic check is rejected', async () => {
    const root = await setup()
    const r0 = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    const { inDir, outDir } = await r0.prepare('job-00000004')
    await writeFile(join(inDir, 'a.mp4'), 'x')
    const d = fakeDocker({
      status: 0,
      outDir,
      write: async (o) => writeFile(join(o, 'frame-0.png'), 'not a png at all'),
    })
    await assert.rejects(
      new ComposeRunner({
        hostLock: TEST_LOCK,
        docker: d,
        imageId: IMAGE,
        root,
        chownOutput: false,
      }).run('job-00000004', { op: 'frames', file: 'a.mp4', times: [1] }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_OUTPUT',
    )
  })

  test('symlinked or oddly named inputs are refused before any container starts', async () => {
    const root = await setup()
    const r0 = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    const { inDir } = await r0.prepare('job-00000005')
    await symlink('/etc/passwd', join(inDir, 'a.mp4'))
    const d = fakeDocker({ status: 0 })
    await assert.rejects(
      new ComposeRunner({
        hostLock: TEST_LOCK,
        docker: d,
        imageId: IMAGE,
        root,
        chownOutput: false,
      }).run('job-00000005', { op: 'probe', file: 'a.mp4' }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_INVALID',
    )
    assert.equal(d.created.length, 0)
    await mkdir(join(inDir, 'dir'))
    await assert.rejects(r0.run('job-00000005', { op: 'probe', file: 'a.mp4' }), ComposeRunnerError)
    assert.throws(() => r0.jobDir('../escape'), ComposeRunnerError)
  })

  test('probe returns parsed JSON; a hung step times out, is killed and removed; stale containers are swept', async () => {
    const root = await setup()
    const r0 = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    const { inDir } = await r0.prepare('job-00000006')
    await writeFile(join(inDir, 'a.mp4'), 'x')
    const probe = fakeDocker({ status: 0, stdout: '{"format":{"duration":"10.0"}}' })
    const res = await new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: probe,
      imageId: IMAGE,
      root,
      chownOutput: false,
    }).run('job-00000006', { op: 'probe', file: 'a.mp4' })
    assert.deepEqual(res.stdoutJson, { format: { duration: '10.0' } })
    const hung = fakeDocker({ hang: true })
    await assert.rejects(
      new ComposeRunner({
        hostLock: TEST_LOCK,
        docker: hung,
        imageId: IMAGE,
        root,
        chownOutput: false,
        timeoutMsOverride: 30,
      }).run('job-00000006', { op: 'probe', file: 'a.mp4' }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_TIMEOUT',
    )
    assert.equal(hung.created[0]!.killed, true)
    assert.equal(hung.created[0]!.removed, true)
    const sweeper = fakeDocker({})
    const swept = await new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: sweeper,
      imageId: IMAGE,
      root,
      chownOutput: false,
      owner: 'me',
      ownerDead: (o) => o === 'dead',
    }).sweepStale()
    assert.equal(swept, 2)
    assert.deepEqual(
      (sweeper as unknown as { removedIds: string[] }).removedIds,
      ['running-dead-owner', 'exited'],
      'only stopped containers and containers whose owner is proven dead are removed; live work of the other master is kept',
    )
  })

  test('not enough free disk refuses before any container starts; frames carry a runtime -fs cap', async () => {
    const root = await setup()
    const r0 = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    const { inDir } = await r0.prepare('job-00000009')
    await writeFile(join(inDir, 'a.mp4'), 'x')
    const d = fakeDocker({ status: 0 })
    await assert.rejects(
      new ComposeRunner({
        hostLock: TEST_LOCK,
        docker: d,
        imageId: IMAGE,
        root,
        chownOutput: false,
        freeBytes: async () => 100 * 1024 * 1024,
      }).run('job-00000009', { op: 'frames', file: 'a.mp4', times: [1] }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_DISK',
    )
    assert.equal(d.created.length, 0)
    const argv = buildCommand({ op: 'frames', file: 'a.mp4', times: [1, 2] }).argv
    assert.equal(argv.filter((a) => a === '-fs').length, 2)
    const wave = buildCommand({ op: 'waveform_pcm', file: 'a.mp3' }).argv
    assert.equal(wave[wave.indexOf('-t') + 1], '600')
    const final = buildCommand({ op: 'compose', spec: base() }).argv
    assert.equal(final[final.indexOf('-fs') + 1], String(512 * 1024 * 1024))
  })

  test("disk reservations of live in-flight jobs count against free space; dead owners' reservations do not", async () => {
    const root = await setup()
    const r0 = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    const { inDir } = await r0.prepare('job-00000010')
    await writeFile(join(inDir, 'a.mp4'), 'x')
    await mkdir(join(root, 'reservations'), { recursive: true })
    const GiB = 1024 * 1024 * 1024
    await writeFile(
      join(root, 'reservations', 'other-live.json'),
      JSON.stringify({ bytes: 0.5 * GiB, owner: 'live' }),
    )
    await writeFile(
      join(root, 'reservations', 'other-dead.json'),
      JSON.stringify({ bytes: 5 * GiB, owner: 'dead' }),
    )
    const mk = (free: number, docker = fakeDocker({ status: 0 })) =>
      new ComposeRunner({
        hostLock: TEST_LOCK,
        docker,
        imageId: IMAGE,
        root,
        chownOutput: false,
        owner: 'me',
        ownerDead: (o) => o === 'dead',
        freeBytes: async () => free,
      })
    // free 1.5 GiB − live 0.5 GiB < 1 GiB headroom + 20 MiB → refused
    await assert.rejects(
      mk(1.5 * GiB).run('job-00000010', { op: 'frames', file: 'a.mp4', times: [1] }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_DISK',
    )
    // the dead owner's 5 GiB reservation is ignored and cleaned up; with 2 GiB free the step is admitted
    const d = fakeDocker({ status: 0 })
    await assert.rejects(
      mk(2 * GiB, d).run('job-00000010', { op: 'frames', file: 'a.mp4', times: [1] }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_OUTPUT',
    )
    assert.equal(
      d.created.length,
      1,
      'admitted (fails later only because the fake writes no output)',
    )
    await new Promise((r) => setTimeout(r, 50))
    const left = (await readdir(join(root, 'reservations'))).sort()
    assert.deepEqual(
      left,
      ['other-live.json'],
      "own reservation released after the job; dead owner's reservation removed",
    )
  })

  test('isOwnerDead only proves death for same-host owners whose pid is gone or reused', () => {
    const host = hostname()
    assert.equal(
      isOwnerDead(`${host}:4242:777`, () => null),
      true,
    )
    assert.equal(
      isOwnerDead(`${host}:4242:777`, () => '888'),
      true,
    )
    assert.equal(
      isOwnerDead(`${host}:4242:777`, () => '777'),
      false,
    )
    assert.equal(
      isOwnerDead('other-host:4242:777', () => null),
      false,
    )
    assert.equal(
      isOwnerDead('garbage', () => null),
      false,
    )
    assert.equal(isOwnerDead(undefined), false)
    assert.equal(isOwnerDead(processOwnerToken()), false, 'this process is alive')
  })

  test('code r1 fixes: input perms, timeout ends a stuck wait, late stdout, reservation kept when removal fails', async () => {
    const root = await setup()
    const r0 = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    const { inDir } = await r0.prepare('job-00000011')
    const { stat, chmod: chmodP } = await import('node:fs/promises')
    assert.equal((await stat(inDir)).mode & 0o777, 0o755, 'in/ is traversable by the sandbox user')
    await writeFile(join(inDir, 'a.mp4'), 'x')
    await chmodP(join(inDir, 'a.mp4'), 0o600)
    // late stdout after wait() resolved is still parsed (P1-8)
    const late = fakeDocker({ status: 0, stdout: '{"format":{}}', stdoutDelayMs: 30 })
    const res = await new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: late,
      imageId: IMAGE,
      root,
      chownOutput: false,
    }).run('job-00000011', { op: 'probe', file: 'a.mp4' })
    assert.deepEqual(res.stdoutJson, { format: {} })
    assert.equal(
      (await stat(join(inDir, 'a.mp4'))).mode & 0o044,
      0o044,
      'inputs are made readable for uid 1000 (P1-1)',
    )
    // wait() never settles and kill() rejects: the timeout still ends run() (P1-6)
    const stuck = fakeDocker({ waitNever: true, killRejects: true })
    await assert.rejects(
      new ComposeRunner({
        hostLock: TEST_LOCK,
        docker: stuck,
        imageId: IMAGE,
        root,
        chownOutput: false,
        timeoutMsOverride: 20,
        killGraceMs: 20,
      }).run('job-00000011', { op: 'probe', file: 'a.mp4' }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_TIMEOUT',
    )
    // removal keeps failing: the disk reservation stays counted (P1-7)
    const sticky = fakeDocker({ status: 0, removeRejects: true })
    await assert.rejects(
      new ComposeRunner({
        hostLock: TEST_LOCK,
        docker: sticky,
        imageId: IMAGE,
        root,
        chownOutput: false,
        owner: 'me',
        removeRetryMs: 1,
      }).run('job-00000011', { op: 'frames', file: 'a.mp4', times: [1] }),
      ComposeRunnerError,
    )
    await new Promise((r) => setTimeout(r, 100))
    const left = await readdir(join(root, 'reservations'))
    assert.equal(
      left.filter((n) => n.startsWith('job-00000011')).length,
      1,
      'reservation kept while the container may still exist',
    )
  })

  test('code r2: a hanging kill() cannot block run(); a stuck container keeps holding its slot', async () => {
    const root = await setup()
    const r0 = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    const { inDir } = await r0.prepare('job-00000013')
    await writeFile(join(inDir, 'a.mp4'), 'x')
    const wedged = fakeDocker({ waitNever: true, killHangs: true, removeHangs: true })
    const r = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: wedged,
      imageId: IMAGE,
      root,
      chownOutput: false,
      timeoutMsOverride: 20,
      killGraceMs: 20,
      maxConcurrent: 1,
      queueWaitMs: 50,
      removeRetryMs: 5,
    })
    const started = Date.now()
    await assert.rejects(
      r.run('job-00000013', { op: 'probe', file: 'a.mp4' }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_TIMEOUT',
    )
    assert.ok(Date.now() - started < 2000, 'run() returns even though kill() never settles')
    await assert.rejects(
      r.run('job-00000013', { op: 'probe', file: 'a.mp4' }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_BUSY',
    )
    assert.equal(
      wedged.created.length,
      1,
      'no second container starts while the first is not confirmed removed',
    )
  })

  test('a dead owner whose containers cannot be listed keeps its reservation counted (P1-4)', async () => {
    const root = await setup()
    const r0 = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    const { inDir } = await r0.prepare('job-00000012')
    await writeFile(join(inDir, 'a.mp4'), 'x')
    await mkdir(join(root, 'reservations'), { recursive: true })
    const GiB = 1024 * 1024 * 1024
    await writeFile(
      join(root, 'reservations', 'dead.json'),
      JSON.stringify({ bytes: 0.5 * GiB, owner: 'dead' }),
    )
    const broken = fakeDocker({ status: 0 })
    ;(broken as unknown as { listContainers: () => Promise<never> }).listContainers = async () => {
      throw new Error('docker down')
    }
    await assert.rejects(
      new ComposeRunner({
        hostLock: TEST_LOCK,
        docker: broken,
        imageId: IMAGE,
        root,
        chownOutput: false,
        owner: 'me',
        ownerDead: (o) => o === 'dead',
        freeBytes: async () => 1.5 * GiB,
      }).run('job-00000012', { op: 'frames', file: 'a.mp4', times: [1] }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_DISK',
    )
    assert.ok((await readdir(join(root, 'reservations'))).includes('dead.json'))
  })

  test('frames and filmstrip bound pixels so PNG outputs stay under the per-file cap (P1-5)', () => {
    const f = buildCommand({ op: 'frames', file: 'a.mp4', times: [0, 1] })
    assert.equal(
      f.argv.filter((a) => a === 'scale=w=1920:h=1920:force_original_aspect_ratio=decrease').length,
      2,
    )
    assert.equal(f.perFileCapBytes, 20 * 1024 * 1024)
    const strip = buildCommand({
      op: 'filmstrip',
      file: 'a.mp4',
      durationSec: 10,
      count: 24,
      height: 360,
    })
    assert.match(
      strip.argv[strip.argv.indexOf('-vf') + 1]!,
      /scale=w=640:h=360:force_original_aspect_ratio=decrease,tile=24x1/,
    )
  })

  test('concurrency is capped and excess jobs fail with COMPOSE_BUSY after the queue wait', async () => {
    const root = await setup()
    const r0 = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: fakeDocker({}),
      imageId: IMAGE,
      root,
      chownOutput: false,
    })
    for (const id of ['job-00000007', 'job-00000008']) {
      const { inDir } = await r0.prepare(id)
      await writeFile(join(inDir, 'a.mp4'), 'x')
    }
    const hang = fakeDocker({ hang: true })
    const r = new ComposeRunner({
      hostLock: TEST_LOCK,
      docker: hang,
      imageId: IMAGE,
      root,
      chownOutput: false,
      maxConcurrent: 1,
      queueWaitMs: 50,
      timeoutMsOverride: 300,
    })
    const first = r.run('job-00000007', { op: 'probe', file: 'a.mp4' }).catch((e) => e)
    await new Promise((res) => setTimeout(res, 10))
    await assert.rejects(
      r.run('job-00000008', { op: 'probe', file: 'a.mp4' }),
      (e: unknown) => e instanceof ComposeRunnerError && e.code === 'COMPOSE_BUSY',
    )
    assert.equal(hang.created.length, 1, 'the queued job never started a container')
    assert.equal(((await first) as ComposeRunnerError).code, 'COMPOSE_TIMEOUT')
  })
})
