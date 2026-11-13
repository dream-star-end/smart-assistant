#!/usr/bin/env -S npx tsx
/**
 * v5-selfhost-g8-replay.ts — 个人版 G8 回放门。
 *
 * 监控规则改动前先跑这一门。只读本地夹具，不连数据库，不调模型，不计费。
 *
 *   npx tsx scripts/v5-selfhost-g8-replay.ts [fixtures-dir]
 *
 * 退出码: 0 每例判定与夹具一致; 1 有不一致或夹具不可读。
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  judgeG8Replay,
  type G8ReplayObservation,
  type G8ReplayVerdict,
} from '../packages/protocol/src/g8ReplayJudge.js'

const FIELDS = [
  'verdict',
  'severity',
  'retryable',
  'askHuman',
  'alert',
  'stopSession',
  'reason',
  'point',
  'traceId',
] as const

type Compared = Pick<G8ReplayVerdict, (typeof FIELDS)[number]>

export interface G8ReplayCase {
  id: string
  expect: Compared
  observation: G8ReplayObservation
}

export interface G8ReplayGateResult {
  ok: boolean
  checked: number
  failures: string[]
}

function defaultDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/g8-replay')
}

export function runG8ReplayGate(dir: string): G8ReplayGateResult {
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch {
    return { ok: false, checked: 0, failures: ['fixtures unreadable'] }
  }
  const failures: string[] = []
  if (names.length === 0) failures.push('no fixtures')
  for (const name of names) {
    let parsed: G8ReplayCase
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as G8ReplayCase
    } catch {
      failures.push(`${name}: unreadable`)
      continue
    }
    const id = typeof parsed.id === 'string' && parsed.id ? parsed.id : name
    if (!parsed.expect || !parsed.observation) {
      failures.push(`${id}: missing expect or observation`)
      continue
    }
    const got = judgeG8Replay(parsed.observation)
    for (const field of FIELDS) {
      if (got[field] !== parsed.expect[field]) {
        failures.push(
          `${id}: ${field} expected ${JSON.stringify(parsed.expect[field])} got ${JSON.stringify(got[field])}`,
        )
      }
    }
  }
  return { ok: failures.length === 0, checked: names.length, failures }
}

export function g8ReplayGateMain(argv: string[]): number {
  const result = runG8ReplayGate(argv[0] ?? defaultDir())
  if (!result.ok) {
    for (const line of result.failures) console.error(line)
    return 1
  }
  console.log(`g8 replay gate ok: ${result.checked} cases`)
  return 0
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isDirectRun() || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  process.exit(g8ReplayGateMain(process.argv.slice(2)))
}
