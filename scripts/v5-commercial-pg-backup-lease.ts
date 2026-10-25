// Qualify the existing official lease; never acquire, renew or release one here.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  canonical,
  explicitOperatorDsn,
  verifyLocalLease,
  type LeasePaths,
  PRODUCTION_LEASE_PATHS,
} from '../ops/ocv5-308/model-release-operator'

const identitySql = "SELECT json_build_object('clusterId', system_identifier::text, 'database', current_database(), 'databaseOid', (SELECT oid::text FROM pg_database WHERE datname=current_database()), 'serverAddress', inet_server_addr()::text, 'serverPort', inet_server_port(), 'postmasterEpoch', extract(epoch FROM pg_postmaster_start_time())::text, 'inRecovery', pg_is_in_recovery()) AS identity FROM pg_control_system()"

function queryIdentity(sql: string, roleEnv: NodeJS.ProcessEnv, local: boolean) {
  const dsn = new URL(explicitOperatorDsn({
    OC_V5_MODEL_RELEASE_DATABASE_URL: roleEnv.MODEL_AUTHORITY_DEPLOY_DATABASE_URL,
  }))
  const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' }
  const env = local ? { ...base, ...Object.fromEntries(Object.entries(roleEnv).filter(([k]) => k.startsWith('PG'))) } : {
    ...base, PGHOST: dsn.hostname, PGPORT: dsn.port,
    PGDATABASE: decodeURIComponent(dsn.pathname.slice(1)),
    PGUSER: decodeURIComponent(dsn.username), PGPASSWORD: decodeURIComponent(dsn.password),
    PGCONNECT_TIMEOUT: '2', PGOPTIONS: '-c statement_timeout=2500 -c lock_timeout=2500',
  }
  const args = ['-XAt', '-v', 'ON_ERROR_STOP=1', '-c', sql]
  try {
    const out = local
      ? execFileSync('runuser', ['-u', roleEnv.V5CB_PG_AS ?? 'postgres', '--', roleEnv.V5CB_PSQL ?? 'psql', '-d', roleEnv.V5CB_DB ?? 'openclaude_commercial', ...args], { env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
      : execFileSync(roleEnv.V5CB_PSQL ?? 'psql', args, { env, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(out.trim())
  } catch {
    // Child errors can contain connection details. Only this fixed code leaves the process.
    throw new Error('LEASE_PRIMARY_QUERY_FAILED')
  }
}

export async function qualifyBackupLease(
  nonce: string,
  roleEnv: NodeJS.ProcessEnv = process.env,
  paths: LeasePaths = PRODUCTION_LEASE_PATHS,
  query = queryIdentity,
) {
  const db = { query: async (sql: string) => ({ rows: [{ identity: query(sql, roleEnv, false) }] }) }
  const proof = await verifyLocalLease(db as Parameters<typeof verifyLocalLease>[0], nonce, paths)
  const local = query(identitySql, roleEnv, true)
  // Dump uses peer auth over a Unix socket. Compare its actual cluster/database/epoch,
  // while the shared verifier independently compares every TCP endpoint field.
  for (const key of ['clusterId', 'database', 'databaseOid', 'postmasterEpoch', 'inRecovery']) {
    if (canonical(local[key]) !== canonical(proof[key])) throw new Error('DUMP_PRIMARY_IDENTITY_MISMATCH')
  }
  return proof
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  qualifyBackupLease(process.env.OC_V5_MANUAL_LEASE_NONCE ?? '').catch(() => {
    console.error('commercial backup: official lease qualification failed')
    process.exitCode = 1
  })
}
