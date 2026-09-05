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

export function listenExclusive(server, { host, port, ipv6Only } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address())
    }
    server.once('error', onError)
    server.once('listening', onListening)
    const opts = { host, port, exclusive: true }
    if (ipv6Only === true) opts.ipv6Only = true
    server.listen(opts)
  })
}

export async function listenLoopbackPair(createServer, port, { alsoV6 = true } = {}) {
  const v4 = createServer()
  await listenExclusive(v4, { host: LOOPBACK_V4, port })
  const boundPort = v4.address().port
  let v6 = null
  if (alsoV6) {
    v6 = createServer()
    try {
      await listenExclusive(v6, { host: LOOPBACK_V6, port: boundPort, ipv6Only: true })
    } catch (err) {
      v4.close()
      try { v6.close() } catch { /* */ }
      throw err
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
