/**
 * Auto-dream schedule keys and normalisation
 *
 * Moved verbatim out of server.ts (FINDINGS §7.6, OCV5-533); server.ts re-exports
 * these names, so importers are unchanged.
 */
import type { CronJob } from './cron.js'

export const AUTO_DREAM_SCHEDULE_KEYS = new Set([
  'id',
  'agent',
  'schedule',
  'prompt',
  'deliver',
  'enabled',
  'oneshot',
  'label',
  'createdAt',
])

/**
 * Auto-Dream may only create local, user-visible schedules. External delivery
 * targets remain a guided/manual action because model-authored peer IDs are
 * not an authority for proactive outbound delivery.
 */
export function normalizeAutoDreamSchedule(
  raw: string,
  agentId: string,
  jobId: string,
): import('./cron.js').CronJob {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AUTO_DREAM_SCHEDULE_INVALID')
  }
  const row = parsed as Record<string, unknown>
  if (Object.keys(row).some((key) => !AUTO_DREAM_SCHEDULE_KEYS.has(key))) {
    throw new Error('AUTO_DREAM_SCHEDULE_UNKNOWN_FIELD')
  }
  if (
    typeof row.schedule !== 'string' ||
    row.schedule.length < 1 ||
    row.schedule.length > 128 ||
    typeof row.prompt !== 'string' ||
    row.prompt.length < 1 ||
    row.prompt.length > 32_000 ||
    (row.deliver !== undefined && row.deliver !== 'local') ||
    (row.enabled !== undefined && typeof row.enabled !== 'boolean') ||
    (row.oneshot !== undefined && typeof row.oneshot !== 'boolean') ||
    (row.label !== undefined &&
      (typeof row.label !== 'string' || row.label.length < 1 || row.label.length > 500)) ||
    (row.createdAt !== undefined &&
      (typeof row.createdAt !== 'number' ||
        !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < 0))
  ) {
    throw new Error('AUTO_DREAM_SCHEDULE_INVALID')
  }
  return {
    id: jobId,
    agent: agentId,
    schedule: row.schedule,
    prompt: row.prompt,
    deliver: 'local',
    ...(typeof row.enabled === 'boolean' ? { enabled: row.enabled } : {}),
    ...(typeof row.oneshot === 'boolean' ? { oneshot: row.oneshot } : {}),
    ...(typeof row.label === 'string' ? { label: row.label } : {}),
    ...(typeof row.createdAt === 'number' ? { createdAt: row.createdAt } : {}),
  }
}
