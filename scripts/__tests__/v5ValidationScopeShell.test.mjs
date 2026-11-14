import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = readFileSync(path.join(root, 'scripts/deploy-v5.sh'), 'utf8');
function fn(name) {
  const start = source.indexOf(`\n${name}() {`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, name);
  return source.slice(start + 1, end + 2);
}
function bash(body, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'scope-shell-'));
  try {
    return spawnSync('bash', ['-c', `set -euo pipefail\nunset V5_TURN_MODELS\n${body}`], {
      cwd: root, encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, TMPDIR: dir, ...extra },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('explicit scope rejects unknown, missing authorization and ambient overrides before any writes', () => {
  for (const args of [
    ['--with-dist', '--validation-profile=unknown'],
    ['--with-dist', '--validation-profile=skip-grok'],
    ['--with-dist', '--validation-authorization-ref=explicit-user'],
  ]) {
    const run = spawnSync('bash', [path.join(root, 'scripts/deploy-v5.sh'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, V5_DEPLOY_SOURCE_ONLY: '1', ALLOW_ANY_BRANCH: '1' },
    });
    assert.equal(run.status, 2, run.stderr);
  }
  const run = spawnSync('bash', [path.join(root, 'scripts/deploy-v5.sh'), '--with-dist',
    '--validation-profile=skip-grok', '--validation-authorization-ref=explicit-user'], {
    cwd: root, encoding: 'utf8', timeout: 5_000,
    env: { ...process.env, V5_DEPLOY_SOURCE_ONLY: '1', ALLOW_ANY_BRANCH: '1', V5_TURN_MODELS: '' },
  });
  assert.equal(run.status, 2, run.stderr);
});

test('matrix keeps default engines; explicit scope calls only DeepSeek and cannot clear complete-gate debts', () => {
  for (const profile of ['normal', 'skip-grok']) {
    const run = bash(`
VALIDATION_PROFILE=${profile}; MODE=deploy; ACTIVE_PORT=18795
V5_TURN_ENGINE_MATRIX_DEFAULT='grok-build deepseek-v4-flash'
smoke_turn_canary() { echo "ACTUAL_MODEL=$3 COST_MODE=$4"; }
clear_gate_waiver() { echo "CLEARED=$1"; }
${fn('smoke_turn_matrix')}
smoke_turn_matrix /candidate 18795 stable
`);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /ACTUAL_MODEL=deepseek-v4-flash COST_MODE=live/);
    if (profile === 'normal') {
      assert.match(run.stdout, /ACTUAL_MODEL=grok-build/);
      assert.match(run.stdout, /CLEARED=smoke-turn/);
    } else {
      assert.doesNotMatch(run.stdout, /ACTUAL_MODEL=grok-build|CLEARED=|全部通过/);
      assert.match(run.stdout, /Grok matrix SKIPPED/);
    }
  }
});

test('scoped DeepSeek failure remains a blocking failure, with no false PASS', () => {
  const run = bash(`
VALIDATION_PROFILE=skip-grok; MODE=deploy; ACTIVE_PORT=18795
V5_TURN_ENGINE_MATRIX_DEFAULT='grok-build deepseek-v4-flash'
smoke_turn_canary() { echo "ACTUAL_MODEL=$3"; return 42; }
clear_gate_waiver() { echo 'MUST_NOT_CLEAR'; }
${fn('smoke_turn_matrix')}
smoke_turn_matrix /candidate 18795 stable
`);
  assert.equal(run.status, 1, run.stderr);
  assert.doesNotMatch(run.stdout, /passed|MUST_NOT_CLEAR|ACTUAL_MODEL=grok-build/);
});

test('functional core receipts record real serial and parallel failures and preserve journey requirement', () => {
  for (const parallel of ['0', '1']) {
    for (const failed of ['turn', 'journey', 'none']) {
      const run = bash(`
VALIDATION_PROFILE=skip-grok; VALIDATION_SCOPE_JSON='{}'; OC_V5_SMOKE_PARALLEL=${parallel}
validation_scope_bind() { :; }
validation_scope_receipt() { echo "RECEIPT=$1:$3:$4"; }
validation_scope_clear_repaid() { :; }
smoke_turn_matrix() { ${failed === 'turn' ? 'return 42' : ':'}; }
smoke_e2e_journey() { ${failed === 'journey' ? 'return 43' : ':'}; }
${fn('minimum_functional_core')}
minimum_functional_core deploy /candidate 18795
`);
      assert.equal(run.status, failed === 'none' ? 0 : 1, run.stderr);
      if (failed === 'none') assert.match(run.stdout, /RECEIPT=passed:passed:passed/);
      else {
        assert.match(run.stdout, /RECEIPT=failed:/);
        assert.doesNotMatch(run.stdout, /scoped functional core passed/);
      }
      assert.doesNotMatch(run.stdout, /双引擎真 turn [∥+] J1-J5 旅程/);
    }
  }
});

test('a non-Grok override cannot repay the new Grok debt', () => {
  const run = bash(`
VALIDATION_PROFILE=normal; V5_TURN_MODELS=deepseek-v4-flash
${fn('validation_scope_grok_matrix_planned')}
if validation_scope_grok_matrix_planned; then exit 9; fi
unset V5_TURN_MODELS
validation_scope_grok_matrix_planned
`);
  assert.equal(run.status, 0, run.stderr);
});
