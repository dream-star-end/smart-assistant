/** Operator proof-only recovery. Run from the deployed master tree with its normal DB environment.
 * Usage: tsx scripts/reconcile-remote-native-lane.ts <operation-uuid> <generation>
 * Does NOT stop a live user container. First use the normal container lifecycle to stop it.
 */
import { getPool, closePool } from '../packages/commercial/src/db/index.js'
import { reconcileRemoteLane } from '../packages/commercial/src/account-pool/remoteLaneRecovery.js'
if (process.getuid?.() !== 0 || process.argv.length !== 4) throw new Error('ROOT_AND_OPERATION_GENERATION_REQUIRED')
try {
  await reconcileRemoteLane(getPool(),process.argv[2]!,process.argv[3]!)
  console.log('remote lane capacity released by independent local/remote stop proof; financial boundaries unchanged')
} finally { await closePool() }
