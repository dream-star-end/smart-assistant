/**
 * Host child IPC. Production Electron uses utilityProcess parentPort;
 * Node tests use child_process.fork process.send.
 */
import { isIpcRecord, HostToElectron, HOST_IPC_VERSION } from './ipc.mjs'

export function detectHostIpcChannel(proc = process) {
  const parentPort = proc.parentPort
  if (parentPort && typeof parentPort.postMessage === 'function' && typeof parentPort.on === 'function') {
    return {
      kind: 'parentPort',
      send(message) {
        parentPort.postMessage(message)
      },
      onMessage(handler) {
        parentPort.on('message', (event) => {
          handler(event && typeof event === 'object' && 'data' in event ? event.data : event)
        })
      },
      onDisconnect(handler) {
        parentPort.on?.('close', handler)
        proc.on?.('disconnect', handler)
      },
    }
  }
  if (typeof proc.send === 'function') {
    return {
      kind: 'process.send',
      send(message) {
        proc.send(message)
      },
      onMessage(handler) {
        proc.on('message', handler)
      },
      onDisconnect(handler) {
        proc.on('disconnect', handler)
      },
    }
  }
  return null
}

export function announceHostReady(channel, extra = {}) {
  if (!channel) return
  channel.send({
    type: HostToElectron.READY,
    v: HOST_IPC_VERSION,
    pid: process.pid,
    ...extra,
  })
}

export { isIpcRecord }
