import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { DurableCodexBilling } from '@openclaude/protocol'
import { paths } from '@openclaude/storage'
import { request as undiciRequest } from 'undici'

import type { AutoDreamOptimizerProposal, AutoDreamPlatformFinding } from './autoDreamOptimizer.js'
import type { CodexProviderConfigOverride } from './engine/codexShared.js'

const ADMIT_PATH = '/internal/v3/auto-dream/admit'
const SETTLE_PATH = '/internal/v3/auto-dream/settle'
const ABANDON_PATH = '/internal/v3/auto-dream/abandon'
const FINDINGS_PATH = '/internal/v3/auto-dream/findings'
const ACTION_PATH = '/internal/v3/auto-dream/action'
const MAX_RESPONSE_BYTES = 128 * 1024

interface BillingQueue {
  schemaVersion: 1
  pending: DurableCodexBilling[]
}

interface FindingQueueEntry {
  runId: string
  agentId: string
  findings: AutoDreamPlatformFinding[]
  rawFindings: AutoDreamPlatformFinding[]
  nextOffset: number
  rawNextOffset: number
}

interface FindingQueue {
  schemaVersion: 2
  pending: FindingQueueEntry[]
}

export type AutoDreamBillingStage = 'durable' | 'settled'

export interface AutoDreamAdmission {
  requestId: string
  engineSessionId: string
  routeFrame: CodexProviderConfigOverride
}

export class AutoDreamOptimizerClient {
  private readonly billingMemory = new Map<string, Map<string, DurableCodexBilling>>()
  private readonly billingSerial = new Map<string, Promise<void>>()
  private readonly billingRetryTimers = new Map<string, NodeJS.Timeout>()
  private readonly findingSerial = new Map<string, Promise<void>>()
  private readonly findingRetryTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetcher: typeof undiciRequest = undiciRequest,
  ) {}

  async admit(input: {
    runId: string
    callId: string
    agentId: string
    model: string
  }): Promise<AutoDreamAdmission> {
    await this.retryPending(input.agentId)
    await this.flushPendingFindings(input.agentId)
    const result = await this.post(ADMIT_PATH, {
      runId: input.runId,
      callId: input.callId,
      agentId: input.agentId,
      model: input.model,
    })
    if (
      typeof result.requestId !== 'string' ||
      !/^[0-9a-f]{32}$/.test(result.requestId) ||
      typeof result.engineSessionId !== 'string' ||
      !result.routeFrame ||
      typeof result.routeFrame !== 'object' ||
      Array.isArray(result.routeFrame)
    ) {
      throw new Error('AUTO_DREAM_ADMISSION_INVALID')
    }
    return {
      requestId: result.requestId,
      engineSessionId: result.engineSessionId,
      routeFrame: result.routeFrame as unknown as CodexProviderConfigOverride,
    }
  }

  /**
   * Establishes a durable billing boundary before the caller may forget the
   * Codex billing frame. If local persistence is unavailable, a successful
   * master settlement is itself the durable boundary. If both paths fail, the
   * process retains the frame, retries it, and blocks later paid admissions.
   */
  async stageBilling(
    agentId: string,
    billing: DurableCodexBilling,
  ): Promise<AutoDreamBillingStage> {
    return await this.withAgentSerial(this.billingSerial, agentId, async () => {
      this.rememberBilling(agentId, billing)
      try {
        await this.persistBillingLocally(agentId, billing)
        this.forgetBilling(agentId, billing.requestId)
        return 'durable'
      } catch (stageError) {
        try {
          await this.post(SETTLE_PATH, billing)
          this.forgetBilling(agentId, billing.requestId)
          return 'settled'
        } catch (settleError) {
          this.scheduleBillingRetry(agentId)
          throw new AggregateError(
            [stageError, settleError],
            'AUTO_DREAM_BILLING_EVIDENCE_UNCOMMITTED',
          )
        }
      }
    })
  }

  async settleStaged(
    agentId: string,
    billing: DurableCodexBilling,
    stage: AutoDreamBillingStage,
  ): Promise<void> {
    if (stage === 'settled') return
    await this.withAgentSerial(this.billingSerial, agentId, async () => {
      try {
        await this.post(SETTLE_PATH, billing)
        const queue = await readQueue(agentId)
        queue.pending = queue.pending.filter((row) => row.requestId !== billing.requestId)
        await writeQueue(agentId, queue)
      } catch (err) {
        this.scheduleBillingRetry(agentId)
        throw err
      }
    })
  }

  async settle(agentId: string, billing: DurableCodexBilling): Promise<void> {
    const stage = await this.stageBilling(agentId, billing)
    await this.settleStaged(agentId, billing, stage)
  }

  async abandon(requestId: string): Promise<void> {
    await this.post(ABANDON_PATH, { requestId })
  }

  async reportFindings(input: {
    runId: string
    agentId: string
    findings: AutoDreamPlatformFinding[]
    rawFindings?: AutoDreamPlatformFinding[]
  }): Promise<void> {
    await this.withAgentSerial(this.findingSerial, input.agentId, async () => {
      const queue = await readFindingQueue(input.agentId)
      const existing = queue.pending.find((row) => row.runId === input.runId)
      if (existing) {
        existing.findings = input.findings
        existing.rawFindings = input.rawFindings ?? []
      } else {
        queue.pending.push({
          runId: input.runId,
          agentId: input.agentId,
          findings: input.findings,
          rawFindings: input.rawFindings ?? [],
          nextOffset: 0,
          rawNextOffset: 0,
        })
      }
      await writeFindingQueue(input.agentId, queue)
      try {
        await this.flushPendingFindingsUnlocked(input.agentId)
      } catch {
        this.scheduleFindingRetry(input.agentId)
      }
    })
  }

  async applyMasterProposal(
    proposal: AutoDreamOptimizerProposal,
  ): Promise<{ ok: true; result?: string } | { ok: false; conflict: string }> {
    if (proposal.action !== 'preference.patch') {
      throw new Error('AUTO_DREAM_MASTER_ACTION_UNSUPPORTED')
    }
    const result = await this.post(ACTION_PATH, {
      action: proposal.action,
      proposalId: proposal.id,
      targetId: proposal.targetId,
      beforeFingerprint: proposal.beforeFingerprint,
      after: proposal.after,
    })
    if (result.ok === false && typeof result.conflict === 'string') {
      return { ok: false, conflict: result.conflict }
    }
    return { ok: true, result: typeof result.result === 'string' ? result.result : undefined }
  }

  async retryPending(agentId: string): Promise<void> {
    await this.withAgentSerial(this.billingSerial, agentId, async () => {
      await this.flushMemoryBilling(agentId)
      const queue = await readQueue(agentId)
      if (queue.pending.length === 0) {
        this.clearBillingRetry(agentId)
        return
      }
      const remaining: DurableCodexBilling[] = []
      for (const billing of queue.pending) {
        try {
          await this.post(SETTLE_PATH, billing)
        } catch {
          remaining.push(billing)
        }
      }
      if (remaining.length !== queue.pending.length) {
        await writeQueue(agentId, { schemaVersion: 1, pending: remaining })
      }
      if (remaining.length > 0) {
        this.scheduleBillingRetry(agentId)
        throw new Error('AUTO_DREAM_BILLING_RECOVERY_PENDING')
      }
      this.clearBillingRetry(agentId)
    })
  }

  private rememberBilling(agentId: string, billing: DurableCodexBilling): void {
    let pending = this.billingMemory.get(agentId)
    if (!pending) {
      pending = new Map()
      this.billingMemory.set(agentId, pending)
    }
    pending.set(billing.requestId, billing)
  }

  private forgetBilling(agentId: string, requestId: string): void {
    const pending = this.billingMemory.get(agentId)
    pending?.delete(requestId)
    if (pending?.size === 0) this.billingMemory.delete(agentId)
  }

  private async persistBillingLocally(
    agentId: string,
    billing: DurableCodexBilling,
  ): Promise<void> {
    const queue = await readQueue(agentId)
    const index = queue.pending.findIndex((row) => row.requestId === billing.requestId)
    if (index >= 0) queue.pending[index] = billing
    else queue.pending.push(billing)
    await writeQueue(agentId, queue)
  }

  private async flushMemoryBilling(agentId: string): Promise<void> {
    const pending = this.billingMemory.get(agentId)
    if (!pending || pending.size === 0) return
    for (const billing of [...pending.values()]) {
      try {
        await this.persistBillingLocally(agentId, billing)
        this.forgetBilling(agentId, billing.requestId)
        continue
      } catch {
        // The master settlement below is the alternate durable boundary.
      }
      try {
        await this.post(SETTLE_PATH, billing)
        this.forgetBilling(agentId, billing.requestId)
      } catch {
        // Keep the frame under the process-level owner and block new admissions.
      }
    }
    if (this.billingMemory.get(agentId)?.size) {
      this.scheduleBillingRetry(agentId)
      throw new Error('AUTO_DREAM_BILLING_RECOVERY_PENDING')
    }
  }

  private scheduleBillingRetry(agentId: string): void {
    if (this.billingRetryTimers.has(agentId)) return
    const timer = setTimeout(() => {
      this.billingRetryTimers.delete(agentId)
      void this.retryPending(agentId).catch(() => this.scheduleBillingRetry(agentId))
    }, 60_000)
    timer.unref?.()
    this.billingRetryTimers.set(agentId, timer)
  }

  private clearBillingRetry(agentId: string): void {
    const timer = this.billingRetryTimers.get(agentId)
    if (timer) clearTimeout(timer)
    this.billingRetryTimers.delete(agentId)
  }

  private async flushPendingFindings(agentId: string): Promise<void> {
    await this.withAgentSerial(this.findingSerial, agentId, async () => {
      await this.flushPendingFindingsUnlocked(agentId)
    })
  }

  private async flushPendingFindingsUnlocked(agentId: string): Promise<void> {
    const queue = await readFindingQueue(agentId)
    while (queue.pending.length > 0) {
      const entry = queue.pending[0]!
      while (entry.rawNextOffset < entry.rawFindings.length) {
        const batch = entry.rawFindings.slice(entry.rawNextOffset, entry.rawNextOffset + 128)
        await this.post(FINDINGS_PATH, {
          runId: entry.runId,
          agentId: entry.agentId,
          findings: [],
          rawFindings: batch,
        })
        entry.rawNextOffset += batch.length
        await writeFindingQueue(agentId, queue)
      }
      while (entry.nextOffset < entry.findings.length) {
        const batch = entry.findings.slice(entry.nextOffset, entry.nextOffset + 128)
        await this.post(FINDINGS_PATH, {
          runId: entry.runId,
          agentId: entry.agentId,
          findings: batch,
          rawFindings: [],
        })
        entry.nextOffset += batch.length
        await writeFindingQueue(agentId, queue)
      }
      queue.pending.shift()
      await writeFindingQueue(agentId, queue)
    }
    const timer = this.findingRetryTimers.get(agentId)
    if (timer) clearTimeout(timer)
    this.findingRetryTimers.delete(agentId)
  }

  private async withAgentSerial<T>(
    serial: Map<string, Promise<void>>,
    agentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = serial.get(agentId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prior.catch(() => {}).then(() => gate)
    serial.set(agentId, tail)
    await prior.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (serial.get(agentId) === tail) serial.delete(agentId)
    }
  }

  private scheduleFindingRetry(agentId: string): void {
    if (this.findingRetryTimers.has(agentId)) return
    const timer = setTimeout(() => {
      this.findingRetryTimers.delete(agentId)
      void this.flushPendingFindings(agentId).catch(() => this.scheduleFindingRetry(agentId))
    }, 60_000)
    timer.unref?.()
    this.findingRetryTimers.set(agentId, timer)
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const base = this.env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim().replace(/\/+$/, '')
    const token = this.env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
    if (!base || !token) throw new Error('AUTO_DREAM_MASTER_NOT_CONFIGURED')
    const response = await this.fetcher(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const chunks: Buffer[] = []
    let size = 0
    for await (const raw of response.body) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      size += chunk.length
      if (size > MAX_RESPONSE_BYTES) throw new Error('AUTO_DREAM_MASTER_RESPONSE_TOO_LARGE')
      chunks.push(chunk)
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const code =
        parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
          ? (parsed.error as Record<string, unknown>).code
          : undefined
      throw new Error(
        typeof code === 'string' ? code : `AUTO_DREAM_MASTER_HTTP_${response.statusCode}`,
      )
    }
    return parsed
  }
}

async function readQueue(agentId: string): Promise<BillingQueue> {
  try {
    const raw = JSON.parse(await readFile(paths.agentAutoDreamOptimizerBilling(agentId), 'utf8')) as
      | Partial<BillingQueue>
      | undefined
    if (raw?.schemaVersion !== 1 || !Array.isArray(raw.pending)) {
      throw new Error('AUTO_DREAM_BILLING_QUEUE_INVALID')
    }
    return { schemaVersion: 1, pending: raw.pending }
  } catch (err) {
    if (isNotFound(err)) return { schemaVersion: 1, pending: [] }
    throw err
  }
}

async function writeQueue(agentId: string, queue: BillingQueue): Promise<void> {
  await writeDurableJson(paths.agentAutoDreamOptimizerBilling(agentId), queue)
}

async function readFindingQueue(agentId: string): Promise<FindingQueue> {
  try {
    const raw = JSON.parse(
      await readFile(paths.agentAutoDreamOptimizerFindings(agentId), 'utf8'),
    ) as
      | Partial<FindingQueue>
      | {
          schemaVersion?: 1
          pending?: Array<{
            runId?: unknown
            agentId?: unknown
            findings?: unknown
            nextOffset?: unknown
          }>
        }
      | undefined
    if (!raw || !Array.isArray(raw.pending)) {
      throw new Error('AUTO_DREAM_FINDING_QUEUE_INVALID')
    }
    if (raw.schemaVersion === 2) {
      const pending = raw.pending as FindingQueueEntry[]
      if (
        pending.some(
          (entry) =>
            !Array.isArray(entry.findings) ||
            !Array.isArray(entry.rawFindings) ||
            !Number.isInteger(entry.nextOffset) ||
            !Number.isInteger(entry.rawNextOffset),
        )
      ) {
        throw new Error('AUTO_DREAM_FINDING_QUEUE_INVALID')
      }
      return { schemaVersion: 2, pending }
    }
    if (raw.schemaVersion === 1) {
      const legacy = raw.pending as Array<{
        runId: string
        agentId: string
        findings: AutoDreamPlatformFinding[]
        nextOffset: number
      }>
      if (
        legacy.some(
          (entry) => !Array.isArray(entry.findings) || !Number.isInteger(entry.nextOffset),
        )
      ) {
        throw new Error('AUTO_DREAM_FINDING_QUEUE_INVALID')
      }
      return {
        schemaVersion: 2,
        pending: legacy.map((entry) => ({
          ...entry,
          rawFindings: [],
          rawNextOffset: 0,
        })),
      }
    }
    throw new Error('AUTO_DREAM_FINDING_QUEUE_INVALID')
  } catch (err) {
    if (isNotFound(err)) return { schemaVersion: 2, pending: [] }
    throw err
  }
}

async function writeFindingQueue(agentId: string, queue: FindingQueue): Promise<void> {
  await writeDurableJson(paths.agentAutoDreamOptimizerFindings(agentId), queue)
}

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  const file = await open(tmp, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(tmp, path)
  const dir = await open(dirname(path), 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}

function isNotFound(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT'
}
