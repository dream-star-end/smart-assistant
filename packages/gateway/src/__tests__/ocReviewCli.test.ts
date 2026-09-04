/**
 * oc-review 确定性汇总单测(R7 期 A):
 *   - location 锚点归一(章节/图/表/行号;无锚点回退 raw);
 *   - 评审 JSON 严格校验 fail-loud(坏 JSON/缺字段/坏枚举,报文件名+字段路径);
 *   - 聚合三分区:共识(≥2 位同锚点同档)/分歧(同锚点档冲突,多数侧只标注)/单发(仅一位),
 *     逐条保留来源模型,severity 排序,宁可漏聚不误聚;
 *   - CLI:collate 落盘 md+json、stdout 末行 COLLATE、--out 覆盖、空目录/坏文件退出码、
 *     help/schema/未知命令、同一输入字节级确定性。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  ReviewFormatError,
  collateReviews,
  locationAnchors,
  parseReviewFile,
  renderSummaryMd,
  runOcReviewCli,
  type ReviewFile,
} from '../ocReviewCli.js'

function review(model: string, verdict: ReviewFile['verdict'], findings: ReviewFile['findings'], role?: string): ReviewFile {
  const file: ReviewFile = { reviewer: { model }, verdict, findings }
  if (role !== undefined) file.reviewer.role = role
  return file
}

describe('locationAnchors', () => {
  it('章节表述归一到同一锚点', () => {
    assert.deepEqual(locationAnchors('§3.2'), ['sec:3.2'])
    assert.deepEqual(locationAnchors('section 3.2'), ['sec:3.2'])
    assert.deepEqual(locationAnchors('Sec. 3.2'), ['sec:3.2'])
    assert.deepEqual(locationAnchors('章节3'), ['sec:3'])
  })

  it('图/表/行号归一,行号区间折叠连字符', () => {
    assert.deepEqual(locationAnchors('图4'), ['fig:4'])
    assert.deepEqual(locationAnchors('Figure 4'), ['fig:4'])
    assert.deepEqual(locationAnchors('fig.4'), ['fig:4'])
    assert.deepEqual(locationAnchors('表2'), ['tab:2'])
    assert.deepEqual(locationAnchors('Table 2'), ['tab:2'])
    assert.deepEqual(locationAnchors('L120'), ['line:120'])
    assert.deepEqual(locationAnchors('line 120'), ['line:120'])
    assert.deepEqual(locationAnchors('行 120'), ['line:120'])
    assert.deepEqual(locationAnchors('L120 - 130'), ['line:120-130'])
    assert.deepEqual(locationAnchors('L120–130'), ['line:120-130'])
  })

  it('多锚点全部提取;无锚点回退 raw(小写)', () => {
    assert.deepEqual(locationAnchors('§3.2 / 图4'), ['sec:3.2', 'fig:4'])
    assert.deepEqual(locationAnchors('Abstract'), ['raw:abstract'])
    assert.deepEqual(locationAnchors(''), [])
  })

  it('词中字母不误判为行号(左边界)', () => {
    assert.deepEqual(locationAnchors('model 3'), ['raw:model 3'])
    assert.deepEqual(locationAnchors('config 4'), ['raw:config 4'])
    // 中文词尾的"行"不算行号(运行3次 → 整串回退 raw,不误聚)
    assert.deepEqual(locationAnchors('运行3次'), ['raw:运行3次'])
  })
})

describe('parseReviewFile fail-loud', () => {
  const minimal = JSON.stringify({
    reviewer: { model: 'kimi-k3', role: '方法学审查' },
    verdict: 'major',
    findings: [{ location: '§3.2', severity: 'major', issue: '样本量未说明' }],
  })

  it('合法最小文件通过并保留字段', () => {
    const f = parseReviewFile(minimal, 'reviews-kimi.json')
    assert.equal(f.reviewer.model, 'kimi-k3')
    assert.equal(f.reviewer.role, '方法学审查')
    assert.equal(f.verdict, 'major')
    assert.equal(f.findings.length, 1)
    assert.equal(f.findings[0].suggestion, undefined)
  })

  it('坏 JSON 报文件名', () => {
    assert.throws(() => parseReviewFile('{oops', 'reviews-bad.json'), ReviewFormatError)
    assert.throws(
      () => parseReviewFile('{oops', 'reviews-bad.json'),
      /reviews-bad\.json: invalid JSON/,
    )
  })

  it('缺 reviewer.model / 坏 verdict / findings 非数组', () => {
    assert.throws(
      () => parseReviewFile(JSON.stringify({ reviewer: {}, verdict: 'major', findings: [] }), 'a.json'),
      /reviewer\.model/,
    )
    assert.throws(
      () => parseReviewFile(JSON.stringify({ reviewer: { model: 'm' }, verdict: 'maybe', findings: [] }), 'a.json'),
      /verdict must be one of/,
    )
    assert.throws(
      () => parseReviewFile(JSON.stringify({ reviewer: { model: 'm' }, verdict: 'accept' }), 'a.json'),
      /findings must be an array/,
    )
  })

  it('finding 字段路径精确报错', () => {
    const bad = JSON.stringify({
      reviewer: { model: 'm' },
      verdict: 'accept',
      findings: [{ location: '§1', severity: 'fatal', issue: 'x' }],
    })
    assert.throws(() => parseReviewFile(bad, 'reviews-x.json'), /findings\[0\]\.severity/)
    const emptyIssue = JSON.stringify({
      reviewer: { model: 'm' },
      verdict: 'accept',
      findings: [{ location: '§1', severity: 'major', issue: '' }],
    })
    assert.throws(() => parseReviewFile(emptyIssue, 'reviews-x.json'), /findings\[0\]\.issue/)
  })
})

describe('collateReviews 三分区', () => {
  const kimi = review(
    'kimi-k3',
    'major',
    [
      { location: '§3.2', severity: 'major', issue: '样本量未说明' },
      { location: '图4', severity: 'blocker', issue: '坐标轴无单位' },
    ],
    '方法学审查',
  )
  const glm = review('glm-5.3', 'minor', [
    { location: 'section 3.2', severity: 'major', issue: '统计方法交代不清', suggestion: '补 ANOVA 假设' },
    { location: 'L120', severity: 'minor', issue: '术语不一致' },
  ])
  const ds = review('deepseek-v4', 'accept', [
    { location: 'figure 4', severity: 'minor', issue: '图注过简' },
    { location: 'Abstract', severity: 'suggestion', issue: '可加一句贡献声明' },
  ])

  it('共识/分歧/单发分组正确,来源模型逐条保留', () => {
    const r = collateReviews([ds, kimi, glm])
    // 共识:§3.2 两家同 major
    assert.equal(r.consensus.length, 1)
    assert.equal(r.consensus[0].anchor, 'sec:3.2')
    assert.equal(r.consensus[0].severity, 'major')
    assert.deepEqual(r.consensus[0].sources, ['glm-5.3', 'kimi-k3'])
    assert.ok(r.consensus[0].findings.every((f) => typeof f.reviewer === 'string'))
    // 分歧:图4 kimi=blocker vs ds=minor;1v1 并列取更严重档为多数侧
    assert.equal(r.divergent.length, 1)
    assert.equal(r.divergent[0].anchor, 'fig:4')
    assert.deepEqual(r.divergent[0].sides.map((s) => s.severity), ['blocker', 'minor'])
    assert.equal(r.divergent[0].majority, 'blocker')
    // 单发:L120(glm, minor)在前、raw:abstract(ds, suggestion)在后
    assert.deepEqual(r.sole.map((s) => s.anchor), ['line:120', 'raw:abstract'])
    assert.equal(r.sole.find((s) => s.anchor === 'line:120')?.source, 'glm-5.3')
  })

  it('多数侧按来源数判定(2v1),并列取更严重档', () => {
    const a = review('a', 'accept', [{ location: '图4', severity: 'major', issue: 'x' }])
    const b = review('b', 'accept', [{ location: '图4', severity: 'major', issue: 'y' }])
    const c = review('c', 'accept', [{ location: '图4', severity: 'minor', issue: 'z' }])
    const r = collateReviews([a, b, c])
    assert.equal(r.divergent.length, 1)
    assert.equal(r.divergent[0].majority, 'major')
    const majorSide = r.divergent[0].sides.find((s) => s.severity === 'major')
    assert.deepEqual(majorSide?.sources, ['a', 'b'])
  })

  it('单发区按严重度排序;宁可漏聚不误聚', () => {
    const a = review('a', 'accept', [
      { location: '§3.2', severity: 'suggestion', issue: 's' },
      { location: '图9', severity: 'blocker', issue: 'b' },
      { location: 'L5', severity: 'minor', issue: 'm' },
      { location: '引言第三段', severity: 'major', issue: 'g' },
    ])
    const b = review('b', 'accept', [{ location: '图8', severity: 'major', issue: 'other' }])
    const r = collateReviews([a, b])
    assert.deepEqual(r.sole.map((s) => s.anchor), ['fig:9', 'fig:8', 'raw:引言第三段', 'line:5', 'sec:3.2'])
    // §3.2 只有 a 提 → 不与 b 的图8 合并(不同问题不误聚)
    assert.equal(r.consensus.length, 0)
    assert.equal(r.divergent.length, 0)
  })

  it('多锚点 finding 同时进入两个桶(共享锚点即聚合)', () => {
    const a = review('a', 'accept', [{ location: '§3.2', severity: 'major', issue: 'x' }])
    const b = review('b', 'accept', [{ location: '§3.2 / 图4', severity: 'major', issue: 'y' }])
    const r = collateReviews([a, b])
    assert.equal(r.consensus.length, 1)
    assert.equal(r.consensus[0].anchor, 'sec:3.2')
    assert.equal(r.sole.length, 1)
    assert.equal(r.sole[0].anchor, 'fig:4')
    assert.equal(r.sole[0].source, 'b')
  })

  it('totals / verdictCounts / reviewers 汇总正确', () => {
    const r = collateReviews([kimi, glm, ds])
    assert.deepEqual(r.totals, { blocker: 1, major: 2, minor: 2, suggestion: 1 })
    assert.deepEqual(r.verdictCounts, { accept: 1, minor: 1, major: 1, reject: 0 })
    assert.deepEqual(r.reviewers.map((x) => x.model), ['deepseek-v4', 'glm-5.3', 'kimi-k3'])
    assert.equal(r.reviewers.find((x) => x.model === 'kimi-k3')?.role, '方法学审查')
  })

  it('空输入:全空分区,不抛', () => {
    const r = collateReviews([])
    assert.deepEqual(r.totals, { blocker: 0, major: 0, minor: 0, suggestion: 0 })
    assert.equal(r.consensus.length + r.divergent.length + r.sole.length, 0)
  })
})

describe('runOcReviewCli collate 端到端(临时目录)', () => {
  function writeReviews(files: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'oc-review-test-'))
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
    }
    return dir
  }

  const kimiBody = {
    reviewer: { model: 'kimi-k3', role: '方法学审查' },
    verdict: 'major',
    findings: [
      { location: '§3.2', severity: 'major', issue: '样本量未说明', suggestion: '补样本量' },
      { location: '图4', severity: 'blocker', issue: '坐标轴无单位' },
    ],
  }
  const glmBody = {
    reviewer: { model: 'glm-5.3' },
    verdict: 'minor',
    findings: [{ location: 'section 3.2', severity: 'major', issue: '统计方法交代不清' }],
  }

  it('写 md+json,stdout 末行 COLLATE,正文标注来源模型', () => {
    const dir = writeReviews({ 'reviews-kimi.json': kimiBody, 'reviews-glm.json': glmBody })
    try {
      const r = runOcReviewCli(['collate', '--dir', dir])
      assert.equal(r.exitCode, 0, r.stderr)
      const lines = r.stdout.trimEnd().split('\n')
      assert.equal(lines[lines.length - 1], 'COLLATE: 1/2/0/0')
      assert.match(r.stdout, /"mdPath"/)
      const md = readFileSync(join(dir, 'review-summary.md'), 'utf8')
      assert.match(md, /## 共识/)
      assert.match(md, /### \[major\] sec:3\.2 — 来源: glm-5\.3, kimi-k3/)
      assert.match(md, /\*\*kimi-k3\*\* §3\.2: 样本量未说明/)
      assert.match(md, /- 建议: 补样本量/)
      assert.match(md, /### \[blocker\] fig:4 — 来源: kimi-k3/)
      assert.match(md, /exit-relevant: blocker 1 条/)
      const json = JSON.parse(readFileSync(join(dir, 'review-summary.json'), 'utf8'))
      assert.equal(json.reviewers.length, 2)
      assert.equal(json.consensus[0].anchor, 'sec:3.2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--out 覆盖 md 路径,json 跟随同前缀', () => {
    const dir = writeReviews({ 'reviews-kimi.json': kimiBody })
    try {
      const out = join(dir, 'sub-summary.md')
      const r = runOcReviewCli(['collate', '--dir', dir, '--out', out])
      assert.equal(r.exitCode, 0, r.stderr)
      const json = JSON.parse(r.stdout.split('\nCOLLATE:')[0])
      assert.equal(json.mdPath, out)
      assert.equal(json.jsonPath, join(dir, 'sub-summary.json'))
      readFileSync(out, 'utf8')
      readFileSync(join(dir, 'sub-summary.json'), 'utf8')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('同一输入字节级确定性', () => {
    const dirA = writeReviews({ 'reviews-kimi.json': kimiBody, 'reviews-glm.json': glmBody })
    const dirB = writeReviews({ 'reviews-kimi.json': kimiBody, 'reviews-glm.json': glmBody })
    try {
      const a = runOcReviewCli(['collate', '--dir', dirA])
      const b = runOcReviewCli(['collate', '--dir', dirB])
      assert.equal(
        readFileSync(join(dirA, 'review-summary.md'), 'utf8'),
        readFileSync(join(dirB, 'review-summary.md'), 'utf8'),
      )
      // md 内嵌路径为 0,汇总卡是字节级确定产物;COLLATE 行也一致(stdout 里的 mdPath 随目录不同)
      assert.equal(
        a.stdout.slice(a.stdout.lastIndexOf('COLLATE:')),
        b.stdout.slice(b.stdout.lastIndexOf('COLLATE:')),
      )
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it('空目录 / 目录不存在 → exit 1 fail-loud', () => {
    const empty = writeReviews({ 'notes.txt': 'x' })
    try {
      const r = runOcReviewCli(['collate', '--dir', empty])
      assert.equal(r.exitCode, 1)
      assert.match(r.stderr, /no reviews-\*\.json/)
      const missing = runOcReviewCli(['collate', '--dir', '/nonexistent-oc-review-dir'])
      assert.equal(missing.exitCode, 1)
      assert.match(missing.stderr, /cannot read dir/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('坏 JSON / 坏枚举文件 → exit 1 且 stderr 带文件名与字段路径', () => {
    const dir = writeReviews({ 'reviews-a.json': '{oops', 'reviews-b.json': kimiBody })
    try {
      const r = runOcReviewCli(['collate', '--dir', dir])
      assert.equal(r.exitCode, 1)
      assert.match(r.stderr, /reviews-a\.json: invalid JSON/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const badSev = {
      reviewer: { model: 'm' },
      verdict: 'accept',
      findings: [{ location: '§1', severity: 'fatal', issue: 'x' }],
    }
    const dir2 = writeReviews({ 'reviews-c.json': badSev })
    try {
      const r = runOcReviewCli(['collate', '--dir', dir2])
      assert.equal(r.exitCode, 1)
      assert.match(r.stderr, /reviews-c\.json: findings\[0\]\.severity/)
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('缺 --dir → usage 错误(exit 2)', () => {
    const r = runOcReviewCli(['collate'])
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /collate --dir/)
  })
})

describe('runOcReviewCli 入口分发', () => {
  it('help 三种形态打印 usage', () => {
    for (const arg of ['help', '--help', '-h']) {
      const r = runOcReviewCli([arg])
      assert.equal(r.exitCode, 0)
      assert.match(r.stdout, /usage: oc-review/)
      assert.equal(r.stderr, '')
    }
  })

  it('schema 输出可解析的评审员契约', () => {
    const r = runOcReviewCli(['schema'])
    assert.equal(r.exitCode, 0)
    const schema = JSON.parse(r.stdout)
    assert.equal(schema.title, 'ReviewFile')
    assert.deepEqual(schema.required, ['reviewer', 'verdict', 'findings'])
    assert.deepEqual(schema.properties.verdict.enum, ['accept', 'minor', 'major', 'reject'])
    assert.deepEqual(
      schema.properties.findings.items.properties.severity.enum,
      ['blocker', 'major', 'minor', 'suggestion'],
    )
    // 与校验器同源:parseReviewFile 必须接受 schema 描述的最小合法文件
    const minimal = {
      reviewer: { model: 'x' },
      verdict: 'accept',
      findings: [{ location: '§1', severity: 'suggestion', issue: 'ok' }],
    }
    assert.equal(parseReviewFile(JSON.stringify(minimal), 'm').findings.length, 1)
  })

  it('未知命令 → exit 2', () => {
    const r = runOcReviewCli(['merge', '--dir', '/tmp'])
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /unknown command 'merge'/)
  })
})
