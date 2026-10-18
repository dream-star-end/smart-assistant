import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkWebReactReport } from './check-web-react-report.mjs';

const file = (name) => `/home/runner/work/repo/repo/packages/web-react/src/${name}.test.tsx`;
const inventory = [{ file: file('a') }, { file: file('b') }];
const report = () => ({
  success: true, numFailedTestSuites: 0, numFailedTests: 0, numTotalTests: 2,
  testResults: ['a', 'b'].map((name) => ({ name: file(name), status: 'passed', assertionResults: [{ status: 'passed' }] })),
});

test('a real-shaped Vitest report covers the complete inventory', () => {
  assert.deepEqual(checkWebReactReport(inventory, report()), { files: 2, tests: 2 });
});

test('failed, empty and malformed reports cannot pass', () => {
  assert.throws(() => checkWebReactReport([], report()), /inventory/);
  for (const changed of [
    { success: false }, { numFailedTests: 1 }, { numFailedTestSuites: 1 },
    { numTotalTests: 0 }, { testResults: [] },
  ]) assert.throws(() => checkWebReactReport(inventory, { ...report(), ...changed }));
  const failedFile = report();
  failedFile.testResults[0].status = 'failed';
  assert.throws(() => checkWebReactReport(inventory, failedFile), /did not pass/);
  const failedAssertion = report();
  failedAssertion.testResults[0].assertionResults[0].status = 'failed';
  assert.throws(() => checkWebReactReport(inventory, failedAssertion), /failed assertion/);
});

test('omitted, duplicate, extra and out-of-tree test files fail closed', () => {
  assert.throws(() => checkWebReactReport([...inventory, { file: file('new') }], report()), /missing test files/);
  const duplicate = report();
  duplicate.testResults[1] = duplicate.testResults[0];
  assert.throws(() => checkWebReactReport(inventory, duplicate), /duplicate test file/);
  const extra = report();
  extra.testResults[1].name = file('extra');
  assert.throws(() => checkWebReactReport(inventory, extra), /unexpected test file/);
  assert.throws(() => checkWebReactReport([...inventory, inventory[0]], report()), /duplicate file/);
  assert.throws(() => checkWebReactReport([{ file: '/tmp/a.test.ts' }], report()), /outside/);
  assert.throws(() => checkWebReactReport([{ file: file('../../escape') }], report()), /invalid test file/);
});

test('the CLI rejects missing or invalid JSON artifacts with a nonzero exit', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'web-report-artifacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = fileURLToPath(new URL('./check-web-react-report.mjs', import.meta.url));
  const files = ['inventory', 'report'].map((name) => path.join(dir, `${name}.json`));
  [inventory, report()].forEach((data, index) => writeFileSync(files[index], JSON.stringify(data)));
  const run = () => spawnSync(process.execPath, [helper, ...files], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  writeFileSync(files[1], '{invalid json');
  assert.equal(run().status, 1);
  rmSync(files[1]);
  assert.equal(run().status, 1);
});

test('workflow runs the complete suite in the existing required job with two workers', () => {
  const workflow = readFileSync(new URL('../workflows/v5-selfhost-web-react.yml', import.meta.url), 'utf8');
  const unit = workflow.slice(workflow.indexOf('  web-react:\n'), workflow.indexOf('  web-react-browser:'));
  assert.match(unit, /name: selfhost-web-react\n/);
  assert.match(unit, /timeout-minutes: 30/);
  assert.match(unit, /run: node --test .github\/scripts\/web-react-report.test.mjs/);
  assert.match(unit, /npm run test --workspace packages\/web-react -- --maxWorkers=2 --reporter=default --reporter=json/);
  assert.doesNotMatch(unit, /--shard|--testNamePattern|--exclude|matrix:/);
  assert.match(unit, /list --filesOnly --json=/);
  assert.match(unit, /check-web-react-report.mjs/);
  assert.match(unit, /if-no-files-found: error/);
  const config = readFileSync(new URL('../../packages/web-react/vite.config.ts', import.meta.url), 'utf8');
  assert.match(config, /maxWorkers: "25%"/);
  const browser = workflow.slice(workflow.indexOf('  web-react-browser:'));
  assert.match(browser, /run: npm run test:browser/);
  assert.match(browser, /run: node --test scripts\/lib\/user-contract-\*\.test.mjs/);
});
