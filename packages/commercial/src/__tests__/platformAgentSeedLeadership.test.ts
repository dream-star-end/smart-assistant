import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

test('V5 platform preset seed follows leadership acquire instead of standby startup', () => {
  assert.match(
    source,
    /onAcquire: async \(\) => \{\s*await leaderBundle\.start\(\);\s*await seedPlatformAgentsForLeadership\(\);/,
    'dual-master acquire must await the idempotent platform preset seed',
  )
  assert.match(
    source,
    /if \(runtimeChannel === "v5"\) \{\s*seedPlatformAgentsForLeadership = async \(\) => \{/,
    'only V5 should install the marketplace preset seeder',
  )
  assert.match(
    source,
    /else if \(controlPlaneEnabled\) \{\s*await leaderBundle\.start\(\);\s*await seedPlatformAgentsForLeadership\(\);/,
    'the legacy single-leader path must preserve leader-only seed semantics',
  )

  assert.equal(
    source.match(/await seedPlatformAgentsForLeadership\(\);/g)?.length,
    2,
    'the seeder may run only from dual-master acquire or the single-leader path',
  )
  assert.equal(
    source.match(/seedPlatformGeneralAgents\(\{/g)?.length,
    1,
    'general presets must have one leadership-gated seed call',
  )
  assert.equal(
    source.match(/seedPlatformResearchAgents\(\{/g)?.length,
    1,
    'research presets must have one leadership-gated seed call',
  )
})
