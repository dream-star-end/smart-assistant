#!/usr/bin/env tsx
/**
 * 文献插件(literature-db)7/14 天聚合(OCV5-585)。只读:扫 master 结构化日志里的
 * `literature_plugin_call` / `literature_artifact` 行(logrotate 轮转件 .gz 自动解压),只输出聚合 JSON,
 * 不输出逐用户或逐条记录。
 *
 * 用法:
 *   npx tsx packages/commercial/scripts/literature-plugin-metrics.ts \
 *     [--end 2026-10-30T00:00:00Z] [--days 7,14] [--exclude-uids 247] <日志文件...>
 *
 * 商业生产:A 槽 /var/log/openclaude-v5.log*、B 槽 /var/log/openclaude-v5-b.log*(两槽都给,发布会切槽)。
 * 排除人工负向测试:--exclude-uids 默认 247(测试账号),整行不计;DOCUMENT_EXPIRED/INVALID_INPUT 等
 * client 类错误单列 clientErrors,不进成功率分母。
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { createLiteratureMetricsAggregator } from '../src/plugins/literatureDb/observability.js'

function parseArgs(argv: string[]): {
  endMs: number
  days: number[]
  excludeUids: Set<number>
  files: string[]
} {
  let endMs = Date.now()
  let days = [7, 14]
  let excludeUids = new Set([247])
  const files: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === '--end') {
      endMs = Date.parse(next())
      if (!Number.isFinite(endMs)) throw new Error('--end must be an ISO time')
    } else if (arg === '--days') {
      days = next()
        .split(',')
        .map((d) => Number(d))
      if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 90))
        throw new Error('--days takes 1..90, comma separated')
    } else if (arg === '--exclude-uids') {
      const raw = next().trim()
      excludeUids = new Set(raw ? raw.split(',').map((u) => Number(u)) : [])
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`)
    } else {
      files.push(arg)
    }
  }
  if (files.length === 0) throw new Error('give at least one log file')
  return { endMs, days, excludeUids, files }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const aggregator = createLiteratureMetricsAggregator({
    endMs: args.endMs,
    windowsDays: args.days,
    excludeUids: args.excludeUids,
  })
  const scanned: string[] = []
  for (const file of args.files) {
    const raw = createReadStream(file)
    const input = file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
    for await (const line of lines) {
      if (line.includes('"literature_')) aggregator.add(line)
    }
    scanned.push(file)
  }
  const report = aggregator.finish()
  process.stdout.write(
    `${JSON.stringify(
      {
        end: new Date(args.endMs).toISOString(),
        excludedUids: [...args.excludeUids],
        files: scanned.length,
        ...report,
      },
      null,
      2,
    )}\n`,
  )
}

main().catch((error: unknown) => {
  process.stderr.write(
    `literature-plugin-metrics: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(2)
})
