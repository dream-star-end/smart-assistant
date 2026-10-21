/**
 * AppError (phase 3 plan v3.6 §3.6 `errors`): an error with a stable machine code, structured
 * details and a cause. Codes are UPPER_SNAKE; the contract code table that every code must appear
 * in arrives with P4/P10 (§5.5 rule 10), so for now only the format is enforced.
 */

const CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/

export class AppError extends Error {
  readonly code: string
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    if (!CODE_RE.test(code))
      throw new TypeError(`AppError code must be UPPER_SNAKE: ${JSON.stringify(code)}`)
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    if (options.details) this.details = Object.freeze({ ...options.details })
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}

/** The code of an AppError, or of any error carrying a string `code` (Node's `ENOENT`, …). */
export function errorCode(e: unknown): string | undefined {
  if (e instanceof AppError) return e.code
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}
