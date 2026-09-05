/**
 * Minimal identity surface S2 needs from S1 IdentityStore.
 *
 *   { getCertPem(), getKeyPem(), getToken() }
 *
 * Optional: getGeneration(), setSession(token, generation) for token rotation.
 * S1 may implement a richer store; confluence is the captain's job.
 */

export function assertTunnelIdentity(identity) {
  if (!identity || typeof identity.getCertPem !== 'function'
    || typeof identity.getKeyPem !== 'function'
    || typeof identity.getToken !== 'function') {
    throw new Error('identity must provide getCertPem(), getKeyPem(), getToken()')
  }
}

export function createFixtureIdentityStore({
  certPem,
  keyPem,
  token,
  generation = 0,
} = {}) {
  let currentToken = token
  let currentGeneration = generation
  const store = {
    getCertPem() {
      if (!certPem) throw new Error('fixture identity has no cert')
      return certPem
    },
    getKeyPem() {
      if (!keyPem) throw new Error('fixture identity has no key')
      return keyPem
    },
    getToken() {
      if (!currentToken) throw new Error('fixture identity has no token')
      return currentToken
    },
    getGeneration() {
      return currentGeneration
    },
    setSession(nextToken, nextGeneration) {
      currentToken = nextToken
      if (nextGeneration !== undefined) currentGeneration = nextGeneration
    },
  }
  return store
}
