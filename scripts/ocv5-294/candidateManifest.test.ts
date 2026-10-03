import test from "node:test";
import assert from "node:assert/strict";
import { candidateManifest, manifestDrift } from "./candidateManifest.ts";

test("the verifier manifest covers gate, normalizer, matcher, catalog, and context dependencies", () => {
  const manifest = candidateManifest();
  const names = manifest.map((item) => item.path);
  for (const name of ["boxRequestGate.ts", "boxCacheAnnotations.ts", "boxToolResultMatcher.ts",
    "boxToolCatalog.ts", "boxCallFingerprint.ts", "boxMessagesMapper.ts", "boxToolInputHash.ts"]) {
    assert.equal(names.includes(name), true, name);
  }
  assert.ok(manifest.length > 3);
  assert.equal(manifestDrift(manifest, candidateManifest()), null);
  const changed = manifest.map((item, index) => index === 0 ? { ...item, sha256: "0".repeat(64) } : item);
  assert.match(manifestDrift(manifest, changed) ?? "", /^MANIFEST_DRIFT_/);
});
