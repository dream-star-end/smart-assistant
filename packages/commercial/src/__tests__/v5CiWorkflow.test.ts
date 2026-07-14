import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORKFLOW = readFileSync(pathResolve(REPO_ROOT, ".github/workflows/v5-ci.yml"), "utf8");

describe("Aurora v5 CI artifact contract", () => {
  test("commercial-unit runner and uploader share one TAP path", () => {
    assert.match(WORKFLOW, /^ {6}COMMERCIAL_UNIT_TAP: commercial-unit\.tap$/m);
    assert.match(
      WORKFLOW,
      /- name: Run commercial unit tests \(baseline diff gate\)\n {8}env:\n {10}TAP_OUT: \$\{\{ env\.COMMERCIAL_UNIT_TAP \}\}/,
    );
    assert.match(WORKFLOW, /^ {10}path: \$\{\{ env\.COMMERCIAL_UNIT_TAP \}\}$/m);
    assert.match(WORKFLOW, /^ {10}if-no-files-found: error$/m);
  });
});
