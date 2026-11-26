/**
 * OCV5-906 — Collectors for the 4 Governance Cockpit Gauges + optional read-only PG probe.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import {
  type CockpitCliOptions,
  type ComputeAndWasteGauge,
  type DeliveryAndExperienceGauge,
  type MetaGuardrailIntegrityGauge,
  type PgComputeData,
  type StructureAndReworkGauge,
  type TrafficLight,
  type TrainRow,
  fmtNum,
  fmtPct,
  fmtSigned,
  querySqliteJson,
  readJsonl,
  round4,
  safeGit,
  safeReadJson,
  verifyApprovalChecksum,
  windowBoundsIso,
  worstLight,
} from './cockpitDigestTypes.js'

const { Client } = pg

function isProdSourceFile(rel: string): boolean {
  return (
    /^packages\/.*\.(ts|tsx|mts)$/.test(rel) &&
    !/\.d\.ts$/.test(rel) &&
    !/\.(test|spec)\.(ts|tsx)$/.test(rel) &&
    !/(^|\/)(__tests__|__smoke__|browser-tests|generated)\//.test(rel)
  )
}

function countLines(text: string): number {
  if (!text) return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

function sumViolations(entries: Record<string, number>): { total: number; r2: number } {
  let total = 0
  let r2 = 0
  for (const [k, v] of Object.entries(entries)) {
    const n = Number(v) || 0
    total += n
    if (k.startsWith('R2-')) r2 += n
  }
  return { total, r2 }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function collectStructureAndRework(opts: CockpitCliOptions): StructureAndReworkGauge {
  const notes: string[] = []
  const lights: TrafficLight[] = []
  const repo = opts.repoRoot
  let fixBugCommits: number | 'N/A' = 'N/A'
  let totalCommits: number | 'N/A' = 'N/A'
  let reworkRatio: number | 'N/A' = 'N/A'
  let reworkStatus: TrafficLight = 'N/A'
  let addedLoc: number | 'N/A' = 'N/A'
  let deletedLoc: number | 'N/A' = 'N/A'
  let netLoc: number | 'N/A' = 'N/A'
  let archTotal: number | 'N/A' = 'N/A'
  let archR2: number | 'N/A' = 'N/A'
  let archDelta: number | 'N/A' = 'N/A'
  let archR2Delta: number | 'N/A' = 'N/A'
  let top10Count: number | 'N/A' = 'N/A'
  let top10Total: number | 'N/A' = 'N/A'
  let top10Delta: number | 'N/A' = 'N/A'
  let top10Grown: number | 'N/A' = 'N/A'
  let expiredTtls: number | 'N/A' = 'N/A'

  if (repo && existsSync(repo)) {
    const w14 = windowBoundsIso(opts.date, 14)
    const w7 = windowBoundsIso(opts.date, 7)
    const log14 = safeGit(repo, ['log', '--no-merges', `--since=${w14.sinceIso}`, `--until=${w14.untilIso}`, '--format=%s'])
    if (log14 !== null) {
      const subjects = log14.split('\n').map((s) => s.trim()).filter(Boolean)
      totalCommits = subjects.length
      fixBugCommits = subjects.filter((s) => /^(?:fix|bug)(?:\([^)]*\))?!?:/i.test(s)).length
      if (totalCommits > 0) {
        reworkRatio = round4(fixBugCommits / totalCommits)
        reworkStatus = reworkRatio > 0.4 ? 'RED' : reworkRatio > 0.35 ? 'AMBER' : 'GREEN'
        if (reworkStatus !== 'GREEN') notes.push(`14d fix+bug ratio ${fmtPct(reworkRatio)} (${reworkStatus})`)
        lights.push(reworkStatus)
      }
    }
    const numstat = safeGit(repo, ['log', '--no-merges', `--since=${w7.sinceIso}`, `--until=${w7.untilIso}`, '--numstat', '--format=', '--', 'packages'])
    if (numstat !== null) {
      let add = 0
      let del = 0
      for (const line of numstat.split('\n')) {
        const parts = line.split('\t')
        if (parts.length < 3) continue
        const a = Number(parts[0])
        const d = Number(parts[1])
        if (!Number.isFinite(a) || !Number.isFinite(d) || !isProdSourceFile(parts[2]!.trim())) continue
        add += a
        del += d
      }
      addedLoc = add
      deletedLoc = del
      netLoc = add - del
    }

    const rev7dAgo = safeGit(repo, ['rev-list', '-n', '1', `--before=${w7.sinceIso}`, 'HEAD'])?.trim()
    const vBase = safeReadJson<{ entries?: Record<string, number> }>(
      path.join(repo, 'arch/violations-baseline.json'),
    )
    if (vBase?.entries) {
      const cur = sumViolations(vBase.entries)
      archTotal = cur.total
      archR2 = cur.r2
      const oldRaw = rev7dAgo ? safeGit(repo, ['show', `${rev7dAgo}:arch/violations-baseline.json`]) : null
      if (oldRaw) {
        try {
          const parsed = JSON.parse(oldRaw) as { entries?: Record<string, number> }
          if (parsed.entries) {
            const prev = sumViolations(parsed.entries)
            archDelta = cur.total - prev.total
            archR2Delta = cur.r2 - prev.r2
            if (archDelta > 0 || archR2Delta > 0) {
              lights.push('RED')
              notes.push(`Architecture baseline grew (total=${fmtSigned(archDelta)}, R2=${fmtSigned(archR2Delta)})`)
            } else {
              lights.push('GREEN')
            }
          }
        } catch {
          // keep delta N/A
        }
      }
    }

    const fsBase = safeReadJson<{ files?: Record<string, number>; yellowZoneFiles?: Record<string, number> }>(
      path.join(repo, '.github/file-size-baseline.json'),
    )
    if (fsBase?.files) {
      const merged = Object.entries({ ...(fsBase.yellowZoneFiles ?? {}), ...fsBase.files })
        .filter(([p]) => isProdSourceFile(p) || p.endsWith('.ts') || p.endsWith('.tsx'))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
      if (merged.length > 0) {
        top10Count = merged.length
        let curSum = 0
        let prevSum = 0
        let havePrevAll = Boolean(rev7dAgo)
        let grown = 0
        for (const [relPath, baseLines] of merged) {
          const abs = path.join(repo, relPath)
          const nowLines = existsSync(abs) ? countLines(readFileSync(abs, 'utf8')) : baseLines
          curSum += nowLines
          if (rev7dAgo) {
            const oldFile = safeGit(repo, ['show', `${rev7dAgo}:${relPath}`])
            if (oldFile !== null) {
              const oldLines = countLines(oldFile)
              prevSum += oldLines
              if (nowLines > oldLines) grown += 1
            } else {
              havePrevAll = false
            }
          }
        }
        top10Total = curSum
        if (havePrevAll) {
          top10Delta = curSum - prevSum
          top10Grown = grown
          if (top10Delta > 0) {
            lights.push('AMBER')
            notes.push(`Top-10 god files grew by +${top10Delta} lines across ${grown} file(s)`)
          }
        }
      }
    }

    let expired = 0
    let sawTtlSource = false
    const excList = safeReadJson<Array<{ expires?: string }>>(
      path.join(repo, '.github/file-size-ratchet-exceptions.json'),
    )
    if (Array.isArray(excList)) {
      sawTtlSource = true
      for (const item of excList) {
        if (typeof item?.expires === 'string' && item.expires < opts.date) expired += 1
      }
    }
    const debtPolicy = safeReadJson<{ items?: Array<{ expiresAt?: string; expires?: string }> }>(
      path.join(repo, 'arch/debt-ttl-policy.json'),
    )
    if (debtPolicy && Array.isArray(debtPolicy.items)) {
      sawTtlSource = true
      for (const item of debtPolicy.items) {
        const exp = item.expiresAt ?? item.expires
        if (typeof exp === 'string' && exp.slice(0, 10) < opts.date) expired += 1
      }
    }
    if (sawTtlSource) {
      expiredTtls = expired
      lights.push(expired > 0 ? 'RED' : 'GREEN')
      if (expired > 0) notes.push(`${expired} debt exception TTL(s) expired before ${opts.date}`)
    }
  }

  return {
    status: worstLight(lights),
    rework14d: { fixBugCommits, totalCommits, ratio: reworkRatio, status: reworkStatus },
    prodLoc7d: { added: addedLoc, deleted: deletedLoc, netDelta: netLoc },
    archViolations: { total: archTotal, r2Total: archR2, netDelta7d: archDelta, r2NetDelta7d: archR2Delta },
    top10GodFiles: { trackedCount: top10Count, totalLines: top10Total, netDelta7d: top10Delta, grownCount: top10Grown },
    expiredDebtTtlCount: expiredTtls,
    notes,
  }
}

export function collectDeliveryAndExperience(
  opts: CockpitCliOptions,
  pgImplicit?: { current7d: number; previous7d: number } | null,
): DeliveryAndExperienceGauge {
  const notes: string[] = []
  const lights: TrafficLight[] = []
  const w7 = windowBoundsIso(opts.date, 7)
  const w30 = windowBoundsIso(opts.date, 30)

  let committed7d: number | 'N/A' = 'N/A'
  let total7d: number | 'N/A' = 'N/A'
  let rate7d: number | 'N/A' = 'N/A'
  let rate7dLight: TrafficLight = 'N/A'
  let committed30d: number | 'N/A' = 'N/A'
  let total30d: number | 'N/A' = 'N/A'
  let rate30d: number | 'N/A' = 'N/A'

  const rollbackKeys = new Set<string>()
  let sawRollbackSource = false

  if (opts.leaseDb && existsSync(opts.leaseDb)) {
    const rows = querySqliteJson<TrainRow>(
      opts.leaseDb,
      'SELECT id, status, reason, created_at, started_at, finished_at, updated_at FROM train;',
    )
    if (rows !== null) {
      sawRollbackSource = true
      const terminal = new Set(['committed', 'failed', 'recovery_required'])
      const in7d = rows.filter(
        (r) => r.created_at >= w7.sinceIso && r.created_at < w7.untilIso && terminal.has(r.status),
      )
      const in30d = rows.filter(
        (r) => r.created_at >= w30.sinceIso && r.created_at < w30.untilIso && terminal.has(r.status),
      )
      total7d = in7d.length
      committed7d = in7d.filter((r) => r.status === 'committed').length
      if (total7d > 0) {
        rate7d = round4(committed7d / total7d)
        if (rate7d >= 0.8) rate7dLight = 'GREEN'
        else if (rate7d >= 0.5) {
          rate7dLight = 'AMBER'
          notes.push(`7d train first-pass rate ${fmtPct(rate7d)} below 80% target (baseline 26%)`)
        } else {
          rate7dLight = 'RED'
          notes.push(`7d train first-pass rate ${fmtPct(rate7d)} < 50% RED floor (baseline 26%)`)
        }
        lights.push(rate7dLight)
      }
      total30d = in30d.length
      committed30d = in30d.filter((r) => r.status === 'committed').length
      if (total30d > 0) rate30d = round4(committed30d / total30d)

      for (const r of rows) {
        if (r.created_at >= w7.sinceIso && r.created_at < w7.untilIso) {
          if (/rollback/i.test(r.reason ?? '') || r.status === 'recovery_required') rollbackKeys.add(r.id)
        }
      }
    }
  }

  if (opts.governorRoot && existsSync(opts.governorRoot)) {
    const rbFile = path.join(opts.governorRoot, 'control/rollbacks.jsonl')
    if (existsSync(rbFile)) {
      sawRollbackSource = true
      for (const entry of readJsonl(rbFile)) {
        const ts = String(entry.ts ?? entry.recordedAt ?? '')
        if (ts >= w7.sinceIso && ts < w7.untilIso) rollbackKeys.add(String(entry.train ?? entry.id ?? ts))
      }
    }
  }

  const weeklyRollbacks: number | 'N/A' = sawRollbackSource ? rollbackKeys.size : 'N/A'
  if (typeof weeklyRollbacks === 'number') {
    if (weeklyRollbacks >= 2) {
      lights.push('RED')
      notes.push(`${weeklyRollbacks} rollbacks in 7d (>=2 trips Debt-First circuit breaker)`)
    } else if (weeklyRollbacks === 1) {
      lights.push('AMBER')
      notes.push('1 rollback recorded in 7d')
    } else {
      lights.push('GREEN')
    }
  }

  let retStamp: string | 'N/A' = 'N/A'
  let retPassed: number | 'N/A' = 'N/A'
  let retTotal: number | 'N/A' = 'N/A'
  let retOk: boolean | 'N/A' = 'N/A'
  let retSummary = 'N/A'

  if (opts.harnessResultsDir && existsSync(opts.harnessResultsDir)) {
    const files = readdirSync(opts.harnessResultsDir).filter((f) => f.endsWith('.json')).sort()
    const chosen = files.filter((f) => !f.startsWith('gates-')).at(-1) ?? files.at(-1)
    const parsed = chosen
      ? safeReadJson<Record<string, unknown>>(path.join(opts.harnessResultsDir, chosen))
      : null
    if (parsed && chosen) {
      retStamp = String(parsed.stamp ?? chosen.replace(/\.json$/, ''))
      if (typeof parsed.pass === 'number' && typeof parsed.fail === 'number') {
        retPassed = parsed.pass
        retTotal = parsed.pass + parsed.fail
        retOk = parsed.fail === 0 && Boolean(parsed.ok ?? true)
      } else if (Array.isArray(parsed.gates)) {
        const retGate = (parsed.gates as Array<Record<string, unknown>>).find((g) => g.id === 'retention')
        const det = (retGate?.details ?? {}) as Record<string, unknown>
        if (typeof det.pass === 'number' && typeof det.fail === 'number') {
          retPassed = det.pass
          retTotal = det.pass + det.fail
          retOk = det.fail === 0 && retGate?.status === 'PASS'
        }
      }
      if (typeof retPassed === 'number' && typeof retTotal === 'number') {
        retSummary = `${retPassed}/${retTotal} ${retOk ? 'PASS' : 'FAIL'} (${retStamp})`
        lights.push(retOk ? 'GREEN' : 'RED')
        if (!retOk) notes.push(`Retention suite failing: ${retSummary}`)
      }
    }
  }

  let curImp: number | 'N/A' = 'N/A'
  let prevImp: number | 'N/A' = 'N/A'
  let impDelta: number | 'N/A' = 'N/A'
  let impSummary = 'N/A'
  const archSnap = safeReadJson<{ commitAttribution?: { regressingCommits?: string[] } }>(opts.archTelemetryJson)
  const regressingCommits = Array.isArray(archSnap?.commitAttribution?.regressingCommits)
    ? archSnap.commitAttribution.regressingCommits.map(String)
    : []

  if (pgImplicit) {
    curImp = pgImplicit.current7d
    prevImp = pgImplicit.previous7d
    impDelta = curImp - prevImp
  } else if (opts.selfevolveReportDir && existsSync(opts.selfevolveReportDir)) {
    const reports = readdirSync(opts.selfevolveReportDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) <= opts.date)
      .sort()
    const sumImp = (f: string): number | null => {
      const r = safeReadJson<{ ratings?: { downImplicitByTag?: Array<{ n?: number }> } }>(
        path.join(opts.selfevolveReportDir!, f),
      )
      return Array.isArray(r?.ratings?.downImplicitByTag)
        ? r.ratings.downImplicitByTag.reduce((s, x) => s + (Number(x.n) || 0), 0)
        : null
    }
    if (reports.length >= 1) {
      const v1 = sumImp(reports.at(-1)!)
      if (v1 !== null) curImp = v1
      if (reports.length >= 2 && typeof curImp === 'number') {
        const v0 = sumImp(reports.at(-2)!)
        if (v0 !== null) {
          prevImp = v0
          impDelta = curImp - prevImp
        }
      }
    }
  }

  if (typeof curImp === 'number') {
    impSummary =
      typeof prevImp === 'number' && typeof impDelta === 'number'
        ? `${curImp} vs prev ${prevImp} (${fmtSigned(impDelta)})`
        : `${curImp} (prev N/A)`
    if (regressingCommits.length > 0) {
      lights.push('RED')
      notes.push(`Regressing commits flagged on rewrite/resend: ${regressingCommits.join(', ')}`)
    } else if (typeof prevImp === 'number' && prevImp >= 10 && curImp > prevImp * 1.3) {
      lights.push('AMBER')
      notes.push(`Implicit negative feedback rose >30% (${impSummary})`)
    } else {
      lights.push('GREEN')
    }
  } else if (regressingCommits.length > 0) {
    lights.push('RED')
    impSummary = `regressing commits: ${regressingCommits.join(', ')}`
  }

  return {
    status: worstLight(lights),
    trainPassRate7d: { committed: committed7d, terminalTotal: total7d, rate: rate7d, baseline: 0.26, target: 0.8, status: rate7dLight },
    trainPassRate30d: { committed: committed30d, terminalTotal: total30d, rate: rate30d },
    weeklyRollbacks,
    retentionLatest: { stamp: retStamp, passed: retPassed, total: retTotal, ok: retOk, summary: retSummary },
    implicitNegativeTrend: { current7d: curImp, previous7d: prevImp, delta: impDelta, regressingCommits, summary: impSummary },
    notes,
  }
}

export function collectComputeAndWaste(
  opts: CockpitCliOptions,
  pgCompute?: PgComputeData | null,
): ComputeAndWasteGauge {
  const notes: string[] = []
  const lights: TrafficLight[] = []
  const w7 = windowBoundsIso(opts.date, 7)

  let totalCredits: number | 'N/A' = 'N/A'
  let totalUsd: number | 'N/A' = 'N/A'
  let source = 'N/A'
  let maxDaily: number | 'N/A' = 'N/A'
  let medianDaily: number | 'N/A' = 'N/A'
  let spikeRatio: number | 'N/A' = 'N/A'
  let spikeDetected: boolean | 'N/A' = 'N/A'
  let peakDate: string | 'N/A' = 'N/A'
  let retryWasteRatio: number | 'N/A' = 'N/A'

  const costJson = safeReadJson<{
    weeklyTotalUsd?: number
    weeklyTotalCredits?: number
    dailySeries?: Array<{ date: string; value: number }>
    retryWasteRatio?: number
  }>(opts.costReportJson)

  const evalSpike = (pts: Array<{ date: string; val: number }>) => {
    if (pts.length === 0) return
    const sorted = [...pts].sort((a, b) => b.val - a.val)
    maxDaily = round4(sorted[0]!.val)
    peakDate = sorted[0]!.date
    const med = median(pts.map((p) => p.val))
    medianDaily = round4(med)
    if (med > 0) {
      spikeRatio = round4(maxDaily / med)
      spikeDetected = spikeRatio > 2.0
    } else {
      spikeDetected = false
    }
  }

  if (costJson) {
    source = 'cost-report-json'
    if (typeof costJson.weeklyTotalUsd === 'number') totalUsd = round4(costJson.weeklyTotalUsd)
    if (typeof costJson.weeklyTotalCredits === 'number') totalCredits = costJson.weeklyTotalCredits
    if (typeof costJson.retryWasteRatio === 'number') retryWasteRatio = round4(costJson.retryWasteRatio)
    if (Array.isArray(costJson.dailySeries)) {
      evalSpike(costJson.dailySeries.map((d) => ({ date: d.date, val: d.value })))
    }
  } else if (pgCompute) {
    source = 'pg:usage_records'
    totalCredits = pgCompute.totalCredits
    if (pgCompute.totalCredits > 0) {
      retryWasteRatio = round4(pgCompute.retryOrFailedCredits / pgCompute.totalCredits)
    }
    evalSpike(pgCompute.dailyCredits.map((d) => ({ date: d.day, val: d.credits })))
  }

  if (spikeDetected === true) {
    lights.push(typeof spikeRatio === 'number' && spikeRatio > 3.0 ? 'RED' : 'AMBER')
    notes.push(`Daily compute spike on ${peakDate}: ${spikeRatio}x median`)
  } else if (spikeDetected === false) {
    lights.push('GREEN')
  }

  let failedTrains7d: number | 'N/A' = 'N/A'
  let totalTrains7d: number | 'N/A' = 'N/A'
  let failedTrainRatio: number | 'N/A' = 'N/A'
  let failedDurationShare: number | 'N/A' = 'N/A'

  if (opts.leaseDb && existsSync(opts.leaseDb)) {
    const rows = querySqliteJson<TrainRow>(
      opts.leaseDb,
      'SELECT id, status, reason, created_at, started_at, finished_at, updated_at FROM train;',
    )
    if (rows !== null) {
      const terminal = new Set(['committed', 'failed', 'recovery_required'])
      const in7d = rows.filter(
        (r) => r.created_at >= w7.sinceIso && r.created_at < w7.untilIso && terminal.has(r.status),
      )
      totalTrains7d = in7d.length
      failedTrains7d = in7d.filter((r) => r.status !== 'committed').length
      if (totalTrains7d > 0) {
        failedTrainRatio = round4(failedTrains7d / totalTrains7d)
        let totalDur = 0
        let failedDur = 0
        for (const r of in7d) {
          const s = Date.parse(r.started_at ?? r.created_at)
          const e = Date.parse(r.finished_at ?? r.updated_at)
          const dur = Number.isFinite(s) && Number.isFinite(e) && e > s ? e - s : 0
          totalDur += dur
          if (r.status !== 'committed') failedDur += dur
        }
        if (totalDur > 0) failedDurationShare = round4(failedDur / totalDur)
        if (failedTrainRatio > 0.5) {
          lights.push('RED')
          notes.push(`Failed train waste ratio ${fmtPct(failedTrainRatio)} > 50%`)
        } else if (failedTrainRatio > 0.25) {
          lights.push('AMBER')
          notes.push(`Failed train waste ratio ${fmtPct(failedTrainRatio)} > 25%`)
        } else {
          lights.push('GREEN')
        }
      }
    }
  }

  if (typeof retryWasteRatio === 'number') {
    if (retryWasteRatio > 0.3) {
      lights.push('RED')
      notes.push(`Failed/retry usage waste ${fmtPct(retryWasteRatio)} > 30%`)
    } else if (retryWasteRatio > 0.15) {
      lights.push('AMBER')
    }
  }

  let costBreakerTripped: boolean | 'N/A' = 'N/A'
  if (opts.governorRoot && existsSync(opts.governorRoot)) {
    const cb = safeReadJson<{ tripped?: boolean }>(path.join(opts.governorRoot, 'control/cost-breaker.json'))
    if (cb && typeof cb.tripped === 'boolean') {
      costBreakerTripped = cb.tripped
      if (cb.tripped) {
        lights.push('RED')
        notes.push('Host Governor daily cost circuit breaker is TRIPPED')
      }
    }
  }

  return {
    status: worstLight(lights),
    weeklyConsumption: { totalCredits, totalUsd, source },
    dailySpike: { maxDailyValue: maxDaily, medianDailyValue: medianDaily, spikeRatio, spikeDetected, peakDate },
    waste: { failedTrains7d, totalTrains7d, failedTrainRatio, failedDurationShare, retryWasteRatio },
    costBreakerTripped,
    notes,
  }
}

export function collectMetaGuardrailIntegrity(opts: CockpitCliOptions): MetaGuardrailIntegrityGauge {
  const notes: string[] = []
  const lights: TrafficLight[] = []
  const w7 = windowBoundsIso(opts.date, 7)

  let interceptedAttempts: number | 'N/A' = 'N/A'
  let approvedRelaxations: number | 'N/A' = 'N/A'
  let tamperedApprovals: number | 'N/A' = 'N/A'
  let blockedAuroraAttempts: number | 'N/A' = 'N/A'
  let governorMode = 'N/A'

  if (opts.governorRoot && existsSync(opts.governorRoot)) {
    const modeJson = safeReadJson<{ mode?: string }>(path.join(opts.governorRoot, 'control/mode.json'))
    if (typeof modeJson?.mode === 'string') {
      governorMode = modeJson.mode
      if (governorMode === 'emergency_stop') {
        lights.push('RED')
        notes.push('Governor mode is emergency_stop')
      } else if (governorMode === 'debt_first') {
        lights.push('AMBER')
        notes.push('Governor mode is debt_first (feature freeze active)')
      }
    }

    const auditPath = path.join(opts.governorRoot, 'control/audit.jsonl')
    if (existsSync(auditPath)) {
      let intercepted = 0
      let approved = 0
      let auroraBlocked = 0
      for (const ev of readJsonl(auditPath)) {
        const ts = String(ev.ts ?? '')
        if (ts < w7.sinceIso || ts >= w7.untilIso) continue
        const action = String(ev.action ?? '')
        const outcome = String(ev.outcome ?? '')
        if (action === 'approve_a0' && outcome === 'ok') approved += 1
        if (
          (action === 'check_a0' || action === 'a0_tamper' || action === 'check_blast_radius') &&
          outcome === 'blocked'
        ) {
          intercepted += 1
        }
        if (
          action === 'check_blast_radius' &&
          outcome === 'blocked' &&
          String(ev.branch ?? '').includes('feat/v5-aurora-rewrite')
        ) {
          auroraBlocked += 1
        }
      }
      interceptedAttempts = intercepted
      approvedRelaxations = approved
      blockedAuroraAttempts = auroraBlocked
      lights.push(intercepted > 0 ? 'AMBER' : 'GREEN')
      if (intercepted > 0) notes.push(`Governor intercepted ${intercepted} A0/blast-radius attempt(s) in 7d`)
    }

    const approvalsDir = path.join(opts.governorRoot, 'control/a0-approvals')
    if (existsSync(approvalsDir)) {
      let tampered = 0
      for (const f of readdirSync(approvalsDir).filter((x) => x.endsWith('.json') && !x.endsWith('.gh.json'))) {
        const doc = safeReadJson<Record<string, unknown>>(path.join(approvalsDir, f))
        if (!doc || !verifyApprovalChecksum(doc)) tampered += 1
      }
      tamperedApprovals = tampered
      lights.push(tampered > 0 ? 'RED' : 'GREEN')
      if (tampered > 0) notes.push(`${tampered} A0 approval file(s) failed SHA-256 integrity check!`)
    }
  }

  const receiptDirs = [
    opts.stewardReceiptDir,
    opts.repoRoot ? path.join(opts.repoRoot, '.github/steward-receipts') : null,
    opts.governorRoot ? path.join(opts.governorRoot, 'steward-receipts') : null,
  ].filter((x): x is string => Boolean(x))

  let totalReceipts: number | 'N/A' = 'N/A'
  let validCrossFamily: number | 'N/A' = 'N/A'
  let vetoOrInvalid: number | 'N/A' = 'N/A'
  let signoffRate: number | 'N/A' = 'N/A'

  const seenFiles = new Set<string>()
  const receiptObjs: Array<Record<string, unknown>> = []
  let foundDir = false
  for (const dir of receiptDirs) {
    if (!existsSync(dir)) continue
    foundDir = true
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      if (seenFiles.has(f)) continue
      seenFiles.add(f)
      const doc = safeReadJson<Record<string, unknown>>(path.join(dir, f))
      if (!doc) continue
      const ts = String(doc.timestamp ?? (doc.usageEvidence as Record<string, unknown>)?.timestamp ?? '')
      if (ts && (ts < w7.sinceIso || ts >= w7.untilIso)) continue
      receiptObjs.push(doc)
    }
  }

  if (foundDir && receiptObjs.length > 0) {
    totalReceipts = receiptObjs.length
    let valid = 0
    let bad = 0
    for (const r of receiptObjs) {
      const af = String(r.authorFamily ?? r.devFamily ?? '')
      const sf = String(r.stewardFamily ?? r.auditFamily ?? '')
      const verdict = String(r.verdict ?? 'approve')
      if (af && sf && af !== sf && verdict === 'approve') valid += 1
      else bad += 1
    }
    validCrossFamily = valid
    vetoOrInvalid = bad
    signoffRate = round4(valid / totalReceipts)
    lights.push(bad > 0 ? 'RED' : 'GREEN')
    if (bad > 0) notes.push(`${bad} Steward receipt(s) vetoed or violated cross-family rule`)
  }

  let confirmedZero: boolean | 'N/A' = 'N/A'
  let auroraDetail = 'N/A'
  if (opts.repoRoot && existsSync(opts.repoRoot)) {
    const branch = safeGit(opts.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim()
    if (branch) {
      if (branch === 'feat/v5-aurora-rewrite') {
        confirmedZero = false
        auroraDetail = 'Workspace HEAD is checked out on protected feat/v5-aurora-rewrite!'
        lights.push('RED')
        notes.push(auroraDetail)
      } else {
        confirmedZero = true
        auroraDetail = `Active branch=${branch}; feat/v5-aurora-rewrite untouched (blocked attempts=${fmtNum(blockedAuroraAttempts)})`
        lights.push('GREEN')
      }
    }
  } else if (typeof blockedAuroraAttempts === 'number') {
    confirmedZero = true
    auroraDetail = `Governor blast-radius hard-lock active (blocked=${blockedAuroraAttempts})`
    lights.push('GREEN')
  }

  return {
    status: worstLight(lights),
    a0Audit7d: { interceptedAttempts, approvedRelaxations, tamperedApprovals },
    stewardSignoff7d: { totalReceipts, validCrossFamilyApprovals: validCrossFamily, vetoOrInvalid, signoffRate },
    commercialBranchZeroTouch: {
      branch: 'feat/v5-aurora-rewrite',
      confirmedZeroUnauthorized: confirmedZero,
      blockedAttempts7d: blockedAuroraAttempts,
      detail: auroraDetail,
    },
    governorMode,
    notes,
  }
}

function readDbUrl(envFile: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.DATABASE_URL?.trim()
  if (fromEnv) return fromEnv
  if (!envFile || !existsSync(envFile)) return null
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^DATABASE_URL=(.*)$/)
    if (!m) continue
    let val = m[1]!.trim()
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1)
    }
    return val || null
  }
  return null
}

export async function probePgReadOnly(opts: CockpitCliOptions): Promise<{
  implicit: { current7d: number; previous7d: number } | null
  compute: PgComputeData | null
}> {
  if (opts.offline) return { implicit: null, compute: null }
  const dbUrl = readDbUrl(opts.envFile)
  if (!dbUrl) return { implicit: null, compute: null }

  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 5000 })
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '15s'")
    const impRes = await client.query<{ cur_n: string; prev_n: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= ($1::date + 1) - interval '7 days' AND created_at < ($1::date + 1)) AS cur_n,
         COUNT(*) FILTER (WHERE created_at >= ($1::date + 1) - interval '14 days' AND created_at < ($1::date + 1) - interval '7 days') AS prev_n
       FROM response_rating
       WHERE rating = 'down' AND 'implicit' = ANY(tags)
         AND created_at >= ($1::date + 1) - interval '14 days' AND created_at < ($1::date + 1)`,
      [opts.date],
    )
    const dailyRes = await client.query<{ day: string; credits: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              COALESCE(SUM(COALESCE(cost_credits, 0)), 0) AS credits
         FROM usage_records
        WHERE created_at >= ($1::date + 1) - interval '7 days' AND created_at < ($1::date + 1)
        GROUP BY 1 ORDER BY 1`,
      [opts.date],
    )
    const wasteRes = await client.query<{ total_c: string; waste_c: string }>(
      `SELECT COALESCE(SUM(COALESCE(u.cost_credits, 0)), 0) AS total_c,
              COALESCE(SUM(COALESCE(u.cost_credits, 0)) FILTER (
                WHERE COALESCE(u.attempt_no, 1) > 1
                   OR (u.status IS NOT NULL AND u.status NOT IN ('success', 'ok', 'settled', 'completed'))
              ), 0) AS waste_c
         FROM usage_records u
        WHERE u.created_at >= ($1::date + 1) - interval '7 days' AND u.created_at < ($1::date + 1)`,
      [opts.date],
    )
    await client.query('ROLLBACK')
    return {
      implicit: impRes.rows[0]
        ? { current7d: Number(impRes.rows[0].cur_n ?? 0), previous7d: Number(impRes.rows[0].prev_n ?? 0) }
        : null,
      compute: {
        dailyCredits: dailyRes.rows.map((r) => ({ day: r.day, credits: Number(r.credits ?? 0) })),
        totalCredits: Number(wasteRes.rows[0]?.total_c ?? 0),
        retryOrFailedCredits: Number(wasteRes.rows[0]?.waste_c ?? 0),
      },
    }
  } catch {
    return { implicit: null, compute: null }
  } finally {
    await client.end().catch(() => {})
  }
}
