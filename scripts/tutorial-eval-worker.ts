#!/usr/bin/env tsx
/** Durable tutorial eval + compass control-plane worker. Never runs in the HTTP process. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  buildCompassDelegatePrompt,
  canonicalTutorialMaterials,
  claimCompassJob,
  claimEvalJob,
  evaluateTutorialRubric,
  finishCompassJob,
  finishEvalJob,
  hashTutorialMaterials,
  recoverExpiredEvalLeases,
  stageEvalPublication,
} from '../packages/commercial/src/tutorials/tutorialEval.ts'
import {
  CommunityTutorialError,
  getPublishedCommunityTutorial,
  reviewCommunityTutorial,
  submitSnapshotTutorial,
} from '../packages/commercial/src/tutorials/communityTutorials.ts'
import { scanJsonValue, scanText } from '../packages/commercial/src/tutorials/snapshotSanitizer.ts'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function requireArg(name: string): string {
  const value = arg(name)
  if (!value) throw new Error(`missing --${name}`)
  return value
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function parseJsonObjectFromCommand(raw: string, label: string): Record<string, unknown> {
  try {
    return parseJsonObject(raw.trim(), label)
  } catch {
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse()
    for (const line of lines) {
      if (!line.startsWith('{') || !line.endsWith('}')) continue
      try {
        return parseJsonObject(line, label)
      } catch {}
    }
    throw new Error(`${label} did not contain a JSON object line`)
  }
}

function sanitizedEvidence(value: unknown): void {
  const leaks = scanJsonValue(value, 'evidence')
  if (leaks.length > 0) throw new Error(`evidence failed sanitizer: ${JSON.stringify(leaks)}`)
}

async function ensurePublicationApproved(id: string, reviewerUserId: string): Promise<void> {
  try {
    await reviewCommunityTutorial({
      id,
      reviewerUserId,
      decision: 'approve',
      note: '测试账号实跑并通过机器 Rubric',
    })
  } catch (error) {
    if (
      error instanceof CommunityTutorialError &&
      error.code === 'NOT_PENDING' &&
      (await getPublishedCommunityTutorial(id))
    ) {
      return
    }
    throw error
  }
}

function runAgentTurn(job: NonNullable<Awaited<ReturnType<typeof claimEvalJob>>>) {
  const runner = fileURLToPath(new URL('./tutorial-eval-agent-turn.mjs', import.meta.url))
  const materialsJson = canonicalTutorialMaterials(job.spec.frozenMaterials)
  if (hashTutorialMaterials(job.spec.frozenMaterials) !== job.spec.frozenMaterialsSha256) {
    throw new Error('frozen materials hash mismatch')
  }
  const executionPrompt = [
    job.spec.frozenPrompt,
    '',
    `冻结材料 SHA-256：${job.spec.frozenMaterialsSha256}`,
    '冻结材料（必须作为本轮唯一授权材料清单）：',
    materialsJson,
  ].join('\n')
  const result = spawnSync(
    process.execPath,
    ['--experimental-websocket', runner],
    {
      input: JSON.stringify({
        uid: Number(job.evalUserId),
        caseId: job.spec.publicId,
        prompt: executionPrompt,
        model: arg('model') ?? 'glm-5.3-zai',
        agentId: arg('agent') ?? 'main',
        baseUrl: arg('base-url') ?? 'http://127.0.0.1:18790',
      }),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 31 * 60_000,
      env: process.env,
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`agent runner failed (${result.status}): ${(result.stderr || result.stdout).slice(0, 1000)}`)
  }
  const output = parseJsonObject(result.stdout, 'agent runner output')
  if (
    typeof output.sourceSessionId !== 'string' ||
    typeof output.finalText !== 'string' ||
    !Number.isFinite(output.wallMs)
  ) {
    throw new Error('agent runner output incomplete')
  }
  return output as {
    sourceSessionId: string
    finalText: string
    wallMs: number
  }
}

async function runEval(): Promise<void> {
  const ownerId = requireArg('owner')
  const job = await claimEvalJob({ ownerId })
  if (!job) {
    console.log(JSON.stringify({ claimed: false }))
    return
  }
  if (job.publicationId && job.result === 'passed_staged') {
    await ensurePublicationApproved(job.publicationId, job.spec.createdBy)
    const finished = await finishEvalJob({
      jobId: job.id,
      fencingToken: job.fencingToken,
      result: 'passed',
      evidence: job.evidence ?? {},
      publicationId: job.publicationId,
    })
    console.log(JSON.stringify({ claimed: true, resumed: true, publicationId: job.publicationId, ...finished }))
    return
  }

  let turn: ReturnType<typeof runAgentTurn>
  try {
    turn = runAgentTurn(job)
  } catch (error) {
    const evidence = {
      schemaVersion: 1,
      phase: 'agent_turn',
      errorClass: error instanceof Error ? error.name : 'Error',
    }
    await finishEvalJob({
      jobId: job.id,
      fencingToken: job.fencingToken,
      result: 'failed',
      evidence,
      errorCode: 'agent_turn_failed',
    })
    console.log(JSON.stringify({ claimed: true, status: 'compass_pending', errorCode: 'agent_turn_failed' }))
    return
  }
  const rubric = evaluateTutorialRubric(job.spec.rubric, turn.finalText)
  const evidence = {
    schemaVersion: 1,
    sourcePlatform: job.spec.sourcePlatform,
    collectedAt: job.spec.collectedAt,
    sourceSessionIdHash: createHash('sha256').update(turn.sourceSessionId).digest('hex'),
    outputSha256: createHash('sha256').update(turn.finalText).digest('hex'),
    outputChars: turn.finalText.length,
    wallMs: turn.wallMs,
    rubric,
  }
  sanitizedEvidence(evidence)
  if (!rubric.passed) {
    await finishEvalJob({
      jobId: job.id,
      fencingToken: job.fencingToken,
      result: 'failed',
      evidence,
      errorCode: 'rubric_failed',
    })
    console.log(JSON.stringify({ claimed: true, status: 'compass_pending', rubric }))
    return
  }

  try {
    const summary = `测试账号实跑并通过 ${rubric.checks.length} 条机器 Rubric：${job.spec.title}`.slice(0, 280)
    const publication = await submitSnapshotTutorial(job.evalUserId, {
      title: job.spec.title.slice(0, 100),
      summary: summary.length >= 10 ? summary : `实跑通过：${job.spec.title}`,
      category: 'general',
      bodyMarkdown: `来源：${job.spec.sourcePlatform}（${job.spec.sourceUrl}）。本教程由隔离测试账号按冻结 prompt 实跑，并通过机器 Rubric 后自动发布。`,
      sourceSessionId: turn.sourceSessionId,
      selectedArtifacts: [],
    })
    await stageEvalPublication({
      jobId: job.id,
      fencingToken: job.fencingToken,
      publicationId: publication.id,
      evidence,
    })
    await ensurePublicationApproved(publication.id, job.spec.createdBy)
    const finished = await finishEvalJob({
      jobId: job.id,
      fencingToken: job.fencingToken,
      result: 'passed',
      evidence,
      publicationId: publication.id,
    })
    console.log(JSON.stringify({ claimed: true, publicationId: publication.id, ...finished }))
  } catch (error) {
    await finishEvalJob({
      jobId: job.id,
      fencingToken: job.fencingToken,
      result: 'failed',
      evidence,
      errorCode: 'publication_failed',
    })
    console.log(JSON.stringify({ claimed: true, status: 'compass_pending', errorCode: 'publication_failed' }))
  }
}

async function runCompass(): Promise<void> {
  const job = await claimCompassJob({ ownerId: requireArg('owner') })
  if (!job) {
    console.log(JSON.stringify({ claimed: false }))
    return
  }
  const prompt = buildCompassDelegatePrompt({
    jobId: job.id,
    specTitle: job.specTitle,
    errorCode: job.errorCode,
    evidenceSummary: JSON.stringify(job.evidence ?? {}).slice(0, 3000),
  })
  const binary = process.env.OC_TUTORIAL_COMPASS_BIN || 'oc-memory'
  const delegated = spawnSync(
    binary,
    ['delegate', '--model', 'cursor-grok-4.6-high', '--goal', prompt],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30 * 60_000 },
  )
  if (delegated.error || delegated.status !== 0) {
    throw delegated.error ?? new Error(`compass delegate failed (${delegated.status})`)
  }
  const parsed = parseJsonObjectFromCommand(delegated.stdout, 'compass delegate output')
  const clusterKey = String(parsed.cluster_key ?? '')
  const severity = String(parsed.severity ?? '')
  const summary = String(parsed.summary ?? '')
  const reusableFix = String(parsed.reusable_fix ?? '')
  if (!clusterKey || !['P0', 'P1', 'P2'].includes(severity) || !summary) {
    throw new Error('compass delegate JSON incomplete')
  }
  const compassLeaks = [
    ...scanText(clusterKey, 'clusterKey'),
    ...scanText(summary, 'summary'),
    ...scanText(reusableFix, 'reusableFix'),
  ]
  if (compassLeaks.length > 0) throw new Error(`compass output failed sanitizer: ${JSON.stringify(compassLeaks)}`)
  const note = await finishCompassJob({
    jobId: job.id,
    fencingToken: job.fencingToken,
    clusterKey,
    severity: severity as 'P0' | 'P1' | 'P2',
    summary,
    reusableFix: reusableFix || null,
    grokModel: 'cursor-grok-4.6-high',
  })
  console.log(JSON.stringify({ claimed: true, status: 'compass_ready', noteId: note.id }))
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'recover') {
    console.log(JSON.stringify({ recovered: await recoverExpiredEvalLeases() }))
    return
  }
  if (command === 'run') return runEval()
  if (command === 'compass') return runCompass()
  if (command === 'finish') {
    const evidence = arg('evidence') ? JSON.parse(readFileSync(requireArg('evidence'), 'utf8')) : {}
    sanitizedEvidence(evidence)
    const result = requireArg('result')
    if (result !== 'passed' && result !== 'failed') throw new Error('result must be passed|failed')
    console.log(JSON.stringify(await finishEvalJob({
      jobId: requireArg('job'),
      fencingToken: requireArg('token'),
      result,
      evidence,
      errorCode: arg('error') ?? (result === 'failed' ? 'eval_failed' : null),
    })))
    return
  }
  throw new Error('usage: tutorial-eval-worker.ts run|compass|finish|recover')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
