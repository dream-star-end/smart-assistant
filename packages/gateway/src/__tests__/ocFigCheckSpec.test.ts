/**
 * oc-figcheck --spec 物理一致性门测试(R6 TEST-16 期 B;模板泛化为学科无关原型)。
 *
 * 两层:
 *  1) figSpec.checkSpec 纯函数:悬空/断链/成环、连线端点未声明、目标在覆盖锥外、
 *     同组混量纲、大跨度条长不按 log10 归一、缺单位、缺标签、标签 bbox 相交、
 *     图例 bbox 与标题相交——各必须产出 fail 级 issue;合法 spec 零 fail。
 *  2) CLI E2E(fake codex stub,同 ocControlCliE2e 模式):--spec 合法 PASS / 违规 FAIL /
 *     坏 JSON FAIL / **无 --spec 时输出结构与旧版完全一致(golden 防回归)**。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import { checkSpec, parseFigSpec, specFollowUpQuestions, type FigSpec } from '../figSpec.js'

// ── 纯函数:构造违规 spec,各必须 FAIL ───────────────────────────

function fails(spec: FigSpec, rule: string): number {
  return checkSpec(spec).filter((i) => i.severity === 'fail' && i.rule === rule).length
}

function validCoverageSpec(): FigSpec & { objects: NonNullable<FigSpec['objects']>; labels: NonNullable<FigSpec['labels']> } {
  return {
    template: 'coverage-geometry',
    kind: 'schematic',
    units: 'm',
    scene: { grounding: 'required' },
    objects: [
      { id: 'ground', type: 'ground', anchor: [7, 1] },
      { id: 'mount-1', type: 'mount', anchor: [5, 1.2], supports: 'ground' },
      { id: 'S1', type: 'sensor', anchor: [5, 1.65], supports: 'mount-1', orientation_deg: 90, beam: { boresight_deg: 90, half_angle_deg: 12 } },
      { id: 'T1', type: 'target', anchor: [5, 7] },
    ],
    links: [{ id: 'cov-1', from: 'S1', to: 'T1', kind: 'coverage', must_be_in_beam_of: 'S1' }],
    labels: [
      { id: 'lbl-S1', for: 'S1', text: 'S1 90°', bbox: [[4.0, 1.4], [4.9, 1.8]] },
      { id: 'lbl-T1', for: 'T1', text: 'T1', bbox: [[5.2, 6.9], [5.9, 7.3]] },
    ],
  }
}

describe('figSpec.checkSpec 确定性物理检查', () => {
  test('合法 spec:零 fail', () => {
    assert.equal(checkSpec(validCoverageSpec()).filter((i) => i.severity === 'fail').length, 0)
  })

  test('R1 悬空:实体无 supports → FAIL', () => {
    const spec = validCoverageSpec()
    delete (spec.objects[2] as { supports?: string }).supports // S1 悬空
    assert.ok(fails(spec, 'grounding-chain') >= 1)
  })

  test('R1 支撑链断裂:supports 指向未声明 id → FAIL', () => {
    const spec = validCoverageSpec()
    spec.objects[1].supports = 'ghost-tower'
    assert.ok(fails(spec, 'grounding-chain') >= 1)
  })

  test('R1 支撑链成环 → FAIL', () => {
    const spec = validCoverageSpec()
    spec.objects.push({ id: 'a', type: 'box', supports: 'b' })
    spec.objects.push({ id: 'b', type: 'box', supports: 'a' })
    assert.ok(fails(spec, 'grounding-chain') >= 1)
  })

  test('R1 自由漂浮类型豁免接地', () => {
    const spec = validCoverageSpec()
    spec.objects[3].supports = undefined // T1(target)本来就无 supports,不该报
    assert.equal(checkSpec(spec).filter((i) => i.rule === 'grounding-chain').length, 0)
  })

  test('R1 grounded:false 的自定义类型对象豁免落地检查', () => {
    const spec = validCoverageSpec()
    // 任何学科的自定义 type 都能用对象级 grounded:false 显式豁免,不必猜 type 名
    spec.objects.push({ id: 'M1', type: 'marker', anchor: [9, 8], grounded: false })
    assert.equal(fails(spec, 'grounding-chain'), 0)
  })

  test('R1 未豁免的自定义类型悬空对象 → FAIL', () => {
    const spec = validCoverageSpec()
    spec.objects.push({ id: 'M2', type: 'marker', anchor: [9, 8] }) // 无 supports 也无 grounded:false
    assert.ok(fails(spec, 'grounding-chain') >= 1)
  })

  test('R2 连线端点未声明对象 → FAIL', () => {
    const spec = validCoverageSpec()
    spec.links = [{ id: 'bad', from: 'S1', to: 'NOWHERE', kind: 'coverage' }]
    assert.ok(fails(spec, 'link-endpoints') >= 1)
  })

  test('R2 目标在覆盖锥外 → FAIL', () => {
    const spec = validCoverageSpec()
    spec.objects[3].anchor = [11, 1.5] // 目标移到侧面远处,偏离 90° 轴
    assert.ok(fails(spec, 'link-endpoints') >= 1)
  })

  test('R2 must_be_in_beam_of 引用无 beam 对象 → FAIL', () => {
    const spec = validCoverageSpec()
    spec.links = [{ id: 'cov-1', from: 'S1', to: 'T1', must_be_in_beam_of: 'mount-1' }]
    assert.ok(fails(spec, 'link-endpoints') >= 1)
  })

  test('R3 同组混量纲(mas 与 ms 同组)→ FAIL', () => {
    const spec: FigSpec = { objects: [{ id: 'o', type: 'device' }], labels: [{ for: 'o', text: 'o', bbox: [[0, 0], [1, 1]] }], magnitudes: [
      { id: 'item-a', value: 0.5, unit: 'mas', group: 'mix' },
      { id: 'item-b', value: 0.2, unit: 'ms', group: 'mix' },
    ] }
    assert.ok(fails(spec, 'magnitude-unit') >= 1)
  })

  test('R3 大跨度组条长按线性画(未 log 归一)→ FAIL', () => {
    const spec: FigSpec = { objects: [{ id: 'o', type: 'device' }], labels: [{ for: 'o', text: 'o', bbox: [[0, 0], [1, 1]] }], magnitudes: [
      { id: 'a', value: 1, unit: 'm', group: 'g', rendered_length: 0.1 },
      { id: 'b', value: 1000, unit: 'm', group: 'g', rendered_length: 2.0 }, // log 期望≈4.55,线性实际 2.0,偏差>2×
      { id: 'c', value: 1e6, unit: 'm', group: 'g', rendered_length: 9.0 },
    ] }
    assert.ok(fails(spec, 'magnitude-unit') >= 1)
  })

  test('R3 大跨度组条长按 log10 归一 → 通过', () => {
    const spec: FigSpec = { objects: [{ id: 'o', type: 'device' }], labels: [{ for: 'o', text: 'o', bbox: [[0, 0], [1, 1]] }], magnitudes: [
      { id: 'a', value: 1, unit: 'm', group: 'g', rendered_length: 1.2 },
      { id: 'b', value: 1000, unit: 'm', group: 'g', rendered_length: 4.6 },
      { id: 'c', value: 1e6, unit: 'm', group: 'g', rendered_length: 8.2 },
    ] }
    assert.equal(fails(spec, 'magnitude-unit'), 0)
  })

  test('R3 缺单位 → FAIL', () => {
    const spec: FigSpec = { objects: [{ id: 'o', type: 'device' }], labels: [{ for: 'o', text: 'o', bbox: [[0, 0], [1, 1]] }], magnitudes: [{ id: 'x', value: 3 }] }
    assert.ok(fails(spec, 'magnitude-unit') >= 1)
  })

  test('R3 纯文本标注组(无 rendered_length)不校验条长', () => {
    const spec: FigSpec = { objects: [{ id: 'o', type: 'device' }], labels: [{ for: 'o', text: 'o', bbox: [[0, 0], [1, 1]] }], magnitudes: [
      { id: 'a', value: 30, unit: 'dBm', group: 'power' },
      { id: 'b', value: -25, unit: 'dBm', group: 'power' },
    ] }
    assert.equal(fails(spec, 'magnitude-unit'), 0)
  })

  test('R4 对象缺标签 → FAIL;ground/mount 豁免', () => {
    const spec = validCoverageSpec()
    spec.labels = spec.labels!.filter((l) => l.for !== 'S1')
    assert.ok(fails(spec, 'label-bbox') >= 1)
  })

  test('R4 标签 bbox 相交>20% → FAIL', () => {
    const spec = validCoverageSpec()
    spec.labels = [
      { for: 'S1', text: 'S1', bbox: [[5.0, 1.4], [6.0, 1.8]] },
      { for: 'T1', text: 'T1', bbox: [[5.4, 1.4], [6.4, 1.8]] }, // 60% 重叠
    ]
    assert.ok(fails(spec, 'label-bbox') >= 1)
  })

  test('R4 标签引用未声明对象 → FAIL', () => {
    const spec = validCoverageSpec()
    spec.labels!.push({ for: 'ghost', text: '?', bbox: [[0, 0], [0.5, 0.5]] })
    assert.ok(fails(spec, 'label-bbox') >= 1)
  })

  test('R4b 图例 bbox 与标题相交 → FAIL', () => {
    const spec = validCoverageSpec()
    spec.title = { text: '覆盖几何示意', bbox: [[3.0, 9.0], [7.0, 9.6]] }
    spec.legend = { bbox: [[3.2, 8.9], [5.2, 9.5]] } // 压在标题上;不碰标签(y<=7.3)与对象锚点
    assert.equal(fails(spec, 'legend-overlap'), 1)
  })

  test('R4b 图例锚在空白区(让开标题/标签/对象锚点)→ 零 fail', () => {
    const spec = validCoverageSpec()
    spec.title = { text: '覆盖几何示意', bbox: [[3.0, 12.8], [7.0, 13.4]] }
    spec.legend = { bbox: [[11.0, 10.0], [13.5, 11.2]] } // 右上空白区,与标题/标签/锚点都不相交
    assert.equal(checkSpec(spec).filter((i) => i.severity === 'fail').length, 0)
  })

  test('R5 objects 为空 / id 重复 → FAIL', () => {
    assert.ok(fails({ objects: [] }, 'structure') >= 1)
    const spec = validCoverageSpec()
    spec.objects.push({ ...spec.objects[1] }) // mount-1 重复
    assert.ok(fails(spec, 'structure') >= 1)
  })

  test('parseFigSpec:坏 JSON 与非对象顶层 → error', () => {
    assert.ok(parseFigSpec('{oops').error)
    assert.ok(parseFigSpec('[1,2]').error)
    assert.ok(parseFigSpec('{"objects":[]}').spec)
  })

  test('specFollowUpQuestions:数据驱动——数量核对 + 覆盖锥/落地/连线问句', () => {
    const qs = specFollowUpQuestions(validCoverageSpec())
    assert.ok(qs.some((q) => q.includes('4 个声明对象')))
    assert.ok(qs.some((q) => q.includes('覆盖锥')), '有 beam → 锥覆盖问句')
    assert.ok(qs.some((q) => q.includes('悬空')), 'grounding=required → 落地核对问句')
    assert.ok(qs.some((q) => q.includes('连线两端')), '有 links → 端点/方向问句')
    assert.ok(!qs.some((q) => q.includes('log10')), '无分组量级 → 不出条长问句')
  })

  test('specFollowUpQuestions:无 beam 不出覆盖锥问句;分组量级出条长问句', () => {
    const spec: FigSpec = {
      objects: [{ id: 'stage-1', type: 'stage' }],
      magnitudes: [
        { id: 'a', value: 0.5, unit: 'mV', group: 'mV' },
        { id: 'b', value: 12, unit: 'mV', group: 'mV' },
      ],
    }
    const qs = specFollowUpQuestions(spec)
    assert.ok(qs.some((q) => q.includes('1 个声明对象')))
    assert.ok(!qs.some((q) => q.includes('覆盖锥')), '无 beam → 不出锥覆盖问句')
    assert.ok(!qs.some((q) => q.includes('悬空')), '无 grounding=required → 不出落地问句')
    assert.ok(!qs.some((q) => q.includes('连线两端')), '无 links → 不出端点问句')
    assert.ok(qs.some((q) => q.includes('log10')), '有分组量级 → 条长/单位/面板问句')
  })
})

// ── CLI E2E:golden 无 spec 一致 + --spec 行为 ─────────────────

type RunResult = { code: number | null; stdout: string; stderr: string }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const TSX = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')

function runTs(entry: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [TSX, join(REPO_ROOT, entry), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
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

function crc32(value: Buffer): number {
  let crc = 0xffffffff
  for (const byte of value) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
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

describe('oc-figcheck CLI --spec(真实 CLI + fake codex vision)', () => {
  const work = mkdtempSync(join(tmpdir(), 'oc-figcheck-spec-'))
  const home = join(work, 'home')
  const uploads = join(home, 'uploads')
  const codexHome = join(work, 'codex-home')
  const lockDir = join(work, 'locks')
  mkdirSync(uploads, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(codexHome, 'auth.json'), '{}', { mode: 0o600 })
  const image = join(uploads, 'figure.png')
  writeFileSync(image, publicationPng())

  const fakeCodex = join(work, 'fake-codex')
  writeFileSync(
    fakeCodex,
    `#!${process.execPath}
import fs from 'node:fs'
const args = process.argv.slice(2)
const output = args[args.indexOf('--output-last-message') + 1]
const prompt = args[args.length - 1]
fs.appendFileSync(${JSON.stringify(join(work, 'codex-calls.log'))}, JSON.stringify({ prompt }) + '\\n')
fs.writeFileSync(output, 'PASS: spec e2e stub')
`,
    { mode: 0o755 },
  )

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

  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  function parseReport(stdout: string): Record<string, unknown> {
    const idx = stdout.lastIndexOf('\nVERDICT:')
    assert.ok(idx > 0, `stdout missing VERDICT: ${stdout.slice(0, 200)}`)
    return JSON.parse(stdout.slice(0, idx))
  }

  test('无 --spec:输出结构与旧版完全一致(golden,无 spec 键)', async () => {
    const r = await runTs('packages/gateway/src/ocFigCheckCli.ts', [image, '--kind', 'schematic'], env)
    assert.equal(r.code, 0, r.stderr)
    const report = parseReport(r.stdout)
    // 键集与键序 = 旧版(image,kind,deterministic,vision,verdict,hint),绝无 spec 键
    assert.deepEqual(Object.keys(report), ['image', 'kind', 'deterministic', 'vision', 'verdict', 'hint'])
    assert.deepEqual(Object.keys(report.deterministic as object), ['checks', 'issues'])
    // Pillow pixel stats are optional (CLI skips them when python3-pil is absent,
    // as on GitHub Actions). Width/height/dpi always come from the PNG header.
    const detChecks = Object.keys((report.deterministic as { checks: object }).checks)
    assert.equal(detChecks[0], 'width')
    assert.equal(detChecks[1], 'height')
    assert.equal(detChecks[2], 'dpi')
    if (detChecks.length > 3) {
      assert.deepEqual(detChecks, [
        'width',
        'height',
        'dpi',
        'dominantFrac',
        'dominantColor',
        'edgeInkFrac',
      ])
    } else {
      assert.deepEqual(detChecks, ['width', 'height', 'dpi'])
    }
    assert.equal((report.deterministic as { issues: unknown[] }).issues.length, 0)
    assert.equal(report.verdict, 'PASS')
    assert.match(r.stdout, /\nVERDICT: PASS\n$/)
  })

  test('无 --spec:vision prompt 不含 spec 定向问句(向后兼容)', async () => {
    await runTs('packages/gateway/src/ocFigCheckCli.ts', [image, '--kind', 'figure'], env)
    const calls = readLogFile(join(work, 'codex-calls.log'))
    const last = calls[calls.length - 1]
    assert.ok(!last.prompt.includes('定向核对'), 'prompt 不应包含 spec 派生问句')
    assert.ok(!last.prompt.includes('声明对象'), 'prompt 不应包含 spec 派生问句')
  })

  test('--spec 合法:PASS 且 report 带 spec 段与数据驱动定向问句', async () => {
    const specFile = join(work, 'good.spec.json')
    writeFileSync(specFile, JSON.stringify(validCoverageSpec()))
    const r = await runTs('packages/gateway/src/ocFigCheckCli.ts', [image, '--kind', 'schematic', '--spec', specFile], env)
    assert.equal(r.code, 0, r.stderr)
    const report = parseReport(r.stdout)
    assert.ok('spec' in report)
    const spec = report.spec as { template: string; issues: unknown[]; warnings: unknown[] }
    assert.equal(spec.template, 'coverage-geometry')
    assert.deepEqual(spec.issues, [])
    assert.equal(report.verdict, 'PASS')
    const calls = readLogFile(join(work, 'codex-calls.log'))
    assert.ok(calls[calls.length - 1].prompt.includes('覆盖锥'), 'vision prompt 应含 spec 派生的覆盖锥核对问句')
  })

  test('--spec 悬空对象:verdict FAIL 且 issue 定位到规则', async () => {
    const spec = validCoverageSpec()
    delete (spec.objects[2] as { supports?: string }).supports
    const specFile = join(work, 'dangling.spec.json')
    writeFileSync(specFile, JSON.stringify(spec))
    const r = await runTs('packages/gateway/src/ocFigCheckCli.ts', [image, '--kind', 'schematic', '--spec', specFile], env)
    assert.equal(r.code, 0, r.stderr)
    const report = parseReport(r.stdout)
    assert.equal(report.verdict, 'FAIL')
    const issues = (report.deterministic as { issues: string[] }).issues
    assert.ok(issues.some((m) => m.includes('[spec:grounding-chain]') && m.includes("'S1'")), JSON.stringify(issues))
  })

  test('--spec 目标在覆盖锥外:FAIL', async () => {
    const spec = validCoverageSpec()
    spec.objects[3].anchor = [11, 1.5]
    const specFile = join(work, 'offbeam.spec.json')
    writeFileSync(specFile, JSON.stringify(spec))
    const r = await runTs('packages/gateway/src/ocFigCheckCli.ts', [image, '--kind', 'schematic', '--spec', specFile], env)
    const report = parseReport(r.stdout)
    assert.equal(report.verdict, 'FAIL')
    assert.ok((report.deterministic as { issues: string[] }).issues.some((m) => m.includes('[spec:link-endpoints]')))
  })

  test('--spec 坏 JSON:FAIL 并指明解析错误', async () => {
    const specFile = join(work, 'broken.spec.json')
    writeFileSync(specFile, '{not json')
    const r = await runTs('packages/gateway/src/ocFigCheckCli.ts', [image, '--spec', specFile], env)
    const report = parseReport(r.stdout)
    assert.equal(report.verdict, 'FAIL')
    assert.ok((report.deterministic as { issues: string[] }).issues.some((m) => m.includes('[spec:spec-parse]')))
  })

  test('--spec 文件不存在:FAIL 而非崩溃', async () => {
    const r = await runTs('packages/gateway/src/ocFigCheckCli.ts', [image, '--spec', join(work, 'nope.json')], env)
    const report = parseReport(r.stdout)
    assert.equal(report.verdict, 'FAIL')
  })
})

function readLogFile(path: string): Array<{ prompt: string }> {
  try {
    const text = readFileSync(path, 'utf8')
    return text
      .split('\n')
      .filter((l: string) => l.trim())
      .map((l: string) => JSON.parse(l))
  } catch {
    return []
  }
}
