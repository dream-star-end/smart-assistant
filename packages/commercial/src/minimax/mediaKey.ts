import { readFileSync } from 'node:fs'

import { type Logger, rootLogger } from '../logging/logger.js'

/**
 * MiniMax media key resolution (OCV5-589, user decision D12 2026-10-23).
 *
 * The media proxy and the media studio may use a dedicated subscription key,
 * read from a root-only file, so heavy media use cannot drain the 5-hour quota
 * window that web search (`MINIMAX_TOKEN_PLAN_KEY`) depends on.
 *
 *   MINIMAX_MEDIA_KEY_FILE set   → the file is the only source. Unreadable or
 *                                  malformed → no key (media answers 503); it
 *                                  never silently falls back to the search key.
 *   MINIMAX_MEDIA_KEY_FILE unset → MINIMAX_TOKEN_PLAN_KEY, exactly as before.
 *
 * Error strings never include the file contents.
 */
export interface MiniMaxMediaKey {
  key?: string
  source: 'file' | 'token_plan' | 'none'
  error?: string
}

const KEY_RE = /^[\x21-\x7e]{1,512}$/

export function resolveMiniMaxMediaKey(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): MiniMaxMediaKey {
  const file = env.MINIMAX_MEDIA_KEY_FILE?.trim()
  if (file) {
    let raw: string
    try {
      raw = read(file)
    } catch {
      return { source: 'none', error: 'MINIMAX_MEDIA_KEY_FILE is not readable' }
    }
    const key = raw.trim()
    if (!KEY_RE.test(key)) {
      return {
        source: 'none',
        error: 'MINIMAX_MEDIA_KEY_FILE does not contain a single printable token',
      }
    }
    return { key, source: 'file' }
  }
  const tokenPlan = env.MINIMAX_TOKEN_PLAN_KEY?.trim()
  return tokenPlan ? { key: tokenPlan, source: 'token_plan' } : { source: 'none' }
}

/**
 * The master media proxy's key from config (selfhost wiring, kept out of index.ts). A configured but
 * unusable file logs why (never its contents) and yields no key, so the proxy answers 503.
 */
export function mediaProxyKey(
  cfg: { MINIMAX_MEDIA_KEY_FILE?: string; MINIMAX_TOKEN_PLAN_KEY?: string },
  log: Pick<Logger, 'error'> = rootLogger,
  read?: (path: string) => string,
): string | undefined {
  const r = resolveMiniMaxMediaKey(
    {
      MINIMAX_MEDIA_KEY_FILE: cfg.MINIMAX_MEDIA_KEY_FILE,
      MINIMAX_TOKEN_PLAN_KEY: cfg.MINIMAX_TOKEN_PLAN_KEY,
    },
    read,
  )
  if (r.error) log.error('minimax_media_key_unavailable', { reason: r.error })
  return r.key
}
