import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  ALLOWLIST,
  classify,
  globToRegExp,
  parseAllowlist,
  stalePatterns,
  summarize,
} from "../check-v5-two-tree-divergence.ts";

const ROOT = resolve(import.meta.dirname, "../..");

test("* stays inside one path segment, ** crosses segments", () => {
  assert.ok(globToRegExp("scripts/*selfhost*").test("scripts/deploy-v5-selfhost.sh"));
  assert.ok(!globToRegExp("scripts/*selfhost*").test("scripts/__tests__/selfhostSourcePin.node-test.mjs"));
  assert.ok(globToRegExp("deploy/v5-selfhost/**").test("deploy/v5-selfhost/units/a.service"));
  assert.ok(!globToRegExp("deploy/v5-selfhost/**").test("deploy/v5/units/a.service"));
  assert.ok(!globToRegExp("a.b").test("axb"), "dots are literal");
});

test("comments and blank lines are not patterns", () => {
  assert.deepEqual(parseAllowlist("# head\n\nscripts/*selfhost*  # trailing\n  \n"), ["scripts/*selfhost*"]);
});

test("each diverged path is classified as selfhost-only or shared", () => {
  const out = classify(
    "M\tscripts/deploy-v5-selfhost.sh\nM\tpackages/web-react/src/App.tsx\nA\tdeploy/v5-selfhost/x.env\n",
    ["scripts/*selfhost*", "deploy/v5-selfhost/**"],
  );
  assert.deepEqual(out, [
    { status: "M", path: "scripts/deploy-v5-selfhost.sh", allowed: true },
    { status: "M", path: "packages/web-react/src/App.tsx", allowed: false },
    { status: "A", path: "deploy/v5-selfhost/x.env", allowed: true },
  ]);
  assert.match(summarize(out), /shared: 1/);
  assert.match(summarize(out), /1 {2}packages\/web-react/);
});

test("a pattern that matches no tracked file is reported as stale", () => {
  assert.deepEqual(stalePatterns(["scripts/*selfhost*", "gone/**"], ["scripts/deploy-v5-selfhost.sh"]), ["gone/**"]);
});

test("the committed allowlist only names selfhost deploy, selfhost scripts and selfhost CI", () => {
  const patterns = parseAllowlist(readFileSync(join(ROOT, ALLOWLIST), "utf8"));
  assert.ok(patterns.length > 0);
  for (const pattern of patterns) {
    assert.match(pattern, /selfhost/i, `${pattern} is not selfhost-specific`);
    assert.ok(!pattern.startsWith("packages/"), `${pattern}: shared packages must stay identical`);
  }
});
