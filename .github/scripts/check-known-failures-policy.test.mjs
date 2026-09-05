import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { checkDir, checkFile, isCoreEntry, parseCoreSuites } from "./check-known-failures-policy.mjs";

describe("known-failures admission policy", () => {
  test("empty / comment-only files are 0 hits", () => {
    const dir = mkdtempSync(join(tmpdir(), "kf-policy-"));
    try {
      writeFileSync(join(dir, "core-contract-suites.txt"), "# c\nrouteOwnership\n");
      writeFileSync(join(dir, "commercial-unit.txt"), "# leftover notes\n\n# another\n");
      const { problems } = checkDir(dir, { today: "2026-09-05" });
      assert.equal(problems.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing header is red", () => {
    const problems = checkFile(
      "x.txt",
      "someSuite — case\n",
      ["routeOwnership"],
      "2026-09-05",
    );
    assert.equal(problems[0].kind, "missing-header");
  });

  test("valid header + future expires passes", () => {
    const problems = checkFile(
      "x.txt",
      "# issue=OCV5-119 approved-by=agent:main expires=2026-12-31\nsomeSuite — case\n",
      ["routeOwnership"],
      "2026-09-05",
    );
    assert.equal(problems.length, 0);
  });

  test("expired header is red", () => {
    const problems = checkFile(
      "x.txt",
      "# issue=OCV5-1 approved-by=boss expires=2026-01-01\nsomeSuite — case\n",
      [],
      "2026-09-05",
    );
    assert.equal(problems[0].kind, "expired");
  });

  test("core-contract suite is red even with a valid header", () => {
    const core = parseCoreSuites("routeOwnership\n");
    assert.equal(isCoreEntry("routeOwnership — anything", core), true);
    const problems = checkFile(
      "x.txt",
      "# issue=OCV5-1 approved-by=boss expires=2026-12-31\nrouteOwnership — anything\n",
      core,
      "2026-09-05",
    );
    assert.equal(problems.some((p) => p.kind === "core-contract"), true);
  });
});
