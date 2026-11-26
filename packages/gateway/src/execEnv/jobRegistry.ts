/**
 * OCV5-890 / OCV5-908 Layer 3 — Compatibility re-export of Execution Environment JobRegistry
 * from `@openclaude/storage` (shared L2 single source of truth; binds authoritative Linux `/proc`
 * synchronous verification ops for host-level `shutdownSync` and `sendVerifiedGroupSignal`).
 */
import { readdirSync, readFileSync } from 'node:fs'
import {
  parseProcStatFull,
  registerDefaultSyncProcOps,
  type ParsedProcStat,
} from '@openclaude/storage'

function readGatewayLinuxProcStat(pid: number): ParsedProcStat | null {
  if (!Number.isInteger(pid) || pid <= 1 || process.platform !== 'linux') return null
  try {
    return parseProcStatFull(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch (err) {
    void err
    return null
  }
}

function listGatewayLinuxProcPids(): number[] {
  if (process.platform !== 'linux') return []
  try {
    const pids: number[] = []
    for (const name of readdirSync('/proc')) {
      if (!/^[1-9][0-9]*$/.test(name)) continue
      const pid = Number(name)
      if (Number.isSafeInteger(pid) && pid > 1) pids.push(pid)
    }
    return pids
  } catch (err) {
    void err
    return []
  }
}

registerDefaultSyncProcOps({
  readProcStat: readGatewayLinuxProcStat,
  listProcPids: listGatewayLinuxProcPids,
})

export function readProcStartTimeTicks(pid: number): number | null {
  return readGatewayLinuxProcStat(pid)?.startTimeTicks ?? null
}

export { BoundedDeltaStreamBuffer, EXEC_ENV_JOB_DEFAULT_CLOSE_DRAIN_MS, EXEC_ENV_JOB_DEFAULT_KILL_GRACE_MS, EXEC_ENV_JOB_DEFAULT_MAX_LIFETIME_MS, EXEC_ENV_JOB_DEFAULT_MAX_LOG_FILE_BYTES, EXEC_ENV_JOB_DEFAULT_TOMBSTONE_MAX, EXEC_ENV_JOB_HEAD_BYTES, EXEC_ENV_JOB_MAX_OUTPUT_BYTES, EXEC_ENV_JOB_TAIL_BYTES, ExecEnvJobError, ExecEnvJobRegistry, hasAliveVerifiedProcessGroup, hasAliveVerifiedProcessGroupAsync, leadingContinuationUtf8Count, parseProcStatFull, parseProcStatStartTimeTicks, readProcStartTimeTicksAsync, registerDefaultSyncProcOps, sendVerifiedGroupSignal, sendVerifiedGroupSignalAsync, trailingIncompleteUtf8Count } from '@openclaude/storage'
export type { BoundedDeltaReadResult, BoundedDeltaStreamBufferOptions, ExecEnvJobClosedEvent, ExecEnvJobErrorCode, ExecEnvJobRegistryOptions, ExecEnvJobStartResult, ExecEnvJobStartedEvent, ExecEnvJobTerminationCause, ExecEnvMigrationTombstoneResult, ExecEnvReapStopProof, ExecEnvShutdownResult, ExecEnvStartJobSpec, ExecEnvWaitJobAction, ExecEnvWaitJobResult, ParsedProcStat, VerifyProcessGroupOps, WaitJobOptions } from '@openclaude/storage'
