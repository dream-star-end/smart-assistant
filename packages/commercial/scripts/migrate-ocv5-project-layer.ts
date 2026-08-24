#!/usr/bin/env tsx
/**
 * OCV5 project-layer migration coordinator CLI.
 * Default is dry-run. --apply is refused unless OPENCLAUDE_PROJECT_LAYER_APPLY=1.
 * Live PG is read via host python (no DATABASE_URL in the container).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import {
  OCV5_DEFAULT_BOARD_ID,
  applyProjectLayerMigration,
  assertPlanApplyable,
  planProjectLayerMigration,
  type ProjectLayerInventory,
} from '../../storage/src/projectLayerMigrate.js'
import {
  assertCanonicalReadyForApply,
  containerToHostPath,
  fetchLiveSnapshot,
  makeApplyPorts,
  openLiveReadHandle,
  portsFromSnapshot,
  writeManifestPath,
  applyArmed,
} from '../src/projectLayerHostPorts.js'

async function sha256MaybeTranslate(absPath: string): Promise<string> {
  const attempts = [absPath]
  try {
    attempts.push(containerToHostPath(absPath))
  } catch {
    /* path is already host-rooted */
  }
  let last: unknown
  for (const p of attempts) {
    try {
      const buf = await readFile(p)
      return createHash('sha256').update(buf).digest('hex')
    } catch (err) {
      last = err
    }
  }
  throw last instanceof Error ? last : new Error(`sha256_failed:${absPath}`)
}

function arg(argv: string[], name: string, fallback = ''): string {
  const i = argv.indexOf(name)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  const pref = `${name}=`
  const hit = argv.find((a) => a.startsWith(pref))
  return hit ? hit.slice(pref.length) : fallback
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name)
}

const argv = process.argv
if (has(argv, '--apply') && !applyArmed()) {
  console.error('refuse --apply: OPENCLAUDE_PROJECT_LAYER_APPLY!=1 (this round is dry-run only)')
  process.exit(2)
}

const inventoryPath = arg(argv, '--inventory')
const target = arg(argv, '--target', OCV5_DEFAULT_BOARD_ID)
const outPath = arg(argv, '--out', '')
const script = openLiveReadHandle({
  explicit: arg(argv, '--live-read-script') || undefined,
  kind: 'host',
})

if (!inventoryPath) {
  console.error('--inventory <json> is required')
  process.exit(2)
}

const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as ProjectLayerInventory
const bindIds = inventory.sessionMapping.bind_to_ocv5_chat?.ids ?? inventory.sessionMapping.sessions.map((s) => s.id)
if (!bindIds.length) {
  console.error('inventory has no session ids')
  process.exit(2)
}

const snap = await fetchLiveSnapshot({
  sessionIds: bindIds,
  boardProjectId: target,
  script,
})

if (!snap.readonly) {
  console.error('live snapshot is not readonly')
  process.exit(2)
}

const livePorts = portsFromSnapshot(snap)
const ports = {
  ...livePorts,
  sha256File: sha256MaybeTranslate,
}

const plan = await planProjectLayerMigration({
  inventory,
  targetBoardProjectId: target,
  ports,
  agentUid: 1000,
  agentGid: 1000,
})

if (!plan.usageBackfill.queried) {
  console.error('usage live-read did not run; refusing empty rowIds placeholder')
  process.exit(2)
}

const counts = {
  applySessions: plan.defaultApplySessionIds.length,
  manualReview: plan.expectedCounts.actualManualReview,
  manualReviewRows: plan.expectedCounts.actualManualReviewRows,
  assets: plan.operations.filter((o) => o.op === 'create_asset').length,
  memory: plan.operations.filter((o) => o.op === 'copy_memory_candidate').length,
  skills: plan.operations.find((o) => o.op === 'skill_overlay'),
  usageRows: plan.usageBackfill.rowIds.length,
  cronImpact: plan.cronImpact.length,
  liveAssets: snap.assets.length,
  liveSessions: snap.sessions.length,
  usageBoardColumn: snap.usageBoardColumn,
}

const envelope = {
  ...plan,
  liveRead: {
    generatedAt: snap.generatedAt,
    usageBoardColumn: snap.usageBoardColumn,
    chatProjects: snap.chatProjects,
    cronJobs: snap.cron,
    assets: snap.assets,
    projectContext: snap.projectContext,
    applyModesWired: snap.applyModesWired ?? [
      'apply-create-facade',
      'apply-bind-facade',
      'apply-move-sessions',
      'apply-usage-backfill',
      'apply-usage-restore',
      'apply-create-asset',
      'apply-delete-asset',
    ],
  },
  counts,
}

const text = JSON.stringify(envelope, null, 2)
if (outPath) {
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, text)
}
const manifest = writeManifestPath(plan.operationId)
await mkdir(dirname(manifest), { recursive: true })
await writeFile(manifest, text)

if (has(argv, '--apply')) {
  assertCanonicalReadyForApply(script)
  const liveAgain = await fetchLiveSnapshot({
    sessionIds: bindIds,
    boardProjectId: target,
    script,
  })
  const applyPlan = await planProjectLayerMigration({
    inventory,
    targetBoardProjectId: target,
    ports: {
      ...portsFromSnapshot(liveAgain),
      sha256File: sha256MaybeTranslate,
    },
    agentUid: 1000,
    agentGid: 1000,
  })
  assertPlanApplyable(applyPlan)
  if (applyPlan.live.boardArchived || !applyPlan.live.boardExists || !applyPlan.live.facadeUnique) {
    console.error('apply precheck failed: board/facade')
    process.exit(2)
  }
  const defer = arg(argv, '--defer-session')
  if (defer) {
    for (const op of applyPlan.operations) {
      if (op.op === 'move_sessions') {
        op.ids = op.ids.filter((id) => id !== defer)
        op.expected = op.expected.filter((row) => row.id !== defer)
      }
      if (op.op === 'usage_backfill') {
        op.sessionIds = op.sessionIds.filter((id) => id !== defer)
        const keep = new Set(op.sessionIds)
        const rows = applyPlan.usageBackfill.rows.filter(
          (row) => keep.has(row.sessionId || '') || keep.has(row.parentSessionId || ''),
        )
        applyPlan.usageBackfill.rows = rows
        applyPlan.usageBackfill.rowIds = rows.map((row) => row.id)
        op.rowIds = applyPlan.usageBackfill.rowIds
      }
    }
    applyPlan.defaultApplySessionIds = applyPlan.defaultApplySessionIds.filter((id) => id !== defer)
    console.error(`defer session ${defer}: first op moves ${applyPlan.defaultApplySessionIds.length}`)
  }
  const applyPorts = makeApplyPorts({
    boardProjectId: target,
    snapshot: liveAgain,
    script,
    inventory,
  })
  const result = await applyProjectLayerMigration(applyPlan, applyPorts)
  const resultPath = outPath || writeManifestPath(`${applyPlan.operationId}-result`)
  await mkdir(dirname(resultPath), { recursive: true })
  await writeFile(resultPath, JSON.stringify({ plan: applyPlan, result, deferred: defer || null }, null, 2))
  if (!result.ok) {
    console.error(`apply failed: ${result.error}`)
    process.exit(2)
  }
  console.error(`apply ok operationId=${result.operationId} applied=${result.applied.length} deferred=${defer || 'none'}`)
  process.exit(0)
}

console.log(text)
console.error(
  `dry-run operationId=${plan.operationId} applySessions=${counts.applySessions} manualReview=${counts.manualReview} assets=${counts.assets} memory=${counts.memory} usageRows=${counts.usageRows} cronImpact=${counts.cronImpact} drifted=${plan.expectedCounts.drifted} queried=${plan.usageBackfill.queried}`,
)
