import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
function run(command: string, name: string) {
  const r = spawnSync(command, [path.join(here, name)], {encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}})
  assert.equal(r.status, 0, r.stdout+r.stderr)
  return r.stdout+r.stderr
}
test('durable generic policy decisions and filesystem boundaries',()=>{
  assert.match(run('python3','v5ReleasePolicy.test.py'), /Ran 23 tests/)
})
test('real shared saga retains healthy candidate and preserves legacy safety guards',()=>{
  assert.match(run('bash','v5-release-policy-drill.sh'), /RESULT PASS=87 FAIL=0/)
})
test('real shared saga precise red and green faults',()=>{
  assert.match(run('bash','v5-release-policy-red-drill.sh'), /POLICY_RED_GREEN ablated=1 actual=0 faultHits=1:1/)
})
test('commercial data adapter and actual outer paths',()=>{
  const output = run('python3','v5CommercialReleasePolicy.test.py')
  assert.match(output, /Ran 26 tests/)
  assert.match(output, /test_actual_keep_failed_reopens_only_weibo_gate_closed_by_this_deploy .*ok/)
  console.log(output.trim())
})

test('real commercial egress exact convergence and outage restoration',()=>{
  assert.match(run('python3','v5CommercialEgressRecovery.test.py'), /Ran 9 tests/)
})

test('actual history readers drain large input and preserve read and append failures',()=>{
  const output = run('python3','v5RuntimeHistoryDrain.test.py')
  assert.match(output, /Ran 5 tests/)
  assert.match(output, /test_large_last_and_nth_drain_without_revalidating_older_rows .*ok/)
  console.log(output.trim())
})
