/**
 * Browser-safe message-id contracts.
 *
 * The validators are shared by frame schemas, gateway ingress and the web
 * dispatch journal. They intentionally have no TypeBox dependency.
 */

export const CLIENT_MESSAGE_ID_PATTERN = '^[A-Za-z0-9_-]{1,128}$'
export const CLIENT_MESSAGE_ID_RE = new RegExp(CLIENT_MESSAGE_ID_PATTERN)
export const isClientMessageId = (value: unknown): value is string =>
  typeof value === 'string' && CLIENT_MESSAGE_ID_RE.test(value)

/** Durable rows may contain legacy colon-delimited ids. New browser-authored
 * ids remain constrained by CLIENT_MESSAGE_ID_PATTERN. */
export const PERSISTED_CLIENT_MESSAGE_ID_PATTERN =
  '^(?:[A-Za-z0-9_-]{1,128}|[A-Za-z0-9_:-]{1,80})$'
export const PERSISTED_CLIENT_MESSAGE_ID_RE = new RegExp(PERSISTED_CLIENT_MESSAGE_ID_PATTERN)
export const isPersistedClientMessageId = (value: unknown): value is string =>
  typeof value === 'string' && PERSISTED_CLIENT_MESSAGE_ID_RE.test(value)
