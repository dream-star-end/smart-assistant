import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateManifest } from "./candidateManifest.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const verify = fileURLToPath(new URL("./sixHttpVerify.ts", import.meta.url));
const target = join(root, "packages/commercial/src/http/proxy/boxToolInputHash.ts");

function runVerify(expectPath: string, wirePath: string) {
  return spawnSync("/usr/bin/tsx", [verify, "--wire", wirePath, "--expect", expectPath],
    { cwd: root, encoding: "utf8", timeout: 60_000 });
}

test("verify rejects a dependency changed after the capture manifest was saved", () => {
  const original = readFileSync(target);
  const dir = mkdtempSync(join(tmpdir(), "ocv5-bind-"));
  const expectPath = join(dir, "expect.json");
  const wirePath = join(dir, "wire.json");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  writeFileSync(expectPath, JSON.stringify({ head, manifest: candidateManifest() }));
  writeFileSync(wirePath, "{}\n");
  writeFileSync(target, Buffer.concat([original, Buffer.from("\n")]));
  try {
    const changed = runVerify(expectPath, wirePath);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stdout, /MANIFEST_BEFORE/);
  } finally {
    writeFileSync(target, original);
  }
  assert.ok(readFileSync(target).equals(original));
  const stable = runVerify(expectPath, wirePath);
  assert.notEqual(stable.status, 0);
  assert.match(stable.stdout, /VERIFY_COUNT/);
  assert.doesNotMatch(stable.stdout, /MANIFEST_BEFORE/);
});
