/** Synthetic child-process fault fixture. Never loads product/user configuration. */
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { SqliteAgentRemoteStore } from '../durableStore.js'
import { NativeStateRepository, assertNativeWriterLock } from '../nativeState.js'
import { createAgentRemoteService } from '../service.js'

const mode = process.argv[2]!
const config = JSON.parse(readFileSync(process.argv[3]!, 'utf8'))
function line(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
try {
  if (mode === 'dispatch' || mode === 'claim' || mode === 'init') {
    const store = new SqliteAgentRemoteStore(config.database)
    const service = createAgentRemoteService({
      env: { OC_AGENT_REMOTE_ENABLED: '1' },
      createStore: () => store,
      clock: () => config.now,
    })!
    if (mode === 'init') {
      store.close()
      line({ initialized: true })
    } else if (mode === 'claim') {
      line(await service.claim('u1', config.binding, 1000))
      store.close()
    } else {
      await service.authorizeStart('u1', config.binding, config.operationId, config.lease)
      line({ committed: true })
      setInterval(() => {}, 1000)
    }
  } else {
    const repo = new NativeStateRepository({
      ...config.options,
      beforePublish:
        config.fault === 'append'
          ? () => {
              appendFileSync(
                config.transcript,
                `${JSON.stringify({ uuid: 'unexpected', sessionId: config.identity.nativeSessionId })}\n`,
              )
            }
          : config.fault === 'kill-before-publish'
            ? () => {
                process.kill(process.pid, 'SIGKILL')
              }
            : undefined,
    })
    if (mode === 'manager') {
      const command = repo.writerCommand(config.identity, process.execPath, [
        '--import',
        'tsx',
        process.argv[1]!,
        'writer',
        process.argv[3]!,
      ])
      const child = spawn(command.executable, command.args, {
        stdio: ['ignore', 'ignore', 'inherit'],
        detached: true,
      })
      line({ writerPid: child.pid })
      setInterval(() => {}, 1000)
    } else if (mode === 'writer') {
      assertNativeWriterLock(repo.lockPath(config.identity))
      if (config.ready) writeFileSync(config.ready, String(process.pid))
      line({ locked: true })
      setInterval(() => {}, 1000)
    } else if (mode === 'checkpoint') {
      const store = config.service ? new SqliteAgentRemoteStore(config.service.database) : undefined
      const service = store
        ? createAgentRemoteService({
            env: { OC_AGENT_REMOTE_ENABLED: '1' },
            createStore: () => store,
            clock: () => config.service.now,
          })!
        : undefined
      try {
        if (service) {
          const capture =
            config.service.capture ??
            (await service.captureNativeCheckpoint(
              'u1',
              config.service.binding,
              config.service.lease,
              config.identity,
            ))
          config.request = {
            ...config.request,
            checkpointCaptureId: capture.captureId,
            nativeDeliveryWatermark: capture.nativeDeliveryWatermark,
            createdAtMs: Math.max(config.request.createdAtMs, capture.createdAtMs),
          }
        }
        const manifest = await repo.checkpoint(config.request, async (value) => {
          if (service)
            await service.publishNativeCheckpoint(
              'u1',
              config.service.binding,
              config.service.lease,
              value,
            )
          if (config.pointer) {
            writeFileSync(config.pointer, JSON.stringify(value), { mode: 0o600 })
            const fd = openSync(config.pointer, 'r')
            try {
              fsyncSync(fd)
            } finally {
              closeSync(fd)
            }
          }
        })
        line({ checkpointId: manifest.checkpointId })
      } finally {
        store?.close()
      }
    } else if (mode === 'restore') {
      await repo.restore(config.checkpointId, config.identity, async () => {
        if (config.fault === 'commit') throw new Error('injected-before-commit')
      })
      line({ restored: true })
    } else throw new Error('fixture-mode')
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
