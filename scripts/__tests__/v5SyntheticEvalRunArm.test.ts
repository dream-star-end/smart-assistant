import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertSameLane,
  hashSafeTree,
  parseReprovisionResult,
  parseRunArmArgs,
  parseTurnResult,
  verifyHelper,
} from "../v5-synthetic-eval-run-arm.mjs";

const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "../..");
const runner = join(repoRoot, "scripts/v5-synthetic-eval-run-arm.mjs");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  chmodSync(directory, 0o700);
  return directory;
}

function validArgs(arm: "A" | "B" = "A"): string[] {
  const base = "a".repeat(40);
  const candidate = arm === "A" ? base : "b".repeat(40);
  return [
    "--arm",
    arm,
    "--uid",
    arm === "A" ? "247" : "626",
    "--engine",
    arm === "A" ? "ccb" : "codex",
    "--agent-id",
    "research-assistant",
    "--base-sha",
    base,
    "--candidate-sha",
    candidate,
    "--reprovision-helper",
    "/root/eval/reprovision.mjs",
    "--reprovision-helper-sha",
    "c".repeat(64),
    "--reprovision-helper-root",
    "/root/eval",
    "--reprovision-helper-tree-sha",
    "e".repeat(64),
    "--turn-helper",
    "/root/eval/capture.mjs",
    "--turn-helper-sha",
    "d".repeat(64),
    "--turn-helper-root",
    "/root/eval",
    "--turn-helper-tree-sha",
    "e".repeat(64),
    "--evidence-file",
    `/root/eval/${arm}.json`,
  ];
}

describe("V5 synthetic exact-eval run-arm", () => {
  test("accepts only complete fixed synthetic A/B identities and bounded timeouts", () => {
    const armA = parseRunArmArgs(validArgs("A"));
    assert.equal(armA.uid, 247);
    assert.equal(armA.timeoutSeconds, 900);
    assert.equal(armA.apply, false);
    const armB = parseRunArmArgs([
      ...validArgs("B"),
      "--timeout-seconds",
      "1050",
      "--apply",
    ]);
    assert.equal(armB.uid, 626);
    assert.equal(armB.timeoutSeconds, 1_050);
    assert.equal(armB.apply, true);

    const wrongA = validArgs("A");
    wrongA[wrongA.indexOf("--candidate-sha") + 1] = "b".repeat(40);
    assert.throws(() => parseRunArmArgs(wrongA), /arm A must stage/);
    const wrongB = validArgs("B");
    wrongB[wrongB.indexOf("--candidate-sha") + 1] = "a".repeat(40);
    assert.throws(() => parseRunArmArgs(wrongB), /arm B must stage/);
    assert.throws(
      () => parseRunArmArgs([...validArgs("A"), "--timeout-seconds", "1051"]),
      /incomplete or invalid/,
    );
    assert.throws(
      () => parseRunArmArgs(validArgs("A").map((value) =>
        value === "/root/eval/A.json" ? "relative.json" : value
      )),
      /absolute normalized/,
    );
  });

  test("freezes root-owned helper bytes and rejects mutation or unsafe modes", () => {
    const directory = temp("v5-run-arm-helper-");
    const helper = join(directory, "helper.mjs");
    writeFileSync(helper, "console.log('{}')\n", { mode: 0o600 });
    chmodSync(helper, 0o600);
    const digest = createHash("sha256").update(readFileSync(helper)).digest("hex");
    const treeDigest = hashSafeTree(directory);
    assert.deepEqual(verifyHelper(helper, digest, directory, treeDigest), {
      path: helper,
      sha256: digest,
      root: directory,
      treeSha256: treeDigest,
    });
    assert.throws(
      () => verifyHelper(helper, "0".repeat(64), directory, treeDigest),
      /SHA mismatch/,
    );
    assert.throws(
      () => verifyHelper(helper, digest, directory, "0".repeat(64)),
      /dependency tree SHA mismatch/,
    );
    chmodSync(helper, 0o622);
    assert.throws(
      () => verifyHelper(helper, digest, directory, treeDigest),
      /group\/other writable/,
    );
  });

  test("parses fresh-container and true-turn helper evidence without trusting logs", () => {
    const containerId = "e".repeat(64);
    const reprovision = parseReprovisionResult(JSON.stringify({
      id: containerId,
      started_at: "2026-07-31T10:00:00.000Z",
    }));
    assert.equal(reprovision.id, containerId);
    assert.throws(
      () => parseReprovisionResult(JSON.stringify({ id: "short", started_at: "x" })),
      /invalid/,
    );

    const directory = temp("v5-run-arm-result-");
    const resultPath = join(directory, "turn.json");
    writeFileSync(resultPath, JSON.stringify({ peer_id: "peer_0123456789" }), {
      mode: 0o600,
    });
    chmodSync(resultPath, 0o600);
    const turn = parseTurnResult(resultPath);
    assert.equal(turn.peerId, "peer_0123456789");
    assert.equal(turn.source?.path, resultPath);
    assert.match(turn.source?.sha256 ?? "", /^[0-9a-f]{64}$/);
  });

  test("lane comparison ignores expected per-turn counters but rejects production drift", () => {
    const before = {
      phase: "stable",
      activeSlot: "A",
      candidateSlot: null,
      activeRelease: "/release",
      candidateRelease: null,
      cohortPercent: 0,
      lockVersion: 7,
      sourceCommit: "a".repeat(40),
      enabledCron: 0,
      cronFileEnabled: 0,
      v3State: "inactive",
      dispatchCount: 3,
      openDispatchCount: 0,
      usageCount: 4,
    };
    assert.doesNotThrow(() =>
      assertSameLane(before, {
        ...before,
        dispatchCount: 4,
        usageCount: 6,
      })
    );
    assert.throws(
      () => assertSameLane(before, { ...before, activeSlot: "B" }),
      /activeSlot/,
    );
    assert.throws(
      () => assertSameLane(before, { ...before, v3State: "active" }),
      /v3State/,
    );
  });

  test("source keeps one outer lease, measures actual prompt bytes, and restores in finally", () => {
    const source = readFileSync(runner, "utf8");
    assert.match(source, /assertLeaseEnvironment\(\)/);
    assert.equal(
      source.match(/with-production-mutation-lease\.sh/g)?.length,
      1,
      "the wrapper name appears only in usage; the runner never nests it",
    );
    assert.match(source, /"container-evidence"/);
    assert.match(source, /"extra-prompt-evidence"/);
    assert.match(source, /"standard-container-evidence"/);
    assert.match(source, /const prepareNonce = randomBytes\(16\)\.toString\("hex"\)/);
    assert.match(source, /"--nonce",\s+prepareNonce/);
    assert.match(source, /"--manifest-sha",\s+expectedManifestSha/);
    assert.match(source, /OC_SYNTHETIC_EVAL_PHASE: phase/);
    assert.match(source, /name !== "OC_V5_MANUAL_LEASE_NONCE"/);
    assert.equal(
      source.match(/"--foreground"/g)?.length,
      2,
      "helpers remain in the outer lease command group",
    );
    assert.match(source, /assertRunnerCommandGroupLeader\(\)/);
    assert.match(source, /terminateCommandGroupChildren\(\)/);
    assert.match(source, /processGroupId === process\.pid/);
    assert.equal(
      source.match(/spawnSync\("timeout"/g)?.length,
      2,
      "both external chains use bounded timeout plus exact descendant cleanup",
    );
    assert.match(source, /--kill-after=15s/);
    assert.match(source, /post\.dispatchCount !== pre\.dispatchCount \+ 1/);
  });

  test("help is side-effect free and a real arm fails before git/ssh without wrapper proof", () => {
    const help = spawnSync(process.execPath, [runner, "--help"], {
      encoding: "utf8",
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /one\s+official production-mutation lease/);

    const noLease = spawnSync(process.execPath, [runner, ...validArgs("A")], {
      encoding: "utf8",
      env: {
        ...process.env,
        OC_V5_MANUAL_LEASE_NONCE: "",
        OC_V5_MANUAL_LEASE_PROOF: "",
        PATH: "/nonexistent",
      },
    });
    assert.equal(noLease.status, 2);
    assert.match(noLease.stderr, /with-production-mutation-lease/);
    assert.doesNotMatch(noLease.stderr, /git|ssh/);
  });
});
