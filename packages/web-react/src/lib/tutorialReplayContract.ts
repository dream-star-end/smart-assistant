export const PUBLIC_REPLAY_PRIVATE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'userid',
  'uid',
  'accountid',
  'tenantid',
  'orgid',
  'ip',
  'ipaddress',
  'password',
  'secret',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'authorization',
  'cookie',
  'traceid',
  'requestid',
  'turntapeid',
  'clientmessageid',
  'continuationofturnkey',
  'continuationofclientmessageid',
  'recoveryofclientmessageid',
  'automaticretryrootclientmessageid',
  'automaticrecoveryrootclientmessageid',
  'sessionkey',
  'sessionid',
  'peerid',
  'containerid',
  'turnownerid',
  'turnkey',
  'idem',
  'idempotencykey',
  'retrymedia',
])

export function isPrivatePublicReplayField(field: string): boolean {
  if (['__proto__', 'constructor', 'prototype'].includes(field)) return true
  return PUBLIC_REPLAY_PRIVATE_FIELD_NAMES.has(field.replace(/[-_]/g, '').toLowerCase())
}

export function hasPrivatePublicReplayField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrivatePublicReplayField)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => isPrivatePublicReplayField(key) || hasPrivatePublicReplayField(child),
  )
}

type PublicCheckEvidenceExpectation = {
  caseId: string
  runId: string
  checkTitle: string
}

export function validatePublicCheckEvidence(
  value: unknown,
  expected: PublicCheckEvidenceExpectation,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('验收证据必须是 JSON object')
  const evidence = value as Record<string, unknown>
  const keys = Object.keys(evidence).sort()
  const expectedKeys = ['assertions', 'caseId', 'checkTitle', 'runId', 'schemaVersion', 'status']
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys))
    throw new Error('验收证据字段不完整或含未知字段')
  if (
    evidence.schemaVersion !== 1 ||
    evidence.caseId !== expected.caseId ||
    evidence.runId !== expected.runId ||
    evidence.checkTitle !== expected.checkTitle ||
    evidence.status !== 'passed'
  )
    throw new Error('验收证据未绑定当前案例、运行与检查项')
  if (!Array.isArray(evidence.assertions) || evidence.assertions.length < 1)
    throw new Error('验收证据必须包含至少一条实际断言')
  for (const assertion of evidence.assertions) {
    if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion))
      throw new Error('验收证据断言必须是 JSON object')
    const row = assertion as Record<string, unknown>
    if (
      JSON.stringify(Object.keys(row).sort()) !==
      JSON.stringify(['actual', 'expected', 'label', 'passed'])
    )
      throw new Error('验收证据断言字段不完整或含未知字段')
    if (
      typeof row.label !== 'string' ||
      !row.label.trim() ||
      typeof row.expected !== 'string' ||
      typeof row.actual !== 'string' ||
      row.passed !== true
    )
      throw new Error('验收证据断言必须给出预期、实际值和通过状态')
  }
  if (hasPrivatePublicReplayField(evidence)) throw new Error('验收证据包含禁止公开的隐私身份字段')
}
