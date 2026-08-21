#!/usr/bin/env node
/**
 * OpenClaude personal-edition Core memory retrieval eval (private regression).
 *
 * Protocol (fixtureVersion 2026-08-17.2 / protocolVersion 1.0.0)
 * ----------------------------------------------------------------
 * SUT: handleCoreSearch({ agentId, query, limit, offset }) from
 *      packages/mcp-memory/src/memoryTools.ts — import only, never edit.
 * Corpus: evals/fixtures/  (synthetic; no real user memories).
 * Agent: eval-core
 * Isolation: fresh OPENCLAUDE_HOME temp dir per run; copy fixtures in.
 *            Unset master semantic-ranker env so the run is lexical/BM25-only
 *            and repeatable without a live master.
 * top-k: limit=20 (API max) so hit-count is the full candidate list, not a page.
 *        precision@3 / MRR / mustNotRank1 inspect the returned rank order.
 * Hit judgement:
 *   - "No safe Core memories match ..." → kind no_match, ranked=[]
 *   - "Found N safe Core matches ..."   → kind hit, N = reported total
 *   - ranked files = basename of each `path:` line, in printed order
 *   - relevant = expect.topFiles (basename)
 *   - P@3_i = |top3 ∩ relevant| / min(3, |relevant|)
 *       if mustNotRank1 contains ranked[0] → 0
 *       if maxHits is set and N > maxHits → 0
 *   - MRR_i = 1/rank(first relevant), or 0 if absent / mustNotRank1 / maxHits fail
 *   - allowNoMatch on a hit-case: a true no_match scores P@3=1 and MRR=1
 *   - no-match accuracy: fraction of kind=no_match cases that returned no_match
 *   - avgHits: mean N over all cases (no_match contributes 0)
 * Gates (exit 1 on any miss):
 *   precision@3 >= 0.8
 *   no-match accuracy == 1.0
 *   avgHits <= 0.40 * corpusSize
 *
 * Usage:
 *   npx tsx packages/mcp-memory/evals/run.mjs
 *   npx tsx packages/mcp-memory/evals/run.mjs --json
 *   npx tsx packages/mcp-memory/evals/run.mjs --baseline packages/mcp-memory/evals/baseline-before.json
 *   npx tsx packages/mcp-memory/evals/run.mjs --json > /tmp/after.json
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_VERSION = '2026-08-17.2'
const PROTOCOL_VERSION = '1.0.0'
const AGENT_ID = 'eval-core'
const LIMIT = 20
const TOP_K = 3
const GATES = {
  precisionAt3: 0.8,
  noMatchAccuracy: 1.0,
  avgHitsRatio: 0.4,
}

function findTsx() {
  return [
    join(here, '../../../node_modules/tsx/dist/cli.mjs'),
    '/opt/openclaude/openclaude/node_modules/tsx/dist/cli.mjs',
  ].find((p) => existsSync(p))
}

function findNodePath() {
  return [
    join(here, '../../../node_modules'),
    '/opt/openclaude/openclaude/node_modules',
  ]
    .filter((p) => existsSync(p))
    .join(':')
}

if (!process.env.OC_MEMORY_EVAL_TSX && !process.execArgv.some((a) => a.includes('tsx'))) {
  const tsx = findTsx()
  if (!tsx) {
    console.error('Need tsx. Run: npx tsx packages/mcp-memory/evals/run.mjs')
    process.exit(2)
  }
  const env = { ...process.env, OC_MEMORY_EVAL_TSX: '1' }
  const nodePath = findNodePath()
  if (nodePath) env.NODE_PATH = env.NODE_PATH ? `${nodePath}:${env.NODE_PATH}` : nodePath
  const result = spawnSync(process.execPath, [tsx, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  })
  process.exit(result.status ?? 2)
}

function parseArgs(argv) {
  const out = { json: false, baseline: null, keepHome: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--keep-home') out.keepHome = true
    else if (a === '--baseline') {
      out.baseline = argv[++i]
      if (!out.baseline) throw new Error('--baseline requires a file path')
    } else if (a === '--help' || a === '-h') {
      out.help = true
    } else {
      throw new Error(`unknown arg: ${a}`)
    }
  }
  return out
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function parseSearchText(text) {
  const noMatch = /^No safe Core memories match /.test(text)
  if (noMatch) return { kind: 'no_match', total: 0, ranked: [] }
  const found = text.match(/^Found (\d+) safe Core matches /)
  if (!found) return { kind: 'error', total: 0, ranked: [], error: text.slice(0, 400) }
  const ranked = []
  const re = /^path:\s+(\S+)/gm
  let m
  while ((m = re.exec(text))) ranked.push(basename(m[1]))
  return { kind: 'hit', total: Number(found[1]), ranked }
}

function scoreCase(c, parsed) {
  const expect = c.expect
  const relevant = expect.topFiles ?? []
  const banned = expect.mustNotRank1 ?? []
  const result = {
    id: c.id,
    query: c.query,
    category: c.category,
    expectKind: expect.kind,
    gotKind: parsed.kind,
    total: parsed.total,
    ranked: parsed.ranked,
    top1: parsed.ranked[0] ?? null,
    pAt3: null,
    mrr: null,
    ok: false,
    reasons: [],
  }
  if (parsed.kind === 'error') {
    result.reasons.push(`sut_error: ${parsed.error}`)
    result.pAt3 = 0
    result.mrr = 0
    return result
  }
  if (expect.kind === 'no_match') {
    result.ok = parsed.kind === 'no_match'
    if (!result.ok) result.reasons.push(`expected no_match, got Found ${parsed.total} top1=${result.top1}`)
    return result
  }
  if (parsed.kind === 'no_match') {
    if (expect.allowNoMatch) {
      result.ok = true
      result.pAt3 = 1
      result.mrr = 1
      result.reasons.push('accepted no_match via allowNoMatch')
      return result
    }
    result.pAt3 = 0
    result.mrr = 0
    result.reasons.push('expected hit, got no_match')
    return result
  }
  const over = Number.isInteger(expect.maxHits) && parsed.total > expect.maxHits
  const bannedHit = banned.length > 0 && banned.includes(parsed.ranked[0])
  const top3 = parsed.ranked.slice(0, TOP_K)
  const overlap = relevant.length ? top3.filter((f) => relevant.includes(f)).length : 0
  let pAt3 = relevant.length ? overlap / Math.min(TOP_K, relevant.length) : 1
  const first = parsed.ranked.findIndex((f) => relevant.includes(f))
  let mrr = first === -1 ? 0 : 1 / (first + 1)
  if (bannedHit) {
    pAt3 = 0
    mrr = 0
    result.reasons.push(`mustNotRank1: ${parsed.ranked[0]}`)
  }
  if (over) {
    pAt3 = 0
    mrr = 0
    result.reasons.push(`maxHits ${expect.maxHits} exceeded (got ${parsed.total})`)
  }
  if (relevant.length && first === -1 && !bannedHit && !over) {
    result.reasons.push(`none of topFiles in ranked list: ${relevant.join(',')}`)
  }
  result.pAt3 = pAt3
  result.mrr = mrr
  result.ok = pAt3 === 1 && mrr === 1 && !over && !bannedHit
  if (pAt3 < 1 && !result.reasons.length) result.reasons.push(`precision@3=${pAt3.toFixed(3)}`)
  return result
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function fmt(n, d = 3) {
  return Number.isFinite(n) ? n.toFixed(d) : 'n/a'
}

function delta(now, prev) {
  if (!Number.isFinite(now) || !Number.isFinite(prev)) return 'n/a'
  const d = now - prev
  const sign = d > 0 ? '+' : ''
  return `${sign}${d.toFixed(3)}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('Usage: npx tsx packages/mcp-memory/evals/run.mjs [--json] [--baseline <file>]')
    process.exit(0)
  }

  const spec = JSON.parse(readFileSync(join(here, 'memory-retrieval.json'), 'utf8'))
  if (spec.cases.length !== 30) {
    throw new Error(`protocol requires 30 cases, spec has ${spec.cases.length}`)
  }
  const diskVersion = readFileSync(join(here, 'fixtures/VERSION'), 'utf8').trim()
  if (diskVersion !== FIXTURE_VERSION || spec.fixtureVersion !== FIXTURE_VERSION) {
    throw new Error(`fixture version mismatch: disk=${diskVersion} spec=${spec.fixtureVersion} runner=${FIXTURE_VERSION}`)
  }

  const fixtureTexts = []
  const userSrc = join(here, 'fixtures/user.md')
  fixtureTexts.push({ file: 'user.md', text: readFileSync(userSrc, 'utf8') })
  const memorySrc = join(here, 'fixtures/memory')
  for (const name of readdirSync(memorySrc).filter((n) => n.endsWith('.md'))) {
    fixtureTexts.push({ file: `memory/${name}`, text: readFileSync(join(memorySrc, name), 'utf8') })
  }
  const leaks = []
  for (const c of spec.cases) {
    if (c.expect?.kind !== 'no_match') continue
    const needle = String(c.query)
    for (const doc of fixtureTexts) {
      if (doc.text.includes(needle) || doc.text.toLocaleLowerCase().includes(needle.toLocaleLowerCase())) {
        leaks.push(`${c.id} query ${JSON.stringify(needle)} appears in ${doc.file}`)
      }
    }
  }
  if (leaks.length) {
    throw new Error(`no-match queries must not appear verbatim in fixtures:\n${leaks.join('\n')}`)
  }

  const home = mkdtempSync(join(tmpdir(), 'oc-core-eval-'))
  const memoryDst = join(home, 'agents', AGENT_ID, 'memory')
  mkdirSync(memoryDst, { recursive: true })
  cpSync(memorySrc, memoryDst, { recursive: true })
  cpSync(join(here, 'fixtures/user.md'), join(home, 'user.md'))

  const memoryFiles = readdirSync(memoryDst).filter((n) => n.endsWith('.md'))
  let corpusBytes = statSync(join(home, 'user.md')).size
  for (const f of memoryFiles) corpusBytes += statSync(join(memoryDst, f)).size
  const corpusSize = memoryFiles.length + 1

  process.env.OPENCLAUDE_HOME = home
  process.env.OPENCLAUDE_SESSION_KEY = 'eval-core-retrieval'
  delete process.env.OC_MANAGED_AGENT_RUNTIME
  delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE
  const policyKey = createHash('sha256').update('eval-core-retrieval').digest('hex')
  mkdirSync(join(home, '.memory-turn-policy'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(home, '.memory-turn-policy', `${policyKey}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      allowed: true,
      reason: 'explicit_continuity',
      expiresAt: Date.now() + 24 * 3600 * 1000,
    })}\n`,
    { mode: 0o600 },
  )

  const sutUrl = pathToFileURL(join(here, '../src/memoryTools.ts')).href
  const { handleCoreSearch } = await import(sutUrl)
  if (typeof handleCoreSearch !== 'function') {
    throw new Error('handleCoreSearch not exported from memoryTools.ts')
  }

  const caseRows = []
  const latencies = []
  for (const c of spec.cases) {
    const t0 = Date.now()
    const raw = await handleCoreSearch({
      agentId: AGENT_ID,
      query: c.query,
      limit: LIMIT,
      offset: 0,
    })
    const ms = Date.now() - t0
    latencies.push(ms)
    const text = raw?.content?.[0]?.text ?? ''
    const parsed = raw?.isError ? { kind: 'error', total: 0, ranked: [], error: text } : parseSearchText(text)
    const scored = scoreCase(c, parsed)
    scored.latencyMs = ms
    caseRows.push(scored)
  }

  const hitRows = caseRows.filter((r) => r.expectKind === 'hit')
  const noMatchRows = caseRows.filter((r) => r.expectKind === 'no_match')
  const precisionAt3 = mean(hitRows.map((r) => r.pAt3 ?? 0))
  const mrr = mean(hitRows.map((r) => r.mrr ?? 0))
  const noMatchAccuracy = noMatchRows.length
    ? noMatchRows.filter((r) => r.ok).length / noMatchRows.length
    : 1
  const avgHits = mean(caseRows.map((r) => r.total))
  const avgHitsCap = GATES.avgHitsRatio * corpusSize
  const latSorted = [...latencies].sort((a, b) => a - b)
  const latencyMs = {
    p50: percentile(latSorted, 50),
    p95: percentile(latSorted, 95),
    mean: mean(latencies),
    max: latSorted[latSorted.length - 1] ?? 0,
  }
  const gates = {
    precisionAt3: precisionAt3 >= GATES.precisionAt3,
    noMatchAccuracy: noMatchAccuracy >= GATES.noMatchAccuracy,
    avgHits: avgHits <= avgHitsCap,
  }
  const pass = gates.precisionAt3 && gates.noMatchAccuracy && gates.avgHits

  const report = {
    protocol: {
      fixtureVersion: FIXTURE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      agentId: AGENT_ID,
      limit: LIMIT,
      topK: TOP_K,
      semanticRanker: 'disabled',
      sut: 'packages/mcp-memory/src/memoryTools.ts#handleCoreSearch',
    },
    corpus: {
      files: corpusSize,
      memoryFiles: memoryFiles.length,
      bytes: corpusBytes,
      home,
    },
    metrics: {
      precisionAt3,
      mrr,
      noMatchAccuracy,
      avgHits,
      avgHitsCap,
      latencyMs,
      hitCases: hitRows.length,
      noMatchCases: noMatchRows.length,
      casesPassed: caseRows.filter((r) => r.ok).length,
      casesTotal: caseRows.length,
    },
    gates,
    pass,
    cases: caseRows,
  }

  if (args.baseline) {
    const prev = JSON.parse(readFileSync(args.baseline, 'utf8'))
    report.delta = {
      vs: args.baseline,
      precisionAt3: delta(precisionAt3, prev.metrics?.precisionAt3),
      mrr: delta(mrr, prev.metrics?.mrr),
      noMatchAccuracy: delta(noMatchAccuracy, prev.metrics?.noMatchAccuracy),
      avgHits: delta(avgHits, prev.metrics?.avgHits),
      latencyP50: delta(latencyMs.p50, prev.metrics?.latencyMs?.p50),
      latencyP95: delta(latencyMs.p95, prev.metrics?.latencyMs?.p95),
      passWas: prev.pass,
      passNow: pass,
    }
  }

  if (!args.keepHome) {
    rmSync(home, { recursive: true, force: true })
    report.corpus.home = '(removed)'
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`OpenClaude Core retrieval eval  fixture=${FIXTURE_VERSION}  protocol=${PROTOCOL_VERSION}`)
    console.log(`corpus: ${corpusSize} files / ${corpusBytes} bytes   agent=${AGENT_ID}   limit=${LIMIT}`)
    console.log('')
    console.log(`precision@3      ${fmt(precisionAt3)}   gate >= ${GATES.precisionAt3}   ${gates.precisionAt3 ? 'PASS' : 'FAIL'}`)
    console.log(`MRR              ${fmt(mrr)}`)
    console.log(`no-match acc     ${fmt(noMatchAccuracy)}   gate == ${GATES.noMatchAccuracy}   ${gates.noMatchAccuracy ? 'PASS' : 'FAIL'}`)
    console.log(`avg hits         ${fmt(avgHits, 2)}   gate <= ${fmt(avgHitsCap, 2)} (${GATES.avgHitsRatio}*${corpusSize})   ${gates.avgHits ? 'PASS' : 'FAIL'}`)
    console.log(`latency ms       p50=${latencyMs.p50}  p95=${latencyMs.p95}  mean=${fmt(latencyMs.mean, 1)}`)
    console.log(`cases            ${report.metrics.casesPassed}/${report.metrics.casesTotal} individual ok`)
    if (report.delta) {
      console.log('')
      console.log(`delta vs ${report.delta.vs}`)
      console.log(`  precision@3    ${report.delta.precisionAt3}`)
      console.log(`  MRR            ${report.delta.mrr}`)
      console.log(`  no-match acc   ${report.delta.noMatchAccuracy}`)
      console.log(`  avg hits       ${report.delta.avgHits}`)
      console.log(`  latency p50    ${report.delta.latencyP50}`)
      console.log(`  latency p95    ${report.delta.latencyP95}`)
      console.log(`  pass           ${report.delta.passWas} → ${report.delta.passNow}`)
    }
    console.log('')
    for (const r of caseRows) {
      const mark = r.ok ? 'ok  ' : 'FAIL'
      const extra = r.reasons.length ? `  ${r.reasons.join('; ')}` : ''
      console.log(`${mark} ${r.id.padEnd(3)}  hits=${String(r.total).padStart(2)}  top1=${r.top1 ?? '-'}  ${r.query}${extra}`)
    }
    console.log('')
    console.log(pass ? 'RESULT  PASS' : 'RESULT  FAIL')
  }

  process.exit(pass ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
