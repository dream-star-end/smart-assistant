import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARDS = 2;

function testFile(name) {
  assert.equal(typeof name, 'string', 'test file name must be a string');
  const marker = '/packages/web-react/';
  const index = name.lastIndexOf(marker);
  assert.ok(index >= 0, `test file outside packages/web-react: ${name}`);
  const relative = name.slice(index + marker.length);
  assert.ok(relative && !relative.startsWith('../') && path.posix.normalize(relative) === relative,
    `invalid test file path: ${name}`);
  return relative;
}

export function checkWebReactShards(result, inventory, reports) {
  assert.equal(result, 'success', `web-react shard jobs ended with ${result}`);
  assert.ok(Array.isArray(inventory) && inventory.length > 0, 'full test inventory is missing or empty');
  const expected = new Set(inventory.map((entry) => testFile(entry.file)));
  assert.equal(expected.size, inventory.length, 'duplicate file in full test inventory');
  assert.equal(reports.length, SHARDS, `expected ${SHARDS} shard reports`);
  const seen = new Set();
  let tests = 0;
  for (const [index, report] of reports.entries()) {
    assert.equal(report.success, true, `shard ${index + 1} did not pass`);
    assert.equal(report.numFailedTestSuites, 0, `shard ${index + 1} has failed suites`);
    assert.equal(report.numFailedTests, 0, `shard ${index + 1} has failed tests`);
    assert.ok(Number.isInteger(report.numTotalTests) && report.numTotalTests > 0, `shard ${index + 1} ran no tests`);
    assert.ok(Array.isArray(report.testResults) && report.testResults.length > 0, `shard ${index + 1} has no files`);
    tests += report.numTotalTests;
    for (const suite of report.testResults) {
      const file = testFile(suite.name);
      assert.equal(suite.status, 'passed', `test file did not pass: ${file}`);
      assert.ok(expected.has(file), `unexpected test file: ${file}`);
      assert.ok(!seen.has(file), `duplicate test file across shards: ${file}`);
      assert.ok(Array.isArray(suite.assertionResults), `missing assertions: ${file}`);
      assert.ok(!suite.assertionResults.some((item) => item.status === 'failed'), `failed assertion: ${file}`);
      seen.add(file);
    }
  }
  const missing = [...expected].filter((file) => !seen.has(file));
  assert.deepEqual(missing, [], `missing test files: ${missing.join(', ')}`);
  return { shards: SHARDS, files: seen.size, tests };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [result, inventory, ...reports] = process.argv.slice(2);
    assert.equal(reports.length, SHARDS, 'usage: check-web-react-shards.mjs RESULT INVENTORY REPORT1 REPORT2');
    const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
    const summary = checkWebReactShards(result, json(inventory), reports.map(json));
    console.log(`web-react shards passed: shards=${summary.shards} files=${summary.files} tests=${summary.tests}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
