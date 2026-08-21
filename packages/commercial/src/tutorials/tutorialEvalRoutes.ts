import type { IncomingMessage, ServerResponse } from 'node:http'

import { writeAdminAuditBestEffort } from '../admin/audit.js'
import { requireAdminVerifyDb } from '../admin/requireAdmin.js'
import { HttpError, clientIpOf, readJsonBody, sendJson, userAgentOf } from '../http/util.js'
import { leakReportPublic, scanJsonValue, scanText } from './snapshotSanitizer.js'
import {
  TutorialEvalError,
  attachEvalEvidence,
  enqueueEvalJob,
  insertCaseSpec,
  insertCompassNote,
  listCaseSpecs,
  listCompassNotes,
  listEvalJobs,
  type CaseSpecDraft,
} from './tutorialEval.js'

type TutorialRouteDeps = { jwtSecret: string | Uint8Array }

function mapEvalError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (!(error instanceof TutorialEvalError)) return new HttpError(500, 'INTERNAL', 'tutorial eval error')
  if (error.code === 'BAD_SPEC') return new HttpError(400, error.code, error.message)
  if (error.code === 'NOT_FOUND') return new HttpError(404, error.code, error.message)
  if (error.code === 'FORBIDDEN') return new HttpError(403, error.code, error.message)
  return new HttpError(409, error.code, error.message)
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new HttpError(400, 'BAD_REQUEST', `${field} required`)
  const normalized = value.trim()
  if ([...normalized].length < min || [...normalized].length > max)
    throw new HttpError(400, 'BAD_REQUEST', `${field} length must be ${min}..${max}`)
  return normalized
}

function assertSanitizedAdminPayload(value: unknown, field: string): void {
  const leaks =
    typeof value === 'string' ? scanText(value, field) : scanJsonValue(value, field)
  if (leaks.length > 0) {
    throw new HttpError(400, 'LEAKS_FOUND', 'payload failed sanitizer')
  }
}

export async function handleAdminTutorialControlGet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret)
  const path = (req.url ?? '').split('?')[0] ?? ''
  res.setHeader('Cache-Control', 'private, no-store')
  if (path === '/api/admin/tutorials/case-specs') {
    sendJson(res, 200, { specs: await listCaseSpecs() })
    return
  }
  if (path === '/api/admin/tutorials/eval-jobs') {
    sendJson(res, 200, { jobs: await listEvalJobs() })
    return
  }
  if (path === '/api/admin/tutorials/compass') {
    sendJson(res, 200, { notes: await listCompassNotes() })
    return
  }
  throw new HttpError(404, 'NOT_FOUND', 'not found')
}

export async function handleAdminTutorialControlPost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TutorialRouteDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret)
  const path = (req.url ?? '').split('?')[0] ?? ''
  const body = ((await readJsonBody(req)) ?? {}) as Record<string, unknown>
  try {
    if (path === '/api/admin/tutorials/case-specs') {
      const draft: CaseSpecDraft = {
        publicId: text(body.publicId, 'publicId', 2, 80),
        title: text(body.title, 'title', 8, 160),
        sourceUrl: text(body.sourceUrl, 'sourceUrl', 8, 500),
        sourcePlatform: text(body.sourcePlatform, 'sourcePlatform', 2, 80),
        collectedAt: text(body.collectedAt, 'collectedAt', 10, 40),
        frozenPrompt: text(body.frozenPrompt, 'frozenPrompt', 20, 20000),
        frozenMaterials: body.frozenMaterials,
        authScope: 'synthetic_eval',
        rubric: body.rubric,
      }
      assertSanitizedAdminPayload(draft.frozenPrompt, 'frozenPrompt')
      assertSanitizedAdminPayload(draft.frozenMaterials, 'frozenMaterials')
      const created = await insertCaseSpec(admin.id, draft)
      await writeAdminAuditBestEffort(
        { adminId: admin.id, ip: clientIpOf(req), userAgent: userAgentOf(req) },
        'tutorial.eval',
        `tutorial_case_spec:${created.id}`,
        undefined,
        { public_id: created.publicId },
      )
      sendJson(res, 201, { spec: created })
      return
    }
    if (path === '/api/admin/tutorials/eval-jobs') {
      const specId = text(body.specId, 'specId', 1, 20)
      const idempotencyKey = text(body.idempotencyKey, 'idempotencyKey', 8, 128)
      const job = await enqueueEvalJob({
        specId,
        idempotencyKey,
        publicationId: typeof body.publicationId === 'string' ? body.publicationId : null,
        evalUserId: typeof body.evalUserId === 'string' ? body.evalUserId : null,
      })
      await writeAdminAuditBestEffort(
        { adminId: admin.id, ip: clientIpOf(req), userAgent: userAgentOf(req) },
        'tutorial.eval',
        `tutorial_eval_job:${job.id}`,
        undefined,
        { created: job.created },
      )
      sendJson(res, job.created ? 201 : 200, { job })
      return
    }
    const evidenceMatch = path.match(/^\/api\/admin\/tutorials\/eval-jobs\/([1-9]\d*)\/evidence$/)
    if (evidenceMatch) {
      const result = body.result
      if (result !== 'passed' && result !== 'failed')
        throw new HttpError(400, 'BAD_REQUEST', 'result must be passed|failed')
      assertSanitizedAdminPayload(body.evidence ?? {}, 'evidence')
      const updated = await attachEvalEvidence({
        jobId: evidenceMatch[1]!,
        evidence: body.evidence ?? {},
        result,
      })
      sendJson(res, 200, { job: { id: evidenceMatch[1], ...updated } })
      return
    }
    if (path === '/api/admin/tutorials/compass') {
      const summary = text(body.summary, 'summary', 8, 4000)
      assertSanitizedAdminPayload(summary, 'summary')
      if (typeof body.reusableFix === 'string') assertSanitizedAdminPayload(body.reusableFix, 'reusableFix')
      const note = await insertCompassNote({
        evalJobId: text(body.evalJobId, 'evalJobId', 1, 20),
        clusterKey: text(body.clusterKey, 'clusterKey', 2, 80),
        severity: text(body.severity, 'severity', 2, 2) as 'P0' | 'P1' | 'P2',
        summary,
        reusableFix: typeof body.reusableFix === 'string' ? body.reusableFix : null,
        grokModel: typeof body.grokModel === 'string' ? body.grokModel : 'cursor-grok-4.6-high',
        taskboardTicket: typeof body.taskboardTicket === 'string' ? body.taskboardTicket : null,
      })
      await writeAdminAuditBestEffort(
        { adminId: admin.id, ip: clientIpOf(req), userAgent: userAgentOf(req) },
        'tutorial.eval',
        `tutorial_compass:${note.id}`,
        undefined,
        { eval_job_id: body.evalJobId },
      )
      sendJson(res, 201, { note })
      return
    }
    throw new HttpError(404, 'NOT_FOUND', 'not found')
  } catch (error) {
    if (error instanceof HttpError && error.code === 'LEAKS_FOUND') {
      sendJson(res, 400, {
        error: { code: 'LEAKS_FOUND', message: error.message },
        leakReport: leakReportPublic(scanJsonValue(body, 'body')),
      })
      return
    }
    throw mapEvalError(error)
  }
}
