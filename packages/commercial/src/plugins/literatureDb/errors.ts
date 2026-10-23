/** Public errors deliberately carry no upstream body, URL, answer or credential. */
export type LiteratureErrorCode =
  | 'INVALID_INPUT'
  | 'OUTBOUND_BLOCKED'
  | 'SECRET_INVALID'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_REFUSED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'RATE_LIMITED'
  | 'CAPACITY'
  | 'ACCOUNT_BUSY'
  | 'NOT_FOUND'
  | 'CHALLENGE_STALE'
  | 'CREDENTIALS_INVALID'
  | 'UPSTREAM_BLOCKED'
  | 'SUBMISSION_UNCERTAIN'
  | 'RESPONSE_INVALID'
  | 'RESPONSE_TOO_LARGE'
  | 'LOGIN_FAILED'
  | 'PERSISTENCE_UNCERTAIN'
  | 'CLEANUP_FAILED'
  | 'SESSION_EXPIRED'
  | 'DOCUMENT_EXPIRED'
  // Agent-facing codes (OCV5-585): the RPC layer passes these through verbatim.
  | 'LITERATURE_ARTIFACT_CAPACITY'
  | 'LITERATURE_NO_ACCESS'
  | 'LITERATURE_UPSTREAM_RATE_LIMITED'
  | 'LITERATURE_UPSTREAM_CHALLENGE'
  | 'LITERATURE_UPSTREAM_CHANGED'
export class LiteratureError extends Error {
  constructor(readonly code: LiteratureErrorCode) {
    super(code)
    this.name = 'LiteratureError'
  }
}

/** Race cancellation even if an inference client ignores AbortSignal. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller already started work; consume its eventual rejection as well.
    void work.catch(() => {})
    return Promise.reject(new LiteratureError('CANCELLED'))
  }
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup()
      reject(new LiteratureError('CANCELLED'))
    }
    const cleanup = () => signal.removeEventListener('abort', aborted)
    signal.addEventListener('abort', aborted, { once: true })
    work.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}
