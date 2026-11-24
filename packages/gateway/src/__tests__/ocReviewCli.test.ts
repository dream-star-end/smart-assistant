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
  normalizeLedgerAnchor,
  parseDecisionLedger,
  parseReviewFile,
  renderSummaryMd,
  resolveCallerPath,
  resolveFindingPriority,
  runOcReviewCli,
  upsertLedgerEntry,
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

  const badSev = {
    reviewer: { model: 'm' },
    verdict: 'accept',
    findings: [{ location: '§1', severity: 'fatal', issue: 'x' }],
  }

  it('默认宽松:坏文件跳过并标注缺席,其余评审员照常汇总(exit 0,COLLATE 带 skipped=)', () => {
    const dir = writeReviews({
      'reviews-a.json': '{oops',
      'reviews-kimi.json': kimiBody,
      'reviews-glm.json': glmBody,
    })
    try {
      const r = runOcReviewCli(['collate', '--dir', dir])
      assert.equal(r.exitCode, 0, r.stderr)
      const lines = r.stdout.trimEnd().split('\n')
      assert.equal(lines[lines.length - 1], 'COLLATE: 1/2/0/0 skipped=1')
      const json = JSON.parse(readFileSync(join(dir, 'review-summary.json'), 'utf8'))
      assert.equal(json.reviewers.length, 2)
      assert.deepEqual(json.skipped, [{ file: 'reviews-a.json', reason: 'invalid JSON' }])
      const md = readFileSync(join(dir, 'review-summary.md'), 'utf8')
      assert.match(md, /缺席 1 位评审员/)
      assert.match(md, /`reviews-a\.json`: invalid JSON/)
      // 缺席块必须在共识区之前(读者先知道汇总不完整)
      assert.ok(md.indexOf('缺席 1 位评审员') < md.indexOf('## 共识'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('全部文件无效 → exit 1 并逐个列出原因', () => {
    const dir = writeReviews({ 'reviews-a.json': '{oops', 'reviews-c.json': badSev })
    try {
      const r = runOcReviewCli(['collate', '--dir', dir])
      assert.equal(r.exitCode, 1)
      assert.match(r.stderr, /no valid reviews-\*\.json/)
      assert.match(r.stderr, /reviews-a\.json: invalid JSON/)
      assert.match(r.stderr, /reviews-c\.json: findings\[0\]\.severity/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('--strict:任一坏文件 → exit 1 且 stderr 带文件名与字段路径,不写汇总卡', () => {
    const dir = writeReviews({ 'reviews-a.json': '{oops', 'reviews-b.json': kimiBody })
    try {
      const r = runOcReviewCli(['collate', '--dir', dir, '--strict'])
      assert.equal(r.exitCode, 1)
      assert.match(r.stderr, /reviews-a\.json: invalid JSON/)
      assert.throws(() => readFileSync(join(dir, 'review-summary.md')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const dir2 = writeReviews({ 'reviews-c.json': badSev, 'reviews-d.json': kimiBody })
    try {
      const r = runOcReviewCli(['collate', '--dir', dir2, '--strict'])
      assert.equal(r.exitCode, 1)
      assert.match(r.stderr, /reviews-c\.json: findings\[0\]\.severity/)
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('无缺席时 COLLATE 行与 JSON.skipped 形态不变(向后兼容)', () => {
    const dir = writeReviews({ 'reviews-kimi.json': kimiBody })
    try {
      const r = runOcReviewCli(['collate', '--dir', dir])
      assert.equal(r.exitCode, 0, r.stderr)
      assert.match(r.stdout, /\nCOLLATE: 1\/1\/0\/0\n$/)
      const json = JSON.parse(readFileSync(join(dir, 'review-summary.json'), 'utf8'))
      assert.deepEqual(json.skipped, [])
      const md = readFileSync(join(dir, 'review-summary.md'), 'utf8')
      assert.doesNotMatch(md, /缺席/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
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

describe('P0/P1/P2 分级推导与可选字段校验 (OCV5-878)', () => {
  it('resolveFindingPriority 按显式 priority → severity+category 确定性推导', () => {
    // 显式 priority 优先
    assert.equal(resolveFindingPriority({ severity: 'minor', priority: 'P0' }), 'P0')
    assert.equal(resolveFindingPriority({ severity: 'blocker', priority: 'P2' }), 'P2')
    // blocker 推导 P0
    assert.equal(resolveFindingPriority({ severity: 'blocker' }), 'P0')
    // major + 硬伤类别推导 P0
    for (const category of ['math_physics', 'code_data_mismatch', 'citation', 'consistency'] as const) {
      assert.equal(resolveFindingPriority({ severity: 'major', category }), 'P0')
    }
    // 其余 major 推导 P1
    assert.equal(resolveFindingPriority({ severity: 'major' }), 'P1')
    assert.equal(resolveFindingPriority({ severity: 'major', category: 'structure' }), 'P1')
    assert.equal(resolveFindingPriority({ severity: 'major', category: 'style' }), 'P1')
    assert.equal(resolveFindingPriority({ severity: 'major', category: 'other' }), 'P1')
    // minor / suggestion 推导 P2
    assert.equal(resolveFindingPriority({ severity: 'minor' }), 'P2')
    assert.equal(resolveFindingPriority({ severity: 'suggestion', category: 'math_physics' }), 'P2')
  })

  it('parseReviewFile 接受新可选字段并严格校验坏枚举/坏类型', () => {
    const rich = JSON.stringify({
      reviewer: { model: 'claude-opus', role: '公式推导审校' },
      verdict: 'major',
      findings: [
        {
          location: '§2.3',
          severity: 'major',
          priority: 'P0',
          category: 'math_physics',
          topic: '电离层延迟符号',
          issue: '式(4)群延迟与相延迟符号写反',
          evidence: 'Klobuchar 模型及正文 L88 推导',
          new_evidence: true,
        },
      ],
    })
    const parsed = parseReviewFile(rich, 'reviews-rich.json')
    assert.equal(parsed.findings[0].priority, 'P0')
    assert.equal(parsed.findings[0].category, 'math_physics')
    assert.equal(parsed.findings[0].topic, '电离层延迟符号')
    assert.equal(parsed.findings[0].evidence, 'Klobuchar 模型及正文 L88 推导')
    assert.equal(parsed.findings[0].new_evidence, true)

    assert.throws(
      () =>
        parseReviewFile(
          JSON.stringify({
            reviewer: { model: 'm' },
            verdict: 'major',
            findings: [{ location: '§1', severity: 'major', priority: 'P9', issue: 'x' }],
          }),
          'bad.json',
        ),
      /findings\[0\]\.priority/,
    )
    assert.throws(
      () =>
        parseReviewFile(
          JSON.stringify({
            reviewer: { model: 'm' },
            verdict: 'major',
            findings: [{ location: '§1', severity: 'major', category: 'unknown_cat', issue: 'x' }],
          }),
          'bad.json',
        ),
      /findings\[0\]\.category/,
    )
    assert.throws(
      () =>
        parseReviewFile(
          JSON.stringify({
            reviewer: { model: 'm' },
            verdict: 'major',
            findings: [{ location: '§1', severity: 'major', new_evidence: 'yes', issue: 'x' }],
          }),
          'bad.json',
        ),
      /findings\[0\]\.new_evidence/,
    )
  })

  it('schema 包含新可选字段且保持既有 required/enum 兼容', () => {
    const r = runOcReviewCli(['schema'])
    assert.equal(r.exitCode, 0)
    const schema = JSON.parse(r.stdout)
    const props = schema.properties.findings.items.properties
    assert.deepEqual(props.priority.enum, ['P0', 'P1', 'P2'])
    assert.ok(props.category.enum.includes('math_physics'))
    assert.equal(props.new_evidence.type, 'boolean')
    assert.equal(props.topic.type, 'string')
    assert.equal(props.evidence.type, 'string')
  })
})

describe('decision-ledger 子命令与幂等确定性 (OCV5-878)', () => {
  it('normalizeLedgerAnchor 统一自然语言位置与已归一锚点', () => {
    assert.equal(normalizeLedgerAnchor('§3.2'), 'sec:3.2')
    assert.equal(normalizeLedgerAnchor('section 3.2'), 'sec:3.2')
    assert.equal(normalizeLedgerAnchor('sec:3.2'), 'sec:3.2')
    assert.equal(normalizeLedgerAnchor('图 4'), 'fig:4')
    assert.equal(normalizeLedgerAnchor('fig:4'), 'fig:4')
    assert.equal(normalizeLedgerAnchor('Abstract'), 'raw:abstract')
  })

  it('ledger 无参数 → exit 2 并提示 <init|record|show>', () => {
    const r = runOcReviewCli(['ledger'])
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /ledger <init\|record\|show>/)
  })

  it('ledger init / record / show 幂等 upsert、保护既有账本、--force 重置与字节级确定性', () => {
    const dirA = mkdtempSync(join(tmpdir(), 'oc-ledger-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'oc-ledger-b-'))
    try {
      const ledgerA = join(dirA, 'decision-ledger.json')
      const ledgerB = join(dirB, 'decision-ledger.json')

      // init 创建空账本
      const init1 = runOcReviewCli(['ledger', 'init', '--file', ledgerA])
      assert.equal(init1.exitCode, 0, init1.stderr)
      assert.equal(JSON.parse(init1.stdout).action, 'created')
      assert.deepEqual(parseDecisionLedger(readFileSync(ledgerA, 'utf8'), ledgerA), {
        schemaVersion: 1,
        entries: [],
      })

      // record 新增两条
      const rec1 = runOcReviewCli([
        'ledger',
        'record',
        '--file',
        ledgerA,
        '--anchor',
        '§3.2',
        '--topic',
        '样本量',
        '--decision',
        'rejected_with_evidence',
        '--reason',
        '表 1 已给出 N=120 完整样本量',
        '--evidence',
        'Table 1 row 2',
        '--round',
        '1',
      ])
      assert.equal(rec1.exitCode, 0, rec1.stderr)
      assert.equal(JSON.parse(rec1.stdout).action, 'created')

      // 同 anchor 不同写法(section 3.2) + 同 topic → 幂等更新而非重复追加
      const recUpd = runOcReviewCli([
        'ledger',
        'record',
        '--file',
        ledgerA,
        '--anchor',
        'section 3.2',
        '--topic',
        '样本量',
        '--decision',
        'rejected_with_evidence',
        '--reason',
        '表 1 与附录 A 均已给出 N=120 完整样本量',
        '--evidence',
        'Table 1 & Appendix A',
        '--round',
        '2',
      ])
      assert.equal(recUpd.exitCode, 0, recUpd.stderr)
      const recUpdOut = JSON.parse(recUpd.stdout)
      assert.equal(recUpdOut.action, 'updated')
      assert.equal(recUpdOut.totalEntries, 1)
      assert.equal(recUpdOut.entry.id, 'sec:3.2::样本量')
      assert.equal(recUpdOut.entry.round, 2)

      // 再次 init 不带 --force 不破坏已有记录
      const initKeep = runOcReviewCli(['ledger', 'init', '--file', ledgerA])
      assert.equal(initKeep.exitCode, 0, initKeep.stderr)
      assert.equal(JSON.parse(initKeep.stdout).action, 'exists')
      assert.equal(JSON.parse(initKeep.stdout).ledger.entries.length, 1)

      // show 输出摘要与完整账本
      const shown = runOcReviewCli(['ledger', 'show', '--file', ledgerA])
      assert.equal(shown.exitCode, 0, shown.stderr)
      const shownJson = JSON.parse(shown.stdout)
      assert.deepEqual(shownJson.summary, {
        total: 1,
        accepted: 0,
        rejected_with_evidence: 1,
        deferred: 0,
      })
      assert.equal(shownJson.ledger.entries[0].id, 'sec:3.2::样本量')

      // 字节级确定性:另一目录执行相同 record 序列,账本文件内容逐字节一致
      const recB = runOcReviewCli([
        'ledger',
        'record',
        '--file',
        ledgerB,
        '--anchor',
        'sec:3.2',
        '--topic',
        '样本量',
        '--decision',
        'rejected_with_evidence',
        '--reason',
        '表 1 与附录 A 均已给出 N=120 完整样本量',
        '--evidence',
        'Table 1 & Appendix A',
        '--round',
        '2',
      ])
      assert.equal(recB.exitCode, 0, recB.stderr)
      assert.equal(readFileSync(ledgerA, 'utf8'), readFileSync(ledgerB, 'utf8'))

      // --force 重置为空账本
      const initForce = runOcReviewCli(['ledger', 'init', '--file', ledgerA, '--force'])
      assert.equal(initForce.exitCode, 0, initForce.stderr)
      assert.equal(JSON.parse(initForce.stdout).action, 'reset')
      assert.equal(parseDecisionLedger(readFileSync(ledgerA, 'utf8'), ledgerA).entries.length, 0)
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})

describe('collate + decision-ledger 折叠 Flip-Flop 与 P0 收敛闸门 (OCV5-878)', () => {
  it('命中账本 rejected_with_evidence/accepted 时折叠重复挑刺,P0=0 触发 PASS_READY;new_evidence:true 合法重开触发 FIX_REQUIRED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-review-gate-'))
    try {
      const ledgerPath = join(dir, 'decision-ledger.json')
      // 记录两条已裁决条目 + 一条 deferred(不应折叠)
      assert.equal(
        runOcReviewCli([
          'ledger',
          'record',
          '--file',
          ledgerPath,
          '--anchor',
          '§3.2',
          '--topic',
          '样本量',
          '--decision',
          'rejected_with_evidence',
          '--reason',
          '正文表 1 已完整报告样本量 N=120',
          '--evidence',
          'Table 1',
          '--round',
          '1',
        ]).exitCode,
        0,
      )
      assert.equal(
        runOcReviewCli([
          'ledger',
          'record',
          '--file',
          ledgerPath,
          '--anchor',
          '图4',
          '--topic',
          '*',
          '--decision',
          'accepted',
          '--reason',
          '已在 v2 补齐坐标轴单位 m/s',
          '--round',
          '1',
        ]).exitCode,
        0,
      )
      assert.equal(
        runOcReviewCli([
          'ledger',
          'record',
          '--file',
          ledgerPath,
          '--anchor',
          '§5',
          '--topic',
          '消融',
          '--decision',
          'deferred',
          '--reason',
          '留待相机就绪版补充',
          '--round',
          '1',
        ]).exitCode,
        0,
      )

      // 场景 1: 两位评审员仍重复提出已裁决的 P0,且仅有一条非 P0 的 P1/P2 → 全部 P0 被账本折叠,gate=PASS_READY
      writeFileSync(
        join(dir, 'reviews-r2-a.json'),
        JSON.stringify({
          reviewer: { model: 'kimi-k3' },
          verdict: 'major',
          findings: [
            {
              location: 'section 3.2',
              severity: 'major',
              category: 'consistency',
              topic: '样本量',
              issue: '样本量未说明清楚',
            },
            {
              location: '§5',
              severity: 'major',
              category: 'structure',
              issue: '消融实验建议展开讨论',
            },
          ],
        }),
      )
      writeFileSync(
        join(dir, 'reviews-r2-b.json'),
        JSON.stringify({
          reviewer: { model: 'glm-5.3' },
          verdict: 'minor',
          findings: [
            {
              location: 'Figure 4',
              severity: 'blocker',
              issue: '图4 坐标轴单位缺失',
            },
            {
              location: 'L40',
              severity: 'minor',
              issue: '措辞可更精炼',
            },
          ],
        }),
      )

      const passRun = runOcReviewCli(['collate', '--dir', dir, '--ledger', ledgerPath, '--round', '2'])
      assert.equal(passRun.exitCode, 0, passRun.stderr)
      // 末行 COLLATE 形态保持 100% 向后兼容
      const passLines = passRun.stdout.trimEnd().split('\n')
      assert.equal(passLines[passLines.length - 1], 'COLLATE: 1/2/1/0')

      const passJson = JSON.parse(readFileSync(join(dir, 'review-summary.json'), 'utf8'))
      assert.deepEqual(passJson.priorityTotals, { P0: 2, P1: 1, P2: 1 })
      assert.deepEqual(passJson.activePriorityTotals, { P0: 0, P1: 1, P2: 1 })
      assert.equal(passJson.suppressedFlipFlops.length, 2)
      assert.equal(passJson.gate.status, 'PASS_READY')
      assert.equal(passJson.gate.activeP0, 0)
      assert.equal(passJson.gate.suppressedFlipFlops, 2)
      assert.equal(passJson.gate.round, 2)
      assert.match(passJson.gate.message, /P0 硬伤已归零/)
      // deferred 条目 (§5 消融) 未被折叠,保留在 sole 中
      assert.ok(passJson.sole.some((s: any) => s.anchor === 'sec:5'))

      const passMd = readFileSync(join(dir, 'review-summary.md'), 'utf8')
      assert.match(passMd, /收敛闸门: `PASS_READY`/)
      assert.match(passMd, /## 已按裁决账本折叠的重复\/翻案意见/)
      assert.match(passMd, /rejected_with_evidence/)
      assert.ok(passMd.indexOf('收敛闸门') < passMd.indexOf('## 共识'))

      // 场景 2: 评审员给出 new_evidence: true 合法重开同一锚点 P0 → 保留并标注 [reopened_with_new_evidence],gate=FIX_REQUIRED
      writeFileSync(
        join(dir, 'reviews-r2-a.json'),
        JSON.stringify({
          reviewer: { model: 'kimi-k3' },
          verdict: 'reject',
          findings: [
            {
              location: 'section 3.2',
              severity: 'major',
              category: 'code_data_mismatch',
              topic: '样本量',
              issue: '正文称样本量 N=120,但附带脚本 csv 仅 112 行',
              evidence: 'wc -l data/samples.csv => 113 (含表头)',
              new_evidence: true,
            },
          ],
        }),
      )

      const reopenRun = runOcReviewCli(['collate', '--dir', dir, '--ledger', ledgerPath, '--round', '2'])
      assert.equal(reopenRun.exitCode, 0, reopenRun.stderr)
      const reopenJson = JSON.parse(readFileSync(join(dir, 'review-summary.json'), 'utf8'))
      assert.equal(reopenJson.gate.status, 'FIX_REQUIRED')
      assert.equal(reopenJson.gate.activeP0, 1)
      assert.equal(reopenJson.gate.suppressedFlipFlops, 1)
      assert.deepEqual(reopenJson.activePriorityTotals, { P0: 1, P1: 0, P2: 1 })
      const reopenedEntry = reopenJson.sole.find((s: any) => s.anchor === 'sec:3.2')
      assert.ok(reopenedEntry)
      assert.equal(reopenedEntry.findings[0].reopenedWithNewEvidence, true)
      assert.equal(reopenedEntry.findings[0].matchedLedgerId, 'sec:3.2::样本量')

      const reopenMd = readFileSync(join(dir, 'review-summary.md'), 'utf8')
      assert.match(reopenMd, /收敛闸门: `FIX_REQUIRED`/)
      assert.match(reopenMd, /\[reopened_with_new_evidence\]/)

      // 确定性验证: 再次运行产出字节级一致的 md 与 json
      const outA = join(dir, 'det-a.md')
      const outB = join(dir, 'det-b.md')
      assert.equal(runOcReviewCli(['collate', '--dir', dir, '--ledger', ledgerPath, '--round', '2', '--out', outA]).exitCode, 0)
      assert.equal(runOcReviewCli(['collate', '--dir', dir, '--ledger', ledgerPath, '--round', '2', '--out', outB]).exitCode, 0)
      assert.equal(readFileSync(outA, 'utf8'), readFileSync(outB, 'utf8'))
      assert.equal(
        readFileSync(join(dir, 'det-a.json'), 'utf8'),
        readFileSync(join(dir, 'det-b.json'), 'utf8'),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无账本时: 仅 P1/P2 问题直接 PASS_READY; 含 P0 问题为 FIX_REQUIRED', () => {
    const rPass = collateReviews([
      review('a', 'minor', [
        { location: '§2', severity: 'major', category: 'structure', issue: '建议调整小节顺序' },
        { location: 'L10', severity: 'minor', issue: '标点可优化' },
      ]),
    ])
    assert.equal(rPass.gate.status, 'PASS_READY')
    assert.equal(rPass.gate.activeP0, 0)
    assert.deepEqual(rPass.activePriorityTotals, { P0: 0, P1: 1, P2: 1 })

    const rFix = collateReviews([
      review('a', 'major', [
        { location: '§2', severity: 'major', category: 'citation', issue: 'DOI 指向错误文献' },
      ]),
    ])
    assert.equal(rFix.gate.status, 'FIX_REQUIRED')
    assert.equal(rFix.gate.activeP0, 1)
    assert.deepEqual(rFix.activePriorityTotals, { P0: 1, P1: 0, P2: 0 })
    assert.match(renderSummaryMd(rFix), /收敛闸门: `FIX_REQUIRED`/)
  })
})

describe('T2 审计阻断修复回归 (#4/#5/#6, OCV5-878)', () => {
  it('#4: 显式不同 topic 的新 P0 绝不被旧裁决按正文子串误折叠; 无 topic 时短泛词也不误杀', () => {
    const ledger = {
      schemaVersion: 1 as const,
      entries: [
        {
          id: 'sec:3::符号',
          anchor: 'sec:3',
          topic: '符号',
          decision: 'accepted' as const,
          reason: '已统一全文公式符号字体为斜体',
          round: 1,
        },
        {
          id: 'sec:4::样本量缺失说明',
          anchor: 'sec:4',
          topic: '样本量缺失说明',
          decision: 'rejected_with_evidence' as const,
          reason: '表 2 已完整列出 N=200',
          round: 1,
        },
      ],
    }

    // 精确复现 auditor 场景: §3 账本已采纳 topic="符号", 新 P0 topic="物理推导" + issue 含"符号"
    const resExplicitDiff = collateReviews(
      [
        review('reviewer-a', 'reject', [
          {
            location: '§3',
            severity: 'blocker',
            category: 'math_physics',
            topic: '物理推导',
            issue: '方程的符号错误',
          },
        ]),
      ],
      [],
      { ledger, round: 2 },
    )
    assert.equal(resExplicitDiff.suppressedFlipFlops.length, 0)
    assert.equal(resExplicitDiff.gate.activeP0, 1)
    assert.equal(resExplicitDiff.gate.status, 'FIX_REQUIRED')

    // 无 topic 时, 2 字泛词 "符号" 也不得靠子串误杀同节新 P0 (fail-safe)
    const resNoTopicGeneric = collateReviews(
      [
        review('reviewer-b', 'reject', [
          {
            location: '§3',
            severity: 'blocker',
            category: 'math_physics',
            issue: '方程的符号错误',
          },
        ]),
      ],
      [],
      { ledger, round: 2 },
    )
    assert.equal(resNoTopicGeneric.suppressedFlipFlops.length, 0)
    assert.equal(resNoTopicGeneric.gate.activeP0, 1)
    assert.equal(resNoTopicGeneric.gate.status, 'FIX_REQUIRED')

    // 无 topic 时, 仅非 P0(P1/P2) 允许按足够具体的非泛词(>=4字符)正文子串折叠; 无 topic 的 P0 严禁模糊折叠
    const resNoTopicSpecificP1 = collateReviews(
      [
        review('reviewer-c', 'major', [
          {
            location: '§4',
            severity: 'major',
            category: 'structure',
            issue: '关于样本量缺失说明的排版建议',
          },
        ]),
      ],
      [],
      { ledger, round: 2 },
    )
    assert.equal(resNoTopicSpecificP1.suppressedFlipFlops.length, 1)
    assert.equal(resNoTopicSpecificP1.gate.activeP0, 0)
    assert.equal(resNoTopicSpecificP1.gate.status, 'PASS_READY')
  })

  it('#5: 账本乱序写入保护 — 低轮次 record 严禁覆盖高轮次裁决并标记 staleIgnored=true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-ledger-order-'))
    try {
      const ledgerPath = join(dir, 'decision-ledger.json')
      // 先写 round=2, decision="deferred"
      const r2 = runOcReviewCli([
        'ledger',
        'record',
        '--file',
        ledgerPath,
        '--anchor',
        '§3.2',
        '--topic',
        '样本量',
        '--decision',
        'deferred',
        '--reason',
        '第 2 轮确认留待相机就绪版补充',
        '--round',
        '2',
      ])
      assert.equal(r2.exitCode, 0, r2.stderr)
      const r2Out = JSON.parse(r2.stdout)
      assert.equal(r2Out.action, 'created')
      assert.equal(r2Out.staleIgnored, false)
      const snapshotAfterR2 = readFileSync(ledgerPath, 'utf8')

      // 再乱序写同键 round=1, decision="accepted" → 严禁覆盖 round=2
      const r1Late = runOcReviewCli([
        'ledger',
        'record',
        '--file',
        ledgerPath,
        '--anchor',
        'section 3.2',
        '--topic',
        '样本量',
        '--decision',
        'accepted',
        '--reason',
        '过期的第 1 轮裁决',
        '--round',
        '1',
      ])
      assert.equal(r1Late.exitCode, 0, r1Late.stderr)
      const r1Out = JSON.parse(r1Late.stdout)
      assert.equal(r1Out.action, 'ignored_stale')
      assert.equal(r1Out.staleIgnored, true)
      assert.equal(r1Out.entry.round, 2)
      assert.equal(r1Out.entry.decision, 'deferred')
      // 落盘文件保持字节不变
      assert.equal(readFileSync(ledgerPath, 'utf8'), snapshotAfterR2)

      // 纯函数级验证: 同轮更新与更高轮更新依然正常覆盖
      const parsed = parseDecisionLedger(snapshotAfterR2, ledgerPath)
      const sameRound = upsertLedgerEntry(parsed, {
        anchor: '§3.2',
        topic: '样本量',
        decision: 'accepted',
        reason: '第 2 轮修订后已采纳',
        round: 2,
      })
      assert.equal(sameRound.staleIgnored, false)
      assert.equal(sameRound.action, 'updated')
      assert.equal(sameRound.entry.decision, 'accepted')

      const higherRound = upsertLedgerEntry(sameRound.ledger, {
        anchor: '§3.2',
        topic: '样本量',
        decision: 'rejected_with_evidence',
        reason: '第 3 轮核查原始实验日志后驳回',
        round: 3,
      })
      assert.equal(higherRound.staleIgnored, false)
      assert.equal(higherRound.entry.round, 3)
      assert.equal(higherRound.entry.decision, 'rejected_with_evidence')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('#6: --caller-cwd / opts.callerCwd 生效 — 即使进程 cwd 不同,相对路径 --file/--dir/--ledger/--out 也落盘到调用方目录', () => {
    const callerDir = mkdtempSync(join(tmpdir(), 'oc-caller-cwd-'))
    try {
      assert.equal(resolveCallerPath('decision-ledger.json', callerDir), join(callerDir, 'decision-ledger.json'))
      assert.equal(resolveCallerPath('/abs/path.json', callerDir), '/abs/path.json')

      // 1. 经 oc-review.sh 注入的前置 --caller-cwd:相对路径 ledger init + record + show 落盘到 callerDir
      const initRes = runOcReviewCli(['--caller-cwd', callerDir, 'ledger', 'init', '--file', 'rel-ledger.json'])
      assert.equal(initRes.exitCode, 0, initRes.stderr)
      assert.equal(JSON.parse(initRes.stdout).file, join(callerDir, 'rel-ledger.json'))

      const recRes = runOcReviewCli([
        '--caller-cwd',
        callerDir,
        'ledger',
        'record',
        '--file',
        'rel-ledger.json',
        '--anchor',
        '§2',
        '--topic',
        '单位标注',
        '--decision',
        'accepted',
        '--reason',
        '已补齐国际单位制标注',
        '--round',
        '1',
      ])
      assert.equal(recRes.exitCode, 0, recRes.stderr)
      assert.equal(parseDecisionLedger(readFileSync(join(callerDir, 'rel-ledger.json'), 'utf8'), 'rel').entries.length, 1)

      // 2. 相对路径 collate --dir / --ledger / --out 全部按 callerDir 解析(同时验证 opts.callerCwd 注入)
      writeFileSync(
        join(callerDir, 'reviews-a.json'),
        JSON.stringify({
          reviewer: { model: 'm1' },
          verdict: 'minor',
          findings: [
            { location: '§2', severity: 'blocker', topic: '单位标注', issue: '单位缺失' },
          ],
        }),
      )
      const colRes = runOcReviewCli(
        [
          'collate',
          '--dir',
          '.',
          '--ledger',
          'rel-ledger.json',
          '--out',
          'out-summary.md',
          '--round',
          '2',
        ],
        { callerCwd: callerDir },
      )
      assert.equal(colRes.exitCode, 0, colRes.stderr)
      const colJson = JSON.parse(readFileSync(join(callerDir, 'out-summary.json'), 'utf8'))
      assert.equal(colJson.gate.status, 'PASS_READY')
      assert.equal(colJson.suppressedFlipFlops.length, 1)
      assert.match(readFileSync(join(callerDir, 'out-summary.md'), 'utf8'), /PASS_READY/)
    } finally {
      rmSync(callerDir, { recursive: true, force: true })
    }
  })

  it('#4b: 无 topic 的新 P0 绝不靠正文子串被同节旧裁决误折叠成 PASS_READY', () => {
    const ledger = parseDecisionLedger(
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            id: 'sec:4::验证集准确率',
            anchor: 'sec:4',
            topic: '验证集准确率',
            decision: 'accepted',
            reason: '小数位已统一为两位小数',
            round: 1,
          },
        ],
      }),
      'ledger.json',
    )
    const files: ReviewFile[] = [
      review('gpt-6.2-astra', 'reject', [
        {
          location: '§4',
          severity: 'blocker',
          issue: '验证集准确率与原始数据不一致',
        },
      ]),
    ]
    const res = collateReviews(files, [], { ledger, round: 2 })
    assert.equal(res.suppressedFlipFlops.length, 0)
    assert.equal(res.activePriorityTotals.P0, 1)
    assert.equal(res.gate.status, 'FIX_REQUIRED')
  })
})
