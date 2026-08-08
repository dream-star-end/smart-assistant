#!/usr/bin/env -S npx tsx

import * as assert from 'node:assert/strict'

import { rankCoreMemoryDocuments } from '../packages/commercial/src/http/coreMemoryLocalRanker.js'
import {
  type CoreMemoryChunk,
  selectSemanticFiles,
} from '../packages/mcp-memory/src/coreMemorySemantic.js'

function modelDirFromArgs(): string {
  const at = process.argv.indexOf('--model-dir')
  if (at < 0 || !process.argv[at + 1]) throw new Error('--model-dir is required')
  return process.argv[at + 1]
}

async function rank(query: string, chunks: CoreMemoryChunk[], modelDir: string) {
  const ranked = await rankCoreMemoryDocuments(
    query,
    chunks.map((chunk) => ({ id: chunk.id, text: chunk.text })),
    modelDir,
  )
  return selectSemanticFiles(query, chunks, ranked)
}

const modelDir = modelDirFromArgs()

// Calibrated English single-file synonym: there is no competitor, so only the
// absolute q8 floor applies rather than an invented margin.
const englishSingle: CoreMemoryChunk[] = [
  {
    id: 'single',
    path: '/memory/allergy.md',
    start: 0,
    text: 'Allergy and health background. The user is allergic to dust mites and cat dander.',
  },
]
const english = await rank('What am I allergic to?', englishSingle, modelDir)
assert.equal(english[0]?.path, '/memory/allergy.md')
assert.ok(english[0].score >= 0.82)

// Two high-scoring overlapping chunks belong to one file. Only the best score
// from that file competes with another file; overlap must not become Top-2.
const overlap: CoreMemoryChunk[] = [
  {
    id: 'deadline-a',
    path: '/memory/contract.md',
    start: 0,
    text: '合同截止日期。合同续签截止日期为九月三十日。',
  },
  {
    id: 'deadline-b',
    path: '/memory/contract.md',
    start: 18,
    text: '续签安排。必须在九月三十日之前完成合同续签。',
  },
  {
    id: 'weather',
    path: '/memory/weather.md',
    start: 0,
    text: '今天天气晴朗，公园里的花已经开放。',
  },
]
const deadline = await rank('合同最晚什么时候续签', overlap, modelDir)
assert.equal(deadline[0]?.path, '/memory/contract.md')

// A missing private fact must remain a no-match against plausible Core files.
const missing = await rank('我妻子的生日是哪天', overlap, modelDir)
assert.deepEqual(missing, [])

// A short JavaScript string can still exceed the model's 512-token contract.
// The relevant tail must be embedded as a later tokenizer-aware subchunk, not
// silently removed by truncation.
const tokenHeavyTail: CoreMemoryChunk[] = [
  {
    id: 'token-heavy',
    path: '/memory/token-heavy-contract.md',
    start: 0,
    text: `${'㌀'.repeat(270)} 合同续签截止日期为九月三十日。`,
  },
  {
    id: 'distractor',
    path: '/memory/token-heavy-weather.md',
    start: 0,
    text: '银河系包含许多恒星和行星。',
  },
]
assert.ok(tokenHeavyTail[0].text.length < 320)
const tail = await rank('合同最晚什么时候续签', tokenHeavyTail, modelDir)
assert.equal(tail[0]?.path, '/memory/token-heavy-contract.md')

process.stdout.write('core-memory-local-ranker-smoke: PASS\n')
