import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function checkWebReactReport(inventory, report) {
  assert.ok(Array.isArray(inventory) && inventory.length > 0, 'full test inventory is missing or empty');
  const expected = new Set(inventory.map((entry) => testFile(entry.file)));
  assert.equal(expected.size, inventory.length, 'duplicate file in full test inventory');
  assert.equal(report.success, true, 'web-react test run did not pass');
  assert.equal(report.numFailedTestSuites, 0, 'web-react has failed suites');
  assert.equal(report.numFailedTests, 0, 'web-react has failed tests');
  assert.ok(Number.isInteger(report.numTotalTests) && report.numTotalTests > 0, 'web-react ran no tests');
  assert.ok(Array.isArray(report.testResults) && report.testResults.length > 0, 'web-react has no files');
  const seen = new Set();
  for (const suite of report.testResults) {
    const file = testFile(suite.name);
    assert.equal(suite.status, 'passed', `test file did not pass: ${file}`);
    assert.ok(expected.has(file), `unexpected test file: ${file}`);
    assert.ok(!seen.has(file), `duplicate test file: ${file}`);
    assert.ok(Array.isArray(suite.assertionResults), `missing assertions: ${file}`);
    assert.ok(!suite.assertionResults.some((item) => item.status === 'failed'), `failed assertion: ${file}`);
    seen.add(file);
  }
  const missing = [...expected].filter((file) => !seen.has(file));
  assert.deepEqual(missing, [], `missing test files: ${missing.join(', ')}`);
  return { files: seen.size, tests: report.numTotalTests };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 4, 'usage: check-web-react-report.mjs INVENTORY REPORT');
    const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
    const summary = checkWebReactReport(json(process.argv[2]), json(process.argv[3]));
    console.log(`web-react passed: files=${summary.files} tests=${summary.tests}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
