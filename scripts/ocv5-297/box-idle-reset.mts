/**
 * OCV5-297 operator exit for a session stuck on IDLE_HISTORY_PENDING.
 *
 * Writes an idle-reset marker. The next submit of that session (holding
 * session.lock) shuts the runner down, drops its resume id so the turn runs on
 * a NEW CCB/Box native session, marks unfinished idle ops `abandoned`
 * (operator_reset) and clears the candidate. Nothing is sent to a model here
 * and no ledger row is touched.
 *
 * Run inside the user container, as the gateway user:
 *   npx tsx scripts/ocv5-297/box-idle-reset.mts --session-key '<sessionKey>' [--home <dir>]
 * `--home` defaults to $OPENCLAUDE_HOME or ~/.openclaude (same as paths.home).
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readPendingIdle, readIdleCandidate, requestIdleReset } from '../../packages/gateway/src/boxIdleCompact.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const sessionKey = arg('--session-key')
const home = arg('--home') ?? process.env.OPENCLAUDE_HOME ?? join(homedir(), '.openclaude')
if (!sessionKey || !/^[A-Za-z0-9._:-]{1,256}$/.test(sessionKey)) {
  console.error('usage: --session-key <[A-Za-z0-9._:-]{1,256}> [--home <dir>]')
  process.exit(2)
}
const pending = readPendingIdle(home, sessionKey)
const candidate = readIdleCandidate(home, sessionKey)
const path = requestIdleReset(home, sessionKey)
console.log(JSON.stringify({
  ok: true, marker: path,
  pendingRevision: pending?.revision ?? null,
  candidate: candidate ? { turnKey: candidate.turnKey } : null,
  note: 'applied on the next submit of this session; the session continues on a new native session',
}))
