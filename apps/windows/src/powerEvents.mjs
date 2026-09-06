/**
 * Sleep / wake / network-change bridge (design §4.2, E11).
 * Electron wires `powerMonitor` + `net`; tests inject an event source.
 */

export const POWER_EVENTS = Object.freeze(['suspend', 'resume', 'offline', 'online', 'network_change'])

export function normalizePowerEvent(event) {
  if (event === 'suspend' || event === 'resume') return event
  if (event === 'offline' || event === 'online' || event === 'network_change') return 'network_change'
  return null
}

export function createPowerEventBridge({
  onSuspend,
  onResume,
  onNetworkChange,
} = {}) {
  const attached = []

  function handle(event) {
    const normalized = normalizePowerEvent(event)
    if (normalized === 'suspend') onSuspend?.()
    else if (normalized === 'resume') onResume?.()
    else if (normalized === 'network_change') onNetworkChange?.()
    return normalized
  }

  function listen(emitter, event, mapped) {
    if (!emitter || typeof emitter.on !== 'function') return
    const handler = () => handle(mapped || event)
    emitter.on(event, handler)
    attached.push({ emitter, event, handler })
  }

  return {
    handle,
    attachElectron({ powerMonitor, net } = {}) {
      listen(powerMonitor, 'suspend', 'suspend')
      listen(powerMonitor, 'resume', 'resume')
      if (net && typeof net.on === 'function') {
        listen(net, 'online', 'online')
        listen(net, 'offline', 'offline')
      }
    },
    attachSource(source) {
      if (!source || typeof source.on !== 'function') return
      for (const event of POWER_EVENTS) listen(source, event, event)
    },
    detach() {
      for (const item of attached) {
        try {
          item.emitter.off?.(item.event, item.handler)
          item.emitter.removeListener?.(item.event, item.handler)
        } catch {
          /* */
        }
      }
      attached.length = 0
    },
  }
}
