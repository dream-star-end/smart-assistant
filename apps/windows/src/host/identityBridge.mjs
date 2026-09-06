import { normalizeIdentityRecord } from '../identity.mjs'
import { assertTunnelIdentity } from '../tunnel/identity.mjs'

/**
 * Adapt an S1 IdentityStore record into the S2 tunnel identity surface.
 * oc-v3 lives only in this object (Host memory). The S1 record never holds it.
 */
export function createIdentityBridge(record) {
  const persisted = normalizeIdentityRecord(record)
  let token = null
  let generation = 0
  let containerId = persisted.containerId ?? null

  const identity = {
    getCertPem() {
      return persisted.device_cert
    },
    getKeyPem() {
      return persisted.device_key
    },
    getDeviceCredential() {
      return persisted.device_credential
    },
    getDeviceId() {
      return persisted.deviceId
    },
    getContainerId() {
      return containerId
    },
    getToken() {
      if (!token) throw new Error('oc-v3 session is not minted')
      return token
    },
    getGeneration() {
      return generation
    },
    hasSession() {
      return typeof token === 'string' && token.startsWith('oc-v3.')
    },
    setSession(nextToken, nextGeneration, nextContainerId) {
      if (typeof nextToken !== 'string' || !nextToken.startsWith('oc-v3.')) {
        throw new TypeError('setSession requires oc-v3 token')
      }
      token = nextToken
      if (nextGeneration !== undefined) generation = Number(nextGeneration) || 0
      if (nextContainerId !== undefined && nextContainerId !== null) {
        containerId = nextContainerId
      }
    },
    clearSession() {
      token = null
    },
    persistedRecord() {
      return { ...persisted }
    },
  }
  assertTunnelIdentity(identity)
  return identity
}
