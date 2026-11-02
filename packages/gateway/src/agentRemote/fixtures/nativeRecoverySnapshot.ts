/** Synthetic one-writer supervisor fixture. Parent owns/waits the exact writer
 * ChildProcess before starting us. This is not a product supervisor or OS RPC. */
import { readFileSync } from 'node:fs'
import { SqliteAgentRemoteStore } from '../durableStore.js'
import { NativeRecoveryService } from '../nativeRecovery.js'
import { NativeStateRepository, assertNativeWriterLock } from '../nativeState.js'

const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const store = new SqliteAgentRemoteStore(config.database)
const repo = new NativeStateRepository(config.options)
try {
  const service = new NativeRecoveryService(store, config.peer, () => config.now, {
    async withFreshCheckpoint(target, capture, commit) {
      const assertHeld = () => {
        assertNativeWriterLock(repo.lockPath(target.permit.identity))
        return true as const
      }
      assertHeld()
      const ticket = await capture({ assertHeld })
      return repo.checkpoint(
        {
          ...config.request,
          identity: target.permit.identity,
          bindingRevision: ticket.bindingRevision,
          checkpointCaptureId: ticket.captureId,
          nativeDeliveryWatermark: ticket.nativeDeliveryWatermark,
          nativeWriterGeneration: ticket.nativeWriterGeneration,
          createdAtMs: ticket.createdAtMs,
        },
        async (manifest) => {
          assertHeld()
          if (config.fault === 'before-commit') throw new Error('injected-before-control-commit')
          const result = await commit(manifest)
          assertHeld()
          if (config.fault === 'after-commit') process.kill(process.pid, 'SIGKILL')
          return result
        },
      )
    },
  })
  process.stdout.write(`${JSON.stringify(await service.finish('u1', config.token))}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  store.close()
}
