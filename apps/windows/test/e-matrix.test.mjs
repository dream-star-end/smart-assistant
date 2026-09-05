import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Design §10 E1–E18 coverage map. Each row is asserted so the matrix cannot
 * silently lose a row. Implementation lives in the named tests; P1 integ
 * rows are citations, not empty.
 */
export const E_MATRIX = Object.freeze([
  { id: 'E1', kind: 'automated', tests: ['E1 enroll → finish → 18445 token path → WSS register_ok muxVersion=1'] },
  { id: 'E2', kind: 'automated', tests: ['E2 full Gateway class + Host + fake-ccb one turn (Linux CI)'] },
  { id: 'E3', kind: 'automated', tests: ['heartbeat timeout degrades then reconnects', 'kick after register_ok backs off instead of storming'] },
  { id: 'E4', kind: 'automated', tests: ['token refresh drop reconnects with new token after in-flight drain'] },
  { id: 'E5', kind: 'automated', tests: ['expired token without refresh is unauthorized and does not keep the tunnel alive'] },
  { id: 'E6', kind: 'automated', tests: ['E6 killswitch 503 does not tight-loop: backoff >= killSwitchBackoffMs and UI falls back once'] },
  { id: 'E7', kind: 'automated', tests: ['E7 desktop gateway env pins OPENCLAUDE_ENGINES=ccb so cursor is client-side disabled', 'createEngine(cursor) under desktop env throws ENGINE_NOT_ENABLED'] },
  { id: 'E8', kind: 'automated', tests: ['S3c-4/5/6 real local-bridge gateway: healthz, needsAuth HTTP, WS, non-loopback'] },
  { id: 'E9', kind: 'citation', tests: ['packages/commercial/src/__tests__/desktopE2e.integ.test.ts (P1)'] },
  { id: 'E10', kind: 'automated', tests: ['E10 flag-off enroll 404 leaves cloud shell usable and stops local reconnect'] },
  { id: 'E11', kind: 'automated', tests: ['E11 injected event source drives suspend/resume/network_change hooks', 'suspend then resume forces a new connection'] },
  { id: 'E12', kind: 'automated', tests: ['win32 DES-02 proj-evil prefix is rejected (C:\\w\\proj vs C:\\w\\proj-evil\\x)'] },
  { id: 'E13', kind: 'automated', tests: ['requestApproval times out as deny when the injected timer fires'] },
  { id: 'E14', kind: 'automated', tests: ['fetchArtifact deletes a corrupt download and reports 运行时损坏'] },
  { id: 'E15', kind: 'citation', tests: ['packages/commercial/src/__tests__/desktopE2e.integ.test.ts (P1, same uid docker)'] },
  { id: 'E16', kind: 'automated', tests: ['E16 revoke deletes identity blob, stops Host/gateway, remint 401'] },
  { id: 'E17', kind: 'automated', tests: ['S3c-3 assertGatewayEnvSafe rejects TRUST_BRIDGE trio and oc-v3'] },
  { id: 'E18', kind: 'automated', tests: ['18791/18792 reject missing token with 401 and do not outbound'] },
])

test('E-matrix covers E1–E18 with no empty rows', () => {
  assert.equal(E_MATRIX.length, 18)
  for (let i = 0; i < 18; i += 1) {
    assert.equal(E_MATRIX[i].id, `E${i + 1}`)
    assert.ok(E_MATRIX[i].kind === 'automated' || E_MATRIX[i].kind === 'citation' || E_MATRIX[i].kind === 'manual')
    assert.ok(E_MATRIX[i].tests.length >= 1)
  }
  const automated = E_MATRIX.filter((row) => row.kind === 'automated').length
  const citation = E_MATRIX.filter((row) => row.kind === 'citation').length
  assert.equal(automated, 16)
  assert.equal(citation, 2)
})
