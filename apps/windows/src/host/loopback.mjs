import net from 'node:net'

export const LOOPBACK_V4 = '127.0.0.1'
export const LOOPBACK_V6 = '::1'

export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const host = address.replace(/^\[/, '').replace(/\]$/, '')
  if (host === LOOPBACK_V4 || host === LOOPBACK_V6 || host === '::ffff:127.0.0.1') return true
  if (host.startsWith('::ffff:')) {
    return host.slice('::ffff:'.length) === LOOPBACK_V4
  }
  return false
}

export function remoteAddressOf(req) {
  return req?.socket?.remoteAddress || req?.connection?.remoteAddress || ''
}

export function listenExclusive(server, { host, port, ipv6Only, timeoutMs = 2_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err, addr) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.off('error', onError)
      server.off('listening', onListening)
      if (err) reject(err)
      else resolve(addr)
    }
    const onError = (err) => done(err)
    const onListening = () => done(null, server.address())
    const timer = setTimeout(() => {
      const err = new Error(`listen timeout ${host}:${port}`)
      err.code = 'LISTEN_TIMEOUT'
      try { server.close() } catch { /* */ }
      done(err)
    }, timeoutMs)
    server.once('error', onError)
    server.once('listening', onListening)
    const opts = { host, port, exclusive: true }
    if (ipv6Only === true) opts.ipv6Only = true
    server.listen(opts)
  })
}

const SOFT_V6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EACCES', 'EINVAL', 'LISTEN_TIMEOUT'])

/**
 * Windows lets 127.0.0.1 bind succeed beside an existing 0.0.0.0 listener.
 * Probe 0.0.0.0 exclusive first when the port is already chosen (W5).
 */
export async function assertWildcardPortFree(port) {
  if (!port) return
  const probe = net.createServer()
  try {
    await listenExclusive(probe, { host: '0.0.0.0', port, timeoutMs: 800 })
    await new Promise((resolve) => {
      probe.close(() => resolve())
    })
  } catch (err) {
    try { probe.close() } catch { /* */ }
    const wrapped = new Error('wildcard port occupant')
    wrapped.code = err.code === 'EACCES' ? 'EADDRINUSE' : (err.code || 'EADDRINUSE')
    wrapped.cause = err
    throw wrapped
  }
}

export async function listenLoopbackPair(createServer, port, { alsoV6 = true, requireV6 = false } = {}) {
  if (port) await assertWildcardPortFree(port)
  const v4 = createServer()
  await listenExclusive(v4, { host: LOOPBACK_V4, port })
  const boundPort = v4.address().port
  let v6 = null
  if (alsoV6) {
    v6 = createServer()
    try {
      await listenExclusive(v6, { host: LOOPBACK_V6, port: boundPort, ipv6Only: true })
    } catch (err) {
      try { v6.close() } catch { /* */ }
      v6 = null
      if (requireV6 || !SOFT_V6.has(err.code)) {
        try { v4.close() } catch { /* */ }
        throw err
      }
    }
  }
  return { v4, v6, port: boundPort }
}

export function closeServers(servers) {
  return Promise.all(
    (servers || []).filter(Boolean).map(
      (server) =>
        new Promise((resolve) => {
          try {
            server.close(() => resolve())
          } catch {
            resolve()
          }
        }),
    ),
  )
}
