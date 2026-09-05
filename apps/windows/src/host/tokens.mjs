import { randomBytes, timingSafeEqual } from 'node:crypto'

export const LOCAL_BRIDGE_HEADER = 'x-openclaude-local-bridge'
export const LOCAL_BRIDGE_HEADER_CANON = 'X-OpenClaude-Local-Bridge'
export const LAH_PREFIX = 'oc-lah.'
export const LAH_GW_PREFIX = 'oc-lah-gw.'
export const FORBIDDEN_GATEWAY_ENV = Object.freeze([
  'OPENCLAUDE_TRUST_BRIDGE_IP',
  'OC_CONTAINER_ID',
  'OC_BRIDGE_NONCE',
  'OPENCLAUDE_V3_CONTAINER_TOKEN_FILE',
])

export function randomHex(bytes = 32) {
  return randomBytes(bytes).toString('hex')
}

export function createLocalBridgeToken() {
  return randomHex(32)
}

export function createLahToken() {
  return `${LAH_PREFIX}${randomHex(32)}`
}

export function createLahGwToken() {
  return `${LAH_GW_PREFIX}${randomHex(32)}`
}

export function timingSafeEqualString(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

export function bearerToken(header) {
  if (typeof header !== 'string') return ''
  const match = header.match(/^Bearer\s+(\S+)\s*$/i)
  return match ? match[1] : ''
}

export function checkBearerToken(header, expected) {
  return timingSafeEqualString(bearerToken(header), expected)
}

export function stripForbiddenGatewayEnv(env) {
  const out = { ...env }
  for (const key of FORBIDDEN_GATEWAY_ENV) delete out[key]
  return out
}
