import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import {
  activateSyntheticEvalRecord,
  classifySyntheticEvalContainer,
  parseSyntheticEvalManifest,
  parseSyntheticEvalRecord,
  SYNTHETIC_EVAL_MANIFEST_LABEL,
  SYNTHETIC_EVAL_NONCE_LABEL,
  SYNTHETIC_EVAL_UID_LABEL,
  syntheticEvalOverlayLabels,
  type SyntheticEvalManifest,
  type SyntheticEvalRecord,
} from "../agent-sandbox/syntheticEvalOverlay.js";
import {
  createSyntheticEvalOverlayRuntime,
  readSyntheticEvalReleaseSourceCommit,
  sha256SyntheticEvalTree,
} from "../agent-sandbox/syntheticEvalOverlayRuntime.js";

const NOW = Date.parse("2026-07-31T08:00:00.000Z");
const SHA = "a".repeat(64);

function record(
  overrides: Partial<SyntheticEvalRecord> = {},
): SyntheticEvalRecord {
  return {
    schemaVersion: 1,
    state: "prepared",
    uid: 247,
    nonce: "1".repeat(32),
    manifestSha: SHA,
    preparedAt: new Date(NOW - 1_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ...overrides,
  };
}

describe("syntheticEvalOverlay pure contract", () => {
  test("accepts only exact manifest/record schemas and fixed synthetic UIDs", () => {
    const manifest: SyntheticEvalManifest = {
      schemaVersion: 1,
      baseCommit: "1".repeat(40),
      candidateCommit: "2".repeat(40),
      files: {
        promptsTree: SHA,
        promptSlots: SHA,
        agents: SHA,
        claude: SHA,
        skillsTree: SHA,
      },
    };
    assert.deepEqual(parseSyntheticEvalManifest(manifest), manifest);
    assert.deepEqual(parseSyntheticEvalRecord(record(), NOW), record());
    assert.throws(
      () => parseSyntheticEvalRecord({ ...record(), uid: 5 }, NOW),
      /identity is invalid/,
    );
    assert.throws(
      () => parseSyntheticEvalRecord({ ...record(), extra: true }, NOW),
      /shape is invalid/,
    );
    assert.throws(
      () => parseSyntheticEvalRecord({
        ...record(),
        expiresAt: new Date(NOW + 1_500_001).toISOString(),
      }, NOW),
      /time window is invalid/,
    );
  });

  test("prepared→active is one-way and binds the exact docker identity", () => {
    const active = activateSyntheticEvalRecord(record(), "b".repeat(64));
    assert.equal(active.state, "active");
    assert.equal(active.containerId, "b".repeat(64));
    assert.throws(
      () => activateSyntheticEvalRecord(active, "c".repeat(64)),
      /not prepared/,
    );
  });

  test("default path is standard; prepared or orphan labels force stale", () => {
    assert.deepEqual(classifySyntheticEvalContainer(247, undefined, null), {
      mode: "standard",
    });
    assert.equal(
      classifySyntheticEvalContainer(247, undefined, record()).mode,
      "stale",
    );
    assert.equal(
      classifySyntheticEvalContainer(5, {
        [SYNTHETIC_EVAL_NONCE_LABEL]: "unexpected",
      }, null).mode,
      "stale",
    );
    const active = activateSyntheticEvalRecord(record(), "b".repeat(64));
    assert.equal(
      classifySyntheticEvalContainer(
        247,
        syntheticEvalOverlayLabels({
          uid: 247,
          nonce: active.nonce,
          manifestSha: active.manifestSha,
          candidateTreePath: "/unused",
          promptsHostPath: "/unused/prompts",
          promptSlotsHostPath: "/unused/promptSlots.ts",
          baselineHostPath: "/unused/baseline",
        }),
        active,
        "b".repeat(64),
      ).mode,
      "valid",
    );
  });
});

function writeSafe(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o644 });
  chmodSync(path, 0o644);
}

function buildRuntimeFixture(): {
  root: string;
  stagingRoot: string;
  recordPath: string;
  manifestSha: string;
  record: SyntheticEvalRecord;
} {
  const root = mkdtempSync(join(tmpdir(), "oc-synthetic-eval-"));
  const stagingRoot = join(root, "staging");
  const runRoot = join(root, "run");
  const scratchTree = join(root, "tree");
  for (const path of [
    stagingRoot,
    runRoot,
    scratchTree,
    join(scratchTree, "packages"),
    join(scratchTree, "packages/commercial"),
    join(scratchTree, "packages/commercial/agent-sandbox"),
    join(scratchTree, "packages/commercial/agent-sandbox/platform-runtime"),
    join(scratchTree, "packages/commercial/agent-sandbox/platform-runtime/prompts"),
    join(scratchTree, "packages/commercial/agent-sandbox/ccb-baseline"),
    join(scratchTree, "packages/commercial/agent-sandbox/ccb-baseline/skills"),
    join(scratchTree, "packages/commercial/agent-sandbox/ccb-baseline/skills/system-info"),
    join(scratchTree, "packages/gateway"),
    join(scratchTree, "packages/gateway/src"),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o755 });
    chmodSync(path, 0o755);
  }
  const prompts = join(
    scratchTree,
    "packages/commercial/agent-sandbox/platform-runtime/prompts",
  );
  const baseline = join(
    scratchTree,
    "packages/commercial/agent-sandbox/ccb-baseline",
  );
  writeSafe(join(prompts, "platform-capabilities.md"), "platform\n");
  writeSafe(join(scratchTree, "packages/gateway/src/promptSlots.ts"), "slots\n");
  writeSafe(join(baseline, "AGENTS.md"), "agents\n");
  writeSafe(join(baseline, "CLAUDE.md"), "claude\n");
  writeSafe(join(baseline, "skills/system-info/SKILL.md"), "skill\n");

  const manifest: SyntheticEvalManifest = {
    schemaVersion: 1,
    baseCommit: "1".repeat(40),
    candidateCommit: "2".repeat(40),
    files: {
      promptsTree: sha256SyntheticEvalTree(prompts),
      promptSlots: createHash("sha256")
        .update(readFileSync(join(scratchTree, "packages/gateway/src/promptSlots.ts")))
        .digest("hex"),
      agents: createHash("sha256")
        .update(readFileSync(join(baseline, "AGENTS.md")))
        .digest("hex"),
      claude: createHash("sha256")
        .update(readFileSync(join(baseline, "CLAUDE.md")))
        .digest("hex"),
      skillsTree: sha256SyntheticEvalTree(join(baseline, "skills")),
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
  const manifestDir = join(stagingRoot, manifestSha);
  mkdirSync(manifestDir, { recursive: true, mode: 0o755 });
  chmodSync(manifestDir, 0o755);
  renameSync(scratchTree, join(manifestDir, "tree"));
  writeFileSync(join(manifestDir, "manifest.json"), manifestBytes, { mode: 0o644 });
  chmodSync(join(manifestDir, "manifest.json"), 0o644);

  const activeRecord = record({ manifestSha });
  const recordPath = join(runRoot, "active.json");
  writeFileSync(recordPath, JSON.stringify(activeRecord), { mode: 0o600 });
  chmodSync(recordPath, 0o600);
  return { root, stagingRoot, recordPath, manifestSha, record: activeRecord };
}

describe("syntheticEvalOverlay filesystem runtime", () => {
  test("uses the application release only when the runtime release axis resolved", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    assert.match(
      source,
      /expectedBaseCommit:\s*readSyntheticEvalReleaseSourceCommit\(\s*runtimeTuple\?\.releaseResolvedPath\s*\?\s*process\.cwd\(\)\s*:\s*undefined,?\s*\)/,
    );
  });

  test("reads the source commit from the application release marker contract", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-synthetic-eval-release-"));
    const sourceCommit = "1".repeat(40);
    try {
      assert.equal(readSyntheticEvalReleaseSourceCommit(undefined), undefined);
      writeSafe(
        join(root, ".complete"),
        JSON.stringify({ schemaVersion: 1, sourceCommit, digest: "a".repeat(12) }),
      );
      assert.equal(readSyntheticEvalReleaseSourceCommit(root), sourceCommit);
      writeSafe(
        join(root, ".complete"),
        JSON.stringify({ schemaVersion: 1, sourceCommit: "short" }),
      );
      assert.throws(
        () => readSyntheticEvalReleaseSourceCommit(root),
        /sourceCommit is invalid/,
      );
      unlinkSync(join(root, ".complete"));
      assert.throws(
        () => readSyntheticEvalReleaseSourceCommit(root),
        /ENOENT/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verifies exact staged bytes and CAS-activates the prepared record", () => {
    const fixture = buildRuntimeFixture();
    try {
      const runtime = createSyntheticEvalOverlayRuntime({
        activeRecordPath: fixture.recordPath,
        stagingRoot: fixture.stagingRoot,
        expectedBaseCommit: "1".repeat(40),
        now: () => NOW,
        warn: () => undefined,
      });
      const spec = runtime.resolvePrepared(247);
      assert.ok(spec);
      assert.equal(spec.manifestSha, fixture.manifestSha);
      assert.equal(runtime.resolvePrepared(5), null);
      runtime.activatePrepared(spec, "b".repeat(64));
      const stored = JSON.parse(readFileSync(fixture.recordPath, "utf8"));
      assert.equal(stored.state, "active");
      assert.equal(stored.containerId, "b".repeat(64));
      assert.equal(
        runtime.classifyContainer(247, runtime.labels(spec), "b".repeat(64)).mode,
        "valid",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("tamper or unsafe mode makes the overlay inert and labeled containers stale", () => {
    const fixture = buildRuntimeFixture();
    try {
      const promptSlots = join(
        fixture.stagingRoot,
        fixture.manifestSha,
        "tree/packages/gateway/src/promptSlots.ts",
      );
      writeFileSync(promptSlots, "tampered\n");
      const runtime = createSyntheticEvalOverlayRuntime({
        activeRecordPath: fixture.recordPath,
        stagingRoot: fixture.stagingRoot,
        expectedBaseCommit: "1".repeat(40),
        now: () => NOW,
        warn: () => undefined,
      });
      assert.equal(runtime.resolvePrepared(247), null);
      assert.equal(runtime.classifyContainer(247, {
        [SYNTHETIC_EVAL_MANIFEST_LABEL]: fixture.manifestSha,
        [SYNTHETIC_EVAL_NONCE_LABEL]: fixture.record.nonce,
        [SYNTHETIC_EVAL_UID_LABEL]: "247",
      }).mode, "stale");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("activation shares an exclusive record lock and cannot resurrect a cleared record", () => {
    const fixture = buildRuntimeFixture();
    const recordLockPath = `${fixture.recordPath}.lock`;
    try {
      const runtime = createSyntheticEvalOverlayRuntime({
        activeRecordPath: fixture.recordPath,
        recordLockPath,
        stagingRoot: fixture.stagingRoot,
        expectedBaseCommit: "1".repeat(40),
        now: () => NOW,
        warn: () => undefined,
      });
      const spec = runtime.resolvePrepared(247);
      assert.ok(spec);

      mkdirSync(recordLockPath, { mode: 0o700 });
      assert.throws(
        () => runtime.activatePrepared(spec, "b".repeat(64)),
        /record lock is held by a live owner/,
      );
      assert.equal(
        JSON.parse(readFileSync(fixture.recordPath, "utf8")).state,
        "prepared",
      );
      rmSync(recordLockPath, { recursive: true });

      writeFileSync(`${recordLockPath}.reaper`, "{}\n", { mode: 0o600 });
      assert.throws(
        () => runtime.activatePrepared(spec, "b".repeat(64)),
        /fenced by the official reaper/,
      );
      unlinkSync(`${recordLockPath}.reaper`);

      unlinkSync(fixture.recordPath);
      assert.throws(
        () => runtime.activatePrepared(spec, "b".repeat(64)),
        /prepared record changed/,
      );
      assert.equal(existsSync(fixture.recordPath), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("gateway activation never reaps a crashed lock without official recovery", () => {
    const fixture = buildRuntimeFixture();
    const recordLockPath = `${fixture.recordPath}.lock`;
    try {
      const runtime = createSyntheticEvalOverlayRuntime({
        activeRecordPath: fixture.recordPath,
        recordLockPath,
        stagingRoot: fixture.stagingRoot,
        expectedBaseCommit: "1".repeat(40),
        now: () => NOW,
        warn: () => undefined,
      });
      const spec = runtime.resolvePrepared(247);
      assert.ok(spec);
      mkdirSync(recordLockPath, { mode: 0o700 });
      const staleAt = new Date(NOW - 301_000);
      utimesSync(recordLockPath, staleAt, staleAt);

      assert.throws(
        () => runtime.activatePrepared(spec, "b".repeat(64)),
        /stale record lock requires official recovery/,
      );
      assert.equal(existsSync(recordLockPath), true);
      assert.equal(
        JSON.parse(readFileSync(fixture.recordPath, "utf8")).state,
        "prepared",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("a manifest for a different stable release is inert", () => {
    const fixture = buildRuntimeFixture();
    try {
      const runtime = createSyntheticEvalOverlayRuntime({
        activeRecordPath: fixture.recordPath,
        stagingRoot: fixture.stagingRoot,
        expectedBaseCommit: "9".repeat(40),
        now: () => NOW,
        warn: () => undefined,
      });
      assert.equal(runtime.resolvePrepared(247), null);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
