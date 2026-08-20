export const TUTORIAL_SANITIZER_VERSION = 'tutorial-sanitizer-v1'

export const PUBLIC_TUTORIAL_MESSAGE_FIELDS = [
  'id',
  'role',
  'text',
  'ts',
  '_media',
] as const

export type PublicTutorialMessageField = (typeof PUBLIC_TUTORIAL_MESSAGE_FIELDS)[number]

export const PUBLIC_TUTORIAL_ROLES = [
  'user',
  'assistant',
  'thinking',
  'tool',
  'agent-group',
  'plan',
  'goal',
] as const

export type PublicTutorialRole = (typeof PUBLIC_TUTORIAL_ROLES)[number]

export const STRIPPED_TUTORIAL_ROLES = [
  'system',
  'permission',
  'runtime-event',
  'delegate-progress',
] as const

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
  'sourcesessionid',
])

export type TutorialLeakRule =
  | 'secret_token'
  | 'private_key'
  | 'email'
  | 'phone'
  | 'absolute_path'
  | 'session_identifier'
  | 'trace_identifier'
  | 'request_identifier'
  | 'container_identifier'
  | 'signed_media_url'
  | 'dangerous_scheme'
  | 'html_external'
  | 'private_field'
  | 'unselected_artifact'
  | 'unparseable_artifact'
  | 'svg_embed_forbidden'
  | 'unknown_binary'
  | 'network_api'
  | 'html_navigation'

export type TutorialLeak = {
  rule: TutorialLeakRule
  field: string
}

export function normalizeReplayFieldName(field: string): string {
  return field.replace(/[-_]/g, '').toLowerCase()
}

export function isPrivatePublicReplayField(field: string): boolean {
  if (['__proto__', 'constructor', 'prototype'].includes(field)) return true
  return PUBLIC_REPLAY_PRIVATE_FIELD_NAMES.has(normalizeReplayFieldName(field))
}
