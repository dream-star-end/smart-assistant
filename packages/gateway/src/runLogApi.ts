import type { RunLog, RunLogEntry } from './runLog.js'

export interface RunLogApiResponse {
  status: number
  body: { run: RunLogEntry } | { runs: RunLogEntry[] } | { error: string }
}

export function selectRunLogResponse(
  runLog: RunLog,
  searchParams: URLSearchParams,
): RunLogApiResponse {
  const runId = searchParams.get('runId')?.trim()
  if (runId) {
    const run = runLog.get(runId)
    return run ? { status: 200, body: { run } } : { status: 404, body: { error: 'run not found' } }
  }

  const sessionKey = searchParams.get('sessionKey')?.trim()
  if (sessionKey) {
    const run = runLog.recent(200).find((entry) => entry.sessionKey === sessionKey)
    return run ? { status: 200, body: { run } } : { status: 404, body: { error: 'run not found' } }
  }

  const limit = parseLimit(searchParams.get('limit'))
  return { status: 200, body: { runs: runLog.recent(limit) } }
}

function parseLimit(raw: string | null): number {
  const n = raw ? Number(raw) : 50
  if (!Number.isFinite(n)) return 50
  return Math.min(200, Math.max(1, Math.floor(n)))
}
