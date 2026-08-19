import { createHash } from 'node:crypto'
import {
  PROMPT_QUEUE_MAX_TOTAL_CONTENT_BYTES,
  type PromptQueueMutationFrame,
  type PromptQueueSnapshot,
  PromptQueueSnapshot as PromptQueueSnapshotSchema,
} from '@openclaude/protocol'
import { Value } from '@sinclair/typebox/value'
import { request as undiciRequest } from 'undici'

export const PROMPT_QUEUE_MUTATION_PATH = '/internal/v5/prompt-queue/mutation'
export const PROMPT_QUEUE_SNAPSHOT_PATH = '/internal/v5/prompt-queue/snapshot'
export const PROMPT_QUEUE_DETAIL_PATH = '/internal/v5/prompt-queue/detail'
export const PROMPT_QUEUE_CLAIM_PATH = '/internal/v5/prompt-queue/claim'

const SMALL_RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024
const DETAIL_RESPONSE_LIMIT_BYTES = PROMPT_QUEUE_MAX_TOTAL_CONTENT_BYTES + 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15_000
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/
const POSITIVE_USER_ID_RE = /^[1-9][0-9]*$/
const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const HASH_RE = /^[0-9a-f]{64}$/
const MEDIA_URL_RE = /^\/api\/media\/[0-9a-f]{64}\.[A-Za-z0-9]{1,32}$/

export interface PromptQueueWireOwner {
  sessionKey: string
  clientSessionId: string
  agentId: string
  peer: { id: string; kind: 'dm' }
}

export interface PromptQueueDetail {
  owner: PromptQueueSnapshot['owner']
  snapshotVersion: string
  itemId: string
  clientMessageId: string
  state: string
  content: Record<string, unknown>
  contentHash: string
  contentBytes: string
  attachments: Array<{
    ordinal: number
    kind: string
    url: string
    mimeType?: string
    filename?: string
    hidden?: boolean
    contentSha256?: string
    sizeBytes?: string
  }>
  requestedExecution: {
    agentId: string
    model?: string
    modelSwitchId?: string
    effortLevel?: string | null
    teamMode?: boolean
  }
  deliveryIntent?: {
    mode?: string
    expectedTurnId?: string
    idempotencyKey?: string
  }
  deliveryToken?: string
  engineReceipt?: Record<string, unknown>
  blockedReasonCode?: string
  createdAt: number
  updatedAt: number
}

export type PromptQueueClaimRequest =
  | { action: 'acquire'; expectedVersion: string }
  | {
      action: 'release'
      epoch: string
      claimToken: string
      disposition: 'retryable' | 'user_action_required'
      reasonCode?: string
    }
  | {
      action: 'activate'
      epoch: string
      claimToken: string
      turnId: string
      turnIndex: number
      traceId?: string
      steerDelivery: 'native' | 'fork-native' | 'turn-boundary'
    }
  | { action: 'complete'; turnId: string; turnIndex: number }
  | { action: 'interrupt_ack'; turnId: string }

export interface PromptQueueClaimResult {
  snapshot: PromptQueueSnapshot
  claim?: {
    itemId: string
    epoch: string
    claimToken: string
    leaseUntil: number
    renewed: boolean
  }
  outcome:
    | 'acquired'
    | 'renewed'
    | 'released'
    | 'activated'
    | 'completed'
    | 'interrupt_acknowledged'
    | 'empty'
    | 'rejected'
  code?: string
}

export interface PromptQueueClientApi {
  mutate(
    owner: PromptQueueWireOwner,
    mutation: PromptQueueMutationFrame,
  ): Promise<{
    snapshot: PromptQueueSnapshot
    deliveryToken?: string
  }>
  snapshot(owner: PromptQueueWireOwner): Promise<PromptQueueSnapshot>
  detail(owner: PromptQueueWireOwner, itemId: string): Promise<PromptQueueDetail>
  claim(
    owner: PromptQueueWireOwner,
    claim: PromptQueueClaimRequest,
  ): Promise<PromptQueueClaimResult>
}

export interface PromptQueueClientConfig {
  baseUrl: string
  bearer: string
  userId: string
}

export function readPromptQueueClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): PromptQueueClientConfig | null {
  if (env.OC_PROMPT_QUEUE_V1 !== '1') return null
  const baseUrl = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim().replace(/\/+$/, '')
  const bearer = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  const userId = env.OC_USER_ID?.trim()
  if (!baseUrl || !bearer || !userId || !POSITIVE_USER_ID_RE.test(userId)) return null
  return { baseUrl, bearer, userId }
}

export class PromptQueueClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PromptQueueClientError'
  }
}

export class HttpPromptQueueClient implements PromptQueueClientApi {
  constructor(private readonly config: PromptQueueClientConfig) {}

  async mutate(owner: PromptQueueWireOwner, mutation: PromptQueueMutationFrame) {
    const body = await this.post(PROMPT_QUEUE_MUTATION_PATH, { owner, mutation })
    assertOnlyKeys(body, ['ok', 'snapshot', 'deliveryToken'], 'mutation response')
    const snapshot = parseSnapshot(body.snapshot, owner, this.config.userId)
    if (body.deliveryToken !== undefined) assertString(body.deliveryToken, HASH_RE, 'deliveryToken')
    return {
      snapshot,
      ...(typeof body.deliveryToken === 'string' ? { deliveryToken: body.deliveryToken } : {}),
    }
  }

  async snapshot(owner: PromptQueueWireOwner): Promise<PromptQueueSnapshot> {
    const body = await this.post(PROMPT_QUEUE_SNAPSHOT_PATH, { owner })
    assertOnlyKeys(body, ['ok', 'snapshot'], 'snapshot response')
    return parseSnapshot(body.snapshot, owner, this.config.userId)
  }

  async detail(owner: PromptQueueWireOwner, itemId: string): Promise<PromptQueueDetail> {
    const body = await this.post(
      PROMPT_QUEUE_DETAIL_PATH,
      { owner, itemId },
      DETAIL_RESPONSE_LIMIT_BYTES,
    )
    assertOnlyKeys(body, ['ok', 'detail'], 'detail response')
    return parseDetail(body.detail, owner, this.config.userId, itemId)
  }

  async claim(
    owner: PromptQueueWireOwner,
    claim: PromptQueueClaimRequest,
  ): Promise<PromptQueueClaimResult> {
    const body = await this.post(PROMPT_QUEUE_CLAIM_PATH, { owner, claim })
    return parseClaimResult(body, owner, this.config.userId)
  }

  private async post(
    path: string,
    value: unknown,
    responseLimit = SMALL_RESPONSE_LIMIT_BYTES,
  ): Promise<Record<string, unknown>> {
    const serialized = JSON.stringify(value)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await undiciRequest(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.bearer}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(serialized)),
        },
        body: serialized,
        signal: abort.signal,
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
      })
      const chunks: Buffer[] = []
      let total = 0
      for await (const raw of response.body) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        total += chunk.length
        if (total > responseLimit) {
          throw new PromptQueueClientError(
            response.statusCode,
            'RESPONSE_TOO_LARGE',
            'prompt queue response too large',
          )
        }
        chunks.push(chunk)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        throw new PromptQueueClientError(
          response.statusCode,
          'INVALID_RESPONSE',
          'prompt queue returned invalid JSON',
        )
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new PromptQueueClientError(
          response.statusCode,
          'INVALID_RESPONSE',
          'prompt queue returned invalid body',
        )
      }
      const body = parsed as Record<string, unknown>
      if (response.statusCode < 200 || response.statusCode >= 300 || body.ok !== true) {
        const error =
          body.error && typeof body.error === 'object'
            ? (body.error as Record<string, unknown>)
            : {}
        throw new PromptQueueClientError(
          response.statusCode,
          typeof error.code === 'string' ? error.code : 'HTTP_ERROR',
          typeof error.message === 'string'
            ? error.message
            : `prompt queue HTTP ${response.statusCode}`,
        )
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }
}

function parseSnapshot(
  value: unknown,
  expectedOwner: PromptQueueWireOwner,
  expectedUserId: string,
): PromptQueueSnapshot {
  if (!Value.Check(PromptQueueSnapshotSchema, value) || !isRecord(value)) {
    invalidResponse('snapshot does not match the protocol')
  }
  assertOnlyKeys(
    value,
    ['type', 'owner', 'version', 'activeTurn', 'items', 'mutation', 'serverTs', 'frameSeq'],
    'snapshot',
  )
  assertCanonicalDecimal(value.version, 'snapshot.version')
  assertOwner(value.owner, expectedOwner, expectedUserId)
  if (value.activeTurn !== null) {
    assertOnlyKeys(
      value.activeTurn,
      ['id', 'sourceItemId', 'traceId', 'startedAt', 'steerDelivery'],
      'snapshot.activeTurn',
    )
  }
  for (const raw of value.items as unknown[]) {
    const item = record(raw, 'snapshot item')
    assertOnlyKeys(
      item,
      [
        'id',
        'clientMessageId',
        'position',
        'displayText',
        'contentHash',
        'contentBytes',
        'attachmentRefs',
        'state',
        'requestedExecution',
        'createdAt',
        'updatedAt',
      ],
      'snapshot item',
    )
    assertCanonicalDecimal(item.contentBytes, 'snapshot item contentBytes')
    assertRequestedExecution(item.requestedExecution, expectedOwner.agentId)
    for (const attachment of item.attachmentRefs as unknown[]) {
      assertAttachment(attachment, false)
    }
  }
  if (value.mutation !== undefined) {
    const mutation = record(value.mutation, 'snapshot mutation')
    assertOnlyKeys(
      mutation,
      ['idempotencyKey', 'operation', 'outcome', 'appliedVersion', 'code'],
      'snapshot mutation',
    )
    if (mutation.appliedVersion !== undefined) {
      assertCanonicalDecimal(mutation.appliedVersion, 'mutation.appliedVersion')
    }
  }
  return value as unknown as PromptQueueSnapshot
}

function parseDetail(
  value: unknown,
  expectedOwner: PromptQueueWireOwner,
  expectedUserId: string,
  expectedItemId: string,
): PromptQueueDetail {
  const detail = record(value, 'detail')
  assertOnlyKeys(
    detail,
    [
      'owner',
      'snapshotVersion',
      'itemId',
      'clientMessageId',
      'state',
      'content',
      'contentHash',
      'contentBytes',
      'attachments',
      'requestedExecution',
      'deliveryIntent',
      'deliveryToken',
      'engineReceipt',
      'blockedReasonCode',
      'createdAt',
      'updatedAt',
    ],
    'detail',
  )
  assertOwner(detail.owner, expectedOwner, expectedUserId)
  assertCanonicalDecimal(detail.snapshotVersion, 'detail.snapshotVersion')
  assertCanonicalDecimal(detail.contentBytes, 'detail.contentBytes')
  assertString(detail.itemId, ITEM_ID_RE, 'detail.itemId')
  if (detail.itemId !== expectedItemId) invalidResponse('detail item owner mismatch')
  assertString(detail.clientMessageId, ITEM_ID_RE, 'detail.clientMessageId')
  assertString(detail.contentHash, HASH_RE, 'detail.contentHash')
  if (
    ![
      'queued',
      'dispatch_claimed',
      'active',
      'steer_pending',
      'delivery_unknown',
      'blocked',
    ].includes(String(detail.state))
  ) {
    invalidResponse('detail.state is invalid')
  }
  record(detail.content, 'detail.content')
  const canonicalContent = stableStringify(detail.content)
  if (
    BigInt(detail.contentBytes as string) !== BigInt(Buffer.byteLength(canonicalContent, 'utf8'))
  ) {
    invalidResponse('detail.contentBytes does not match content')
  }
  if (createHash('sha256').update(canonicalContent).digest('hex') !== detail.contentHash) {
    invalidResponse('detail.contentHash does not match content')
  }
  assertRequestedExecution(detail.requestedExecution, expectedOwner.agentId)
  if (!Array.isArray(detail.attachments) || detail.attachments.length > 8) {
    invalidResponse('detail.attachments is invalid')
  }
  for (const attachment of detail.attachments) assertAttachment(attachment, true)
  assertAttachmentProjection(detail.content, detail.attachments)
  if (detail.deliveryIntent !== undefined) {
    const intent = record(detail.deliveryIntent, 'detail.deliveryIntent')
    assertOnlyKeys(intent, ['mode', 'expectedTurnId', 'idempotencyKey'], 'detail.deliveryIntent')
    for (const key of Object.keys(intent)) {
      if (typeof intent[key] !== 'string')
        invalidResponse(`detail.deliveryIntent.${key} is invalid`)
    }
  }
  if (detail.deliveryToken !== undefined)
    assertString(detail.deliveryToken, HASH_RE, 'detail.deliveryToken')
  if (detail.engineReceipt !== undefined) record(detail.engineReceipt, 'detail.engineReceipt')
  if (detail.blockedReasonCode !== undefined && typeof detail.blockedReasonCode !== 'string') {
    invalidResponse('detail.blockedReasonCode is invalid')
  }
  assertFiniteNumber(detail.createdAt, 'detail.createdAt')
  assertFiniteNumber(detail.updatedAt, 'detail.updatedAt')
  return detail as unknown as PromptQueueDetail
}

function parseClaimResult(
  value: Record<string, unknown>,
  expectedOwner: PromptQueueWireOwner,
  expectedUserId: string,
): PromptQueueClaimResult {
  assertOnlyKeys(value, ['ok', 'snapshot', 'claim', 'outcome', 'code'], 'claim response')
  const snapshot = parseSnapshot(value.snapshot, expectedOwner, expectedUserId)
  const outcomes: PromptQueueClaimResult['outcome'][] = [
    'acquired',
    'renewed',
    'released',
    'activated',
    'completed',
    'interrupt_acknowledged',
    'empty',
    'rejected',
  ]
  if (!outcomes.includes(value.outcome as PromptQueueClaimResult['outcome'])) {
    invalidResponse('claim outcome is invalid')
  }
  const outcome = value.outcome as PromptQueueClaimResult['outcome']
  const needsClaim = outcome === 'acquired' || outcome === 'renewed'
  if (needsClaim !== (value.claim !== undefined)) {
    invalidResponse('claim response outcome/claim mismatch')
  }
  let parsedClaim: PromptQueueClaimResult['claim']
  if (value.claim !== undefined) {
    const claim = record(value.claim, 'claim')
    assertOnlyKeys(claim, ['itemId', 'epoch', 'claimToken', 'leaseUntil', 'renewed'], 'claim')
    assertString(claim.itemId, ITEM_ID_RE, 'claim.itemId')
    assertCanonicalDecimal(claim.epoch, 'claim.epoch')
    assertString(claim.claimToken, HASH_RE, 'claim.claimToken')
    assertFiniteNumber(claim.leaseUntil, 'claim.leaseUntil')
    if (typeof claim.renewed !== 'boolean' || claim.renewed !== (outcome === 'renewed')) {
      invalidResponse('claim.renewed is inconsistent')
    }
    parsedClaim = claim as unknown as NonNullable<PromptQueueClaimResult['claim']>
  }
  if (value.code !== undefined && typeof value.code !== 'string')
    invalidResponse('claim code is invalid')
  if (outcome !== 'rejected' && value.code !== undefined) invalidResponse('claim code on success')
  return {
    snapshot,
    outcome,
    ...(parsedClaim ? { claim: parsedClaim } : {}),
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
  }
}

function assertOwner(value: unknown, expected: PromptQueueWireOwner, userId: string): void {
  const owner = record(value, 'owner')
  assertOnlyKeys(owner, ['userId', 'sessionKey', 'clientSessionId', 'agentId'], 'owner')
  if (
    owner.userId !== userId ||
    owner.sessionKey !== expected.sessionKey ||
    owner.clientSessionId !== expected.clientSessionId ||
    owner.agentId !== expected.agentId
  ) {
    invalidResponse('prompt queue response owner mismatch')
  }
}

function assertRequestedExecution(value: unknown, agentId: string): void {
  const execution = record(value, 'requestedExecution')
  assertOnlyKeys(execution, ['agentId', 'model', 'modelSwitchId', 'effortLevel', 'teamMode'], 'requestedExecution')
  if (execution.agentId !== agentId) invalidResponse('requestedExecution.agentId mismatch')
  if (execution.model !== undefined && typeof execution.model !== 'string')
    invalidResponse('requestedExecution.model invalid')
  if (execution.modelSwitchId !== undefined && (
    typeof execution.modelSwitchId !== 'string' ||
    !/^[A-Za-z0-9:_-]{8,128}$/.test(execution.modelSwitchId)
  )) invalidResponse('requestedExecution.modelSwitchId invalid')
  if (
    execution.effortLevel !== undefined &&
    execution.effortLevel !== null &&
    typeof execution.effortLevel !== 'string'
  ) {
    invalidResponse('requestedExecution.effortLevel invalid')
  }
  if (execution.teamMode !== undefined && typeof execution.teamMode !== 'boolean') {
    invalidResponse('requestedExecution.teamMode invalid')
  }
}

function assertAttachment(value: unknown, detail: boolean): void {
  const attachment = record(value, 'attachment')
  assertOnlyKeys(
    attachment,
    detail
      ? ['ordinal', 'kind', 'url', 'mimeType', 'filename', 'hidden', 'contentSha256', 'sizeBytes']
      : ['ordinal', 'kind', 'url', 'mimeType', 'filename', 'hidden'],
    'attachment',
  )
  if (
    !Number.isInteger(attachment.ordinal) ||
    Number(attachment.ordinal) < 0 ||
    Number(attachment.ordinal) > 7
  ) {
    invalidResponse('attachment.ordinal invalid')
  }
  if (typeof attachment.kind !== 'string' || attachment.kind.length === 0)
    invalidResponse('attachment.kind invalid')
  assertString(attachment.url, MEDIA_URL_RE, 'attachment.url')
  for (const key of ['mimeType', 'filename'] as const) {
    if (attachment[key] !== undefined && typeof attachment[key] !== 'string')
      invalidResponse(`attachment.${key} invalid`)
  }
  if (attachment.hidden !== undefined && typeof attachment.hidden !== 'boolean')
    invalidResponse('attachment.hidden invalid')
  if (detail && attachment.contentSha256 !== undefined)
    assertString(attachment.contentSha256, HASH_RE, 'attachment.contentSha256')
  if (detail && attachment.sizeBytes !== undefined)
    assertCanonicalDecimal(attachment.sizeBytes, 'attachment.sizeBytes')
}

function assertAttachmentProjection(contentValue: unknown, attachmentsValue: unknown[]): void {
  const content = record(contentValue, 'detail.content')
  const media = content.media === undefined ? [] : content.media
  if (!Array.isArray(media) || media.length !== attachmentsValue.length) {
    invalidResponse('detail attachment projection mismatch')
  }
  for (let index = 0; index < media.length; index += 1) {
    const raw = record(media[index], 'detail.content.media')
    const attachment = record(attachmentsValue[index], 'detail attachment')
    if (
      attachment.ordinal !== index ||
      raw.kind !== attachment.kind ||
      raw.url !== attachment.url ||
      (raw.mimeType ?? undefined) !== (attachment.mimeType ?? undefined) ||
      (raw.filename ?? undefined) !== (attachment.filename ?? undefined) ||
      (raw.hidden === true) !== (attachment.hidden === true)
    )
      invalidResponse('detail attachment projection mismatch')
  }
}

function stableStringify(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) invalidResponse('detail.content is not canonical JSON')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  invalidResponse('detail.content is not canonical JSON')
}

function assertCanonicalDecimal(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) invalidResponse(`${name} is invalid`)
  // Parsing is intentional: it proves the full wire value is valid without a
  // lossy Number conversion at the BIGINT boundary.
  BigInt(value)
}

function assertString(value: unknown, pattern: RegExp, name: string): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) invalidResponse(`${name} is invalid`)
}

function assertFiniteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidResponse(`${name} is invalid`)
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedSet = new Set(allowed)
  const extra = Object.keys(value).find((key) => !allowedSet.has(key))
  if (extra) invalidResponse(`${name} contains unknown field ${extra}`)
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) invalidResponse(`${name} must be an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function invalidResponse(message: string): never {
  throw new PromptQueueClientError(200, 'INVALID_RESPONSE', message)
}
