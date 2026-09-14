/** Schema12 bootstrap floor. Reader-only helpers shared by Node and native Bun.
 * This is a storage format fence, NOT authorization, a receipt owner or an ACK. */
export interface DelegateProfileSqlite {
  prepare(sql: string): { all(...args: never[]): unknown[]; get(...args: never[]): unknown }
}
type Row = Record<string, unknown>
export const DELEGATE_PROFILE_TABLE = 'delegate_consumer_profile'
const identityTables = ['delegate_jobs', 'delegate_retry_source', 'delegate_retry_action',
  'delegate_retry_parent_fence', 'delegate_failure_inbox']
const v2Tables = [...identityTables.slice(1), 'delegate_delivery_receipt']
const bookkeeping = new Set(['callback', 'callback_state', 'callback_epoch', 'notify_retry_at',
  'notify_delivery_token', 'notify_claimed_until', 'last_activity_at', 'updated_at',
  'notify_attempt', 'notify_a_attempted_at'])
const normalize = (sql: string) => sql.replace(/;\s*$/, '').replace(/\s+/g, ' ').trim()

export function delegateIdentityGuardSql(db: DelegateProfileSqlite): Map<string, string> {
  const columns = db.prepare('PRAGMA table_info(delegate_jobs)').all() as Row[]
  if (!columns.length || columns.some(c => typeof c.name !== 'string')) throw new Error('invalid delegate jobs shape')
  const protectedColumns = columns.map(c => c.name as string).filter(c => !bookkeeping.has(c))
    .map(c => '"' + c.replaceAll('"', '""') + '"')
  const result = new Map<string, string>()
  for (const table of identityTables) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const name = `identity_v10_${table}_${operation.toLowerCase()}`
    const event = table === 'delegate_jobs' && operation === 'UPDATE'
      ? `UPDATE OF ${protectedColumns.join(',')}` : operation
    result.set(name, `CREATE TRIGGER ${name} BEFORE ${event} ON ${table}
      BEGIN SELECT CASE WHEN oc_delegate_schema10() IS NOT 10
        THEN RAISE(ABORT,'delegate identity schema10 writer required') END; END`)
  }
  return result
}

/** No unknown UDF on an ordinary v4 jobs write while min_consumer=1. */
export function delegateProfileGuardSql(): Map<string, string> {
  const result = new Map<string, string>()
  result.set('delegate_profile_no_insert', `CREATE TRIGGER delegate_profile_no_insert BEFORE INSERT ON ${DELEGATE_PROFILE_TABLE}
    BEGIN SELECT RAISE(ABORT,'delegate profile already initialized'); END`)
  result.set('delegate_profile_no_delete', `CREATE TRIGGER delegate_profile_no_delete BEFORE DELETE ON ${DELEGATE_PROFILE_TABLE}
    BEGIN SELECT RAISE(ABORT,'delegate profile cannot be deleted'); END`)
  result.set('delegate_profile_update', `CREATE TRIGGER delegate_profile_update BEFORE UPDATE ON ${DELEGATE_PROFILE_TABLE}
    BEGIN SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.min_consumer < OLD.min_consumer
      THEN RAISE(ABORT,'delegate consumer floor cannot decrease') END;
      SELECT CASE WHEN oc_delegate_schema10() IS NOT 10
      THEN RAISE(ABORT,'delegate profile writer required') END; END`)
  for (const table of v2Tables) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const name = `delegate_legacy_${table}_${operation.toLowerCase()}`
    result.set(name, `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table}
      WHEN (SELECT min_consumer FROM ${DELEGATE_PROFILE_TABLE} WHERE id=1) IS NOT 2
      BEGIN SELECT RAISE(ABORT,'delegate v2 profile required'); END`)
  }
  for (const operation of ['INSERT', 'UPDATE']) {
    const name = `delegate_legacy_jobs_${operation.toLowerCase()}`
    result.set(name, `CREATE TRIGGER ${name} BEFORE ${operation} ON delegate_jobs
      WHEN (SELECT min_consumer FROM ${DELEGATE_PROFILE_TABLE} WHERE id=1) IS NOT 2
        AND (NEW.failure_inbox_enabled IS NOT 0 OR NEW.delivery_receipt_context IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'delegate v2 enrollment requires profile'); END`)
  }
  return result
}

/** Must never interpret missing/contradictory profile as legacy. No schema writes. */
export function readDelegateConsumerProfile(db: DelegateProfileSqlite): 1 | 2 {
  const rows = db.prepare(`SELECT id,min_consumer FROM ${DELEGATE_PROFILE_TABLE}`).all() as Row[]
  const row = rows[0]
  if (rows.length !== 1 || row?.id !== 1 || (row.min_consumer !== 1 && row.min_consumer !== 2)) {
    throw new Error('invalid delegate consumer profile')
  }
  const floor = row.min_consumer
  const actual = new Map((db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as Row[])
    .map(r => [String(r.name), typeof r.sql === 'string' ? normalize(r.sql) : '']))
  const identity = delegateIdentityGuardSql(db)
  const expected = delegateProfileGuardSql()
  if (floor === 2) for (const [name, sql] of identity) expected.set(name, sql)
  for (const [name, sql] of expected) {
    if (actual.get(name) !== normalize(sql)) throw new Error('invalid delegate consumer guard')
  }
  if (floor === 1) {
    if ([...identity.keys()].some(name => actual.has(name))) throw new Error('legacy profile has incompatible writer guards')
    if (db.prepare('SELECT 1 FROM delegate_jobs WHERE failure_inbox_enabled IS NOT 0 OR delivery_receipt_context IS NOT NULL LIMIT 1').get()) {
      throw new Error('legacy profile has v2 enrollment')
    }
    for (const table of v2Tables) if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error('legacy profile has v2 inventory')
    }
  }
  return floor
}
