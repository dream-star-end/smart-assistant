import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkWebReactShards } from './check-web-react-shards.mjs';

const file = (name) => `/home/runner/work/repo/repo/packages/web-react/src/${name}.test.tsx`;
const inventory = [{ file: file('a') }, { file: file('b') }];
const report = (name) => ({
  success: true, numFailedTestSuites: 0, numFailedTests: 0, numTotalTests: 1,
  testResults: [{ name: file(name), status: 'passed', assertionResults: [{ status: 'passed' }] }],
});
const reports = () => [report('a'), report('b')];

test('two real-shaped Vitest reports cover the complete inventory', () => {
  assert.deepEqual(checkWebReactShards('success', inventory, reports()), { shards: 2, files: 2, tests: 2 });
});

for (const status of ['failure', 'cancelled', 'skipped', undefined]) {
  test(`aggregate rejects matrix result ${status}`, () => {
    assert.throws(() => checkWebReactShards(status, inventory, reports()), /shard jobs ended/);
  });
}

test('missing or malformed reports and empty inventories cannot pass', () => {
  assert.throws(() => checkWebReactShards('success', inventory, [report('a')]), /expected 2/);
  assert.throws(() => checkWebReactShards('success', [], reports()), /inventory/);
  for (const changed of [
    { success: false }, { numFailedTests: 1 }, { numFailedTestSuites: 1 },
    { numTotalTests: 0 }, { testResults: [] },
  ]) {
    const changedReports = reports();
    Object.assign(changedReports[0], changed);
    assert.throws(() => checkWebReactShards('success', inventory, changedReports));
  }
});

test('failed files and assertions cannot hide behind aggregate success', () => {
  const failedFile = reports();
  failedFile[0].testResults[0].status = 'failed';
  assert.throws(() => checkWebReactShards('success', inventory, failedFile), /did not pass/);
  const failedAssertion = reports();
  failedAssertion[0].testResults[0].assertionResults[0].status = 'failed';
  assert.throws(() => checkWebReactShards('success', inventory, failedAssertion), /failed assertion/);
});

test('omitted, duplicate, extra and out-of-tree test files fail closed', () => {
  assert.throws(() => checkWebReactShards('success', [...inventory, { file: file('new') }], reports()), /missing test files/);
  assert.throws(() => checkWebReactShards('success', inventory, [report('a'), report('a')]), /duplicate test file/);
  assert.throws(() => checkWebReactShards('success', inventory, [report('a'), report('extra')]), /unexpected test file/);
  assert.throws(() => checkWebReactShards('success', [...inventory, inventory[0]], reports()), /duplicate file/);
  assert.throws(() => checkWebReactShards('success', [{ file: '/tmp/a.test.ts' }], reports()), /outside/);
  assert.throws(() => checkWebReactShards('success', [{ file: file('../..\/escape') }], reports()), /invalid test file/);
});

test('the CLI rejects missing or invalid JSON artifacts with a nonzero exit', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'web-shards-artifacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = fileURLToPath(new URL('./check-web-react-shards.mjs', import.meta.url));
  const files = ['inventory', 'report1', 'report2'].map((name) => path.join(dir, `${name}.json`));
  [inventory, ...reports()].forEach((data, index) => writeFileSync(files[index], JSON.stringify(data)));
  const run = () => spawnSync(process.execPath, [helper, 'success', ...files], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  writeFileSync(files[2], '{invalid json');
  assert.equal(run().status, 1);
  rmSync(files[2]);
  assert.equal(run().status, 1);
});

test('workflow retains the required context, both shards and the browser gate', () => {
  const workflow = readFileSync(new URL('../workflows/v5-selfhost-web-react.yml', import.meta.url), 'utf8');
  const shards = workflow.slice(workflow.indexOf('  web-react-shards:'), workflow.indexOf('  web-react:\n'));
  assert.match(shards, /fail-fast: false/);
  assert.match(shards, /shard: \[1, 2\]/);
  assert.match(shards, /npm run test --workspace packages\/web-react -- --shard=\$\{\{ matrix.shard \}\}\/2/);
  assert.match(shards, /list --filesOnly --json=/);
  assert.match(shards, /--reporter=default --reporter=json --outputFile.json=/);
  assert.equal((shards.match(/if-no-files-found: error/g) ?? []).length, 2);
  const aggregate = workflow.slice(workflow.indexOf('  web-react:\n'), workflow.indexOf('  web-react-browser:'));
  assert.match(aggregate, /name: selfhost-web-react\n/);
  assert.match(aggregate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(aggregate, /needs: web-react-shards/);
  assert.match(aggregate, /test "\$SHARD_RESULT" = success/);
  assert.match(aggregate, /needs.web-react-shards.result/);
  assert.match(aggregate, /check-web-react-shards.mjs/);
  assert.match(aggregate, /selfhost-web-react-report-1\/web-react-report.json/);
  assert.match(aggregate, /selfhost-web-react-report-2\/web-react-report.json/);
  const browser = workflow.slice(workflow.indexOf('  web-react-browser:'));
  assert.match(browser, /run: npm run test:browser/);
  assert.match(browser, /run: node --test scripts\/lib\/user-contract-\*\.test.mjs/);
});
