#!/usr/bin/env npx tsx
/**
 * Read-only operator CLI for `remote-driver-v4` live probe (Milestone R11).
 *
 * Usage:
 *   npx tsx scripts/v5-remote-driver-probe.ts --profile-id <uuid> --driver <cc|codex> [--dry-run]
 */
import { parseArgs } from 'node:util'
import { probeRemoteDriverProfileLive } from '../packages/commercial/src/account-pool/remotePool/index.js'
import { closePool, getPool } from '../packages/commercial/src/db/index.js'

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  for (const arg of rawArgs) {
    if (
      arg === '--write' ||
      arg === '--apply' ||
      arg === '--no-dry-run' ||
      arg === '--dry-run=false'
    ) {
      throw new Error('REMOTE_LIVE_PROBE_WRITE_DISABLED_IN_R11')
    }
  }

  const { values } = parseArgs({
    args: rawArgs,
    options: {
      'profile-id': { type: 'string' },
      driver: { type: 'string' },
      'dry-run': { type: 'boolean', default: true },
      'key-dir': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })

  const profileId = values['profile-id']
  const driverId = values.driver
  if (!profileId || !driverId || !['cc', 'codex'].includes(driverId)) {
    throw new Error('Usage: --profile-id <uuid> --driver <cc|codex> [--dry-run]')
  }
  if (values['dry-run'] !== true) {
    throw new Error('REMOTE_LIVE_PROBE_WRITE_DISABLED_IN_R11')
  }

  const pool = getPool()
  try {
    const result = await probeRemoteDriverProfileLive(pool, {
      profileId,
      driverId,
      dryRun: true,
      ...(values['key-dir'] ? { keyDir: values['key-dir'] } : {}),
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await closePool()
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
