import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  aggregatePair,
  controlledPromptDelta,
  parsePairArgs,
} from "../v5-synthetic-eval-pair.mjs";

const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "../..");
const aggregator = join(repoRoot, "scripts/v5-synthetic-eval-pair.mjs");
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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(
  counts: { dispatch: number; usage: number; container: string },
): Record<string, unknown> {
  return {
    phase: "stable",
    activeSlot: "A",
    candidateSlot: null,
    activeRelease: "/opt/openclaude/openclaude-v5-releases/rel-eval-base",
    candidateRelease: null,
    cohortPercent: 0,
    lockVersion: 71,
    sourceCommit: "a".repeat(40),
    enabledCron: 0,
    cronFileEnabled: 0,
    v3State: "inactive",
    dispatchCount: counts.dispatch,
    openDispatchCount: 0,
    usageCount: counts.usage,
    usageMaxId: counts.usage + 100,
    syntheticContainerId: counts.container,
  };
}

type Arm = "A" | "B";

interface Fixture {
  directory: string;
  armAPath: string;
  armBPath: string;
  outputPath: string;
  prompts: { A: string; B: string };
  artifacts: { A: string; B: string };
  evidence: { A: Record<string, any>; B: Record<string, any> };
}

function armEvidence(
  arm: Arm,
  promptPath: string,
  promptBytes: Buffer,
  expectedPromptDeltaSha: string,
  artifactPath: string,
  artifactBytes: Buffer,
  artifactIdentity: Record<string, unknown>,
): Record<string, any> {
  const baseCommit = "a".repeat(40);
  const candidateCommit = arm === "A" ? baseCommit : "b".repeat(40);
  const containerPrefix = arm === "A" ? "1" : "2";
  const persistentInputs = {
    agentClaude: { state: "file", bytes: 12, sha256: digest("agent-claude") },
    agentMemoryIndex: { state: "absent" },
    agentMemoryTree: { state: "tree", files: 2, directories: 1, sha256: digest("agent-memory") },
    userSoul: { state: "file", bytes: 13, sha256: digest("user-soul") },
    userProfile: { state: "file", bytes: 14, sha256: digest("user-profile") },
    userSkills: { state: "tree", files: 4, directories: 2, sha256: digest("user-skills") },
  };
  const emptyScratch = {
    state: "tree",
    files: 0,
    directories: 0,
    sha256: digest(""),
    uid: 1000,
    gid: 1000,
    mode: 0o700,
  };
  const persistentScratch = {
    workspace: { state: "tree", files: 8, directories: 0, sha256: digest("persistent-workspace") },
    browserCli: { state: "tree", files: 2, directories: 0, sha256: digest("persistent-browser-cli") },
    browserMcp: { state: "tree", files: 0, directories: 0, sha256: digest("") },
  };
  const turnResultSha = digest(`turn-result-${arm}`);
  return {
    schemaVersion: 4,
    status: "completed",
    arm,
    uid: 247,
    engine: "ccb",
    agentId: "research-assistant",
    model: "gpt-5.6-sol",
    pairId: "research-pair-01",
    order: "A_FIRST",
    baseCommit,
    candidateCommit,
    evaluationCase: {
      id: "multi-source-research",
      category: "research",
      workspace: "temporary",
      casePackSha256: digest("frozen-case-pack"),
      promptSha256: digest("frozen-case-prompt"),
    },
    dynamicInputs: {
      pre: {
        phase: "pre",
        containerId: containerPrefix.repeat(64),
        manifestSha: digest(`prepared-manifest-${arm}`),
        inputs: {
          ...structuredClone(persistentInputs),
          workspace: structuredClone(emptyScratch),
          browserCliScratch: structuredClone(emptyScratch),
          browserMcpScratch: structuredClone(emptyScratch),
          temporaryWorkspace: { state: "absent" },
        },
      },
      post: {
        phase: "post",
        containerId: containerPrefix.repeat(64),
        manifestSha: digest(`prepared-manifest-${arm}`),
        inputs: {
          ...structuredClone(persistentInputs),
          workspace: {
            ...structuredClone(emptyScratch),
            files: 1,
            sha256: digest(`workspace-scratch-${arm}`),
          },
          browserCliScratch: {
            ...structuredClone(emptyScratch),
            files: 1,
            sha256: digest(`browser-scratch-${arm}`),
          },
          browserMcpScratch: structuredClone(emptyScratch),
          temporaryWorkspace: {
            ...structuredClone(artifactIdentity),
          },
        },
      },
    },
    helpers: {
      reprovision: {
        path: `/ignored/${arm}/reprovision.mjs`,
        root: `/ignored/${arm}`,
        sha256: digest("reprovision-helper-file"),
        treeSha256: digest("reprovision-helper-tree"),
      },
      turn: {
        path: `/ignored/${arm}/turn.mjs`,
        root: `/ignored/${arm}`,
        sha256: digest("turn-helper-file"),
        treeSha256: digest("turn-helper-tree"),
      },
    },
    expectedManifestSha: digest(`prepared-manifest-${arm}`),
    prepared: {
      manifestSha: digest(`prepared-manifest-${arm}`),
      nonce: arm.toLowerCase().repeat(32),
    },
    overlayContainer: {
      containerId: containerPrefix.repeat(64),
      runtimeTuple: {
        image: "openclaude-v5-runtime:stable",
        imageId: digest("runtime-image"),
        runtimeRelease: "rel-runtime-eval",
        platformBundle: digest("platform-bundle"),
      },
    },
    expectedPromptDeltaSha,
    pre: snapshot({
      dispatch: arm === "A" ? 10 : 11,
      usage: arm === "A" ? 20 : 22,
      container: containerPrefix.repeat(64),
    }),
    post: snapshot({
      dispatch: arm === "A" ? 11 : 12,
      usage: arm === "A" ? 22 : 24,
      container: (arm === "A" ? "3" : "4").repeat(64),
    }),
    restoreSnapshot: snapshot({
      dispatch: arm === "A" ? 11 : 12,
      usage: arm === "A" ? 22 : 24,
      container: (arm === "A" ? "5" : "6").repeat(64),
    }),
    standardBefore: {
      standard: true,
      persistentScratch: structuredClone(persistentScratch),
    },
    restored: {
      standard: true,
      persistentScratch: structuredClone(persistentScratch),
    },
    turn: {
      source: {
        path: `/ignored/${arm}/turn-result.json`,
        sha256: turnResultSha,
      },
      frames: {
        path: `/ignored/${arm}/raw-frames.jsonl`,
        sha256: digest(`raw-frames-${arm}`),
        bytes: arm === "A" ? 4_000 : 3_000,
      },
      resultSha256: turnResultSha,
    },
    turnEvidence: {
      billingBindingMode: "ccb_authority_dispatch_attempt",
    },
    workspaceArtifact: {
      state: "tree",
      identity: structuredClone(artifactIdentity),
      entryCount: 1,
      capturedPath: artifactPath,
      bytes: artifactBytes.length,
      sha256: createHash("sha256").update(artifactBytes).digest("hex"),
      files: 1,
      directories: 0,
      completeBytes: Buffer.byteLength(`artifact-${arm}`),
    },
    promptEvidence: {
      extraPrompt: {
        capturedPath: promptPath,
        sha256: digest(promptBytes.toString("binary")),
        bytes: promptBytes.length,
      },
    },
    efficiency: {
      wallTimeMs: arm === "A" ? 120_000 : 75_000,
      modelToolBoundaries: arm === "A" ? 14 : 8,
      toolCalls: arm === "A" ? 12 : 12,
      inputTokens: arm === "A" ? 40_000 : 34_000,
      outputTokens: arm === "A" ? 8_000 : 8_300,
    },
  };
}

function makeFixture(): Fixture {
  const directory = temp("v5-synthetic-pair-");
  const prompts = {
    A: join(directory, "A.extra-prompt.md"),
    B: join(directory, "B.extra-prompt.md"),
  };
  const promptBytes = {
    A: Buffer.from("fixed-prefix\nbaseline instruction\nfixed-suffix\n"),
    B: Buffer.from("fixed-prefix\nparallel when independently useful\nfixed-suffix\n"),
  };
  writeFileSync(prompts.A, promptBytes.A, { mode: 0o600 });
  writeFileSync(prompts.B, promptBytes.B, { mode: 0o600 });
  const artifacts = {
    A: join(directory, "A.workspace.json"),
    B: join(directory, "B.workspace.json"),
  };
  const artifactBytes = {} as Record<Arm, Buffer>;
  const artifactIdentities = {} as Record<Arm, Record<string, unknown>>;
  for (const arm of ["A", "B"] as const) {
    const content = Buffer.from(`artifact-${arm}`);
    const contentSha = createHash("sha256").update(content).digest("hex");
    const identity = {
      state: "tree",
      files: 1,
      directories: 0,
      sha256: createHash("sha256")
        .update(`F  ${contentSha}  output.txt\n`)
        .digest("hex"),
    };
    const containerPrefix = arm === "A" ? "1" : "2";
    const document = {
      schemaVersion: 1,
      uid: 247,
      engine: "ccb",
      agentId: "research-assistant",
      caseId: "multi-source-research",
      workspaceMode: "temporary",
      containerId: containerPrefix.repeat(64),
      manifestSha: digest(`prepared-manifest-${arm}`),
      identity,
      entries: [{
        path: "output.txt",
        type: "file",
        mode: 0o644,
        bytes: content.length,
        sha256: contentSha,
        contentBase64: content.toString("base64"),
      }],
    };
    artifactBytes[arm] = Buffer.from(`${JSON.stringify(document)}\n`);
    artifactIdentities[arm] = identity;
    writeFileSync(artifacts[arm], artifactBytes[arm], { mode: 0o600 });
  }
  const expectedPromptDeltaSha = controlledPromptDelta(
    promptBytes.A,
    promptBytes.B,
  ).sha256;
  const evidence = {
    A: armEvidence(
      "A",
      prompts.A,
      promptBytes.A,
      expectedPromptDeltaSha,
      artifacts.A,
      artifactBytes.A,
      artifactIdentities.A,
    ),
    B: armEvidence(
      "B",
      prompts.B,
      promptBytes.B,
      expectedPromptDeltaSha,
      artifacts.B,
      artifactBytes.B,
      artifactIdentities.B,
    ),
  };
  const armAPath = join(directory, "arm-a.json");
  const armBPath = join(directory, "arm-b.json");
  const outputPath = join(directory, "pair.json");
  writeFileSync(armAPath, `${JSON.stringify(evidence.A, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(armBPath, `${JSON.stringify(evidence.B, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    directory,
    armAPath,
    armBPath,
    outputPath,
    prompts,
    artifacts,
    evidence,
  };
}

function rewriteArmB(fixture: Fixture): void {
  writeFileSync(
    fixture.armBPath,
    `${JSON.stringify(fixture.evidence.B, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function allSnapshots(evidence: Record<string, any>): Record<string, any>[] {
  return [evidence.pre, evidence.post, evidence.restoreSnapshot];
}

describe("V5 synthetic exact-eval pair aggregator", () => {
  test("accepts an exact pair, ignores helper paths and volatile usage counters, and emits raw metrics only", () => {
    const fixture = makeFixture();
    fixture.evidence.B.helpers.reprovision.path = "/different/reprovision.mjs";
    fixture.evidence.B.helpers.reprovision.root = "/different/reprovision";
    fixture.evidence.B.helpers.turn.path = "/different/turn.mjs";
    fixture.evidence.B.helpers.turn.root = "/different/turn";
    rewriteArmB(fixture);

    const result = aggregatePair(fixture.armAPath, fixture.armBPath);
    assert.equal(result.valid, true);
    assert.match(result.pairIdentityHash, /^[0-9a-f]{64}$/);
    assert.match(result.armEvidenceSha256.A, /^[0-9a-f]{64}$/);
    assert.match(result.armEvidenceSha256.B, /^[0-9a-f]{64}$/);
    assert.equal(
      result.promptDelta.actualSha256,
      fixture.evidence.A.expectedPromptDeltaSha,
    );
    assert.deepEqual(result.efficiencyRaw.A, fixture.evidence.A.efficiency);
    assert.deepEqual(result.efficiencyRaw.B, fixture.evidence.B.efficiency);
    assert.equal("winner" in result, false);
    assert.equal("recommendation" in result, false);
    assert.equal(result.schemaVersion, 5);
    assert.equal(
      result.promptDelta.algorithm,
      "myers-byte-hunks-v1-delete-tie",
    );
    assert.equal(result.promptDelta.hunkCount > 0, true);
    assert.equal(result.identity.billingBindingMode, "ccb_authority_dispatch_attempt");
    assert.equal(result.workspaceArtifacts.A.files, 1);
    assert.equal(result.workspaceArtifacts.B.files, 1);
  });

  test("controlled full-prompt diff is deterministic and byte-exact", () => {
    const base = Buffer.from([0, 1, 2, 3, 4, 5]);
    const candidate = Buffer.from([0, 1, 9, 8, 4, 5]);
    const first = controlledPromptDelta(base, candidate);
    const second = controlledPromptDelta(Buffer.from(base), Buffer.from(candidate));
    assert.deepEqual(first, second);
    assert.equal(first.schemaVersion, 2);
    assert.equal(first.algorithm, "myers-byte-hunks-v1-delete-tie");
    assert.equal(first.prefixBytes, 2);
    assert.equal(first.suffixBytes, 2);
    assert.equal(first.removedBase64, Buffer.from([2, 3]).toString("base64"));
    assert.equal(first.addedBase64, Buffer.from([9, 8]).toString("base64"));
    assert.deepEqual(first.hunks, [
      {
        removedBase64: Buffer.from([2, 3]).toString("base64"),
        addedBase64: Buffer.from([9, 8]).toString("base64"),
      },
    ]);
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
  });

  test("hunk identity excludes unchanged task bytes even between same-line edits", () => {
    const baseOne = Buffer.from(
      "before-old-A|task-context-one|old-B-after",
    );
    const candidateOne = Buffer.from(
      "before-new-A|task-context-one|new-B-after",
    );
    const baseTwo = Buffer.from(
      "before-old-A|different-task-context|old-B-after",
    );
    const candidateTwo = Buffer.from(
      "before-new-A|different-task-context|new-B-after",
    );
    const first = controlledPromptDelta(baseOne, candidateOne);
    const second = controlledPromptDelta(baseTwo, candidateTwo);

    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(first.hunks, second.hunks);
    assert.notEqual(first.removedBase64, second.removedBase64);
    assert.notEqual(first.addedBase64, second.addedBase64);

    const drifted = controlledPromptDelta(
      baseTwo,
      Buffer.from("before-new-A|unexpected-A-B-drift|new-B-after"),
    );
    assert.notEqual(drifted.sha256, second.sha256);
  });

  test("hunk identity is lossless and deterministic at binary and newline boundaries", () => {
    const cases = [
      [Buffer.alloc(0), Buffer.from("\n")],
      [Buffer.from("a"), Buffer.from("a\n")],
      [Buffer.from("\n"), Buffer.alloc(0)],
      [Buffer.from([0, 255, 10]), Buffer.from([0, 10, 255, 10])],
      [Buffer.from("abab"), Buffer.from("baba")],
    ];
    const deltas: ReturnType<typeof controlledPromptDelta>[] = [];
    for (const [base, candidate] of cases) {
      const first = controlledPromptDelta(base, candidate);
      const second = controlledPromptDelta(
        Buffer.from(base),
        Buffer.from(candidate),
      );
      assert.deepEqual(first, second);
      assert.equal(first.hunkCount, first.hunks.length);
      assert.equal(first.hunkCount > 0, true);
      deltas.push(first);
    }
    assert.equal(deltas[0].sha256, deltas[1].sha256);
    assert.equal(deltas[0].sha256, deltas[3].sha256);
    assert.deepEqual(deltas[3].hunks, [{
      removedBase64: "",
      addedBase64: Buffer.from([10]).toString("base64"),
    }]);
    assert.notEqual(deltas[0].sha256, deltas[2].sha256);
    const repeatedTieHunks = [
      {
        removedBase64: Buffer.from("a").toString("base64"),
        addedBase64: "",
      },
      {
        removedBase64: "",
        addedBase64: Buffer.from("a").toString("base64"),
      },
    ];
    assert.deepEqual(deltas[4].hunks, repeatedTieHunks);
    assert.equal(deltas[4].sha256, digest(JSON.stringify({
      schemaVersion: 2,
      algorithm: "myers-byte-hunks-v1-delete-tie",
      hunks: repeatedTieHunks,
    })));
    assert.notEqual(deltas[0].sha256, deltas[4].sha256);

    const unchanged = controlledPromptDelta(Buffer.alloc(0), Buffer.alloc(0));
    assert.equal(unchanged.hunkCount, 0);
    assert.deepEqual(unchanged.hunks, []);
  });

  test("Myers byte edit distance matches a reference insertion/deletion DP", () => {
    const referenceDistance = (base: Buffer, candidate: Buffer): number => {
      let previous = Array.from(
        { length: candidate.length + 1 },
        (_, index) => index,
      );
      for (let baseIndex = 1; baseIndex <= base.length; baseIndex += 1) {
        const current = [baseIndex];
        for (
          let candidateIndex = 1;
          candidateIndex <= candidate.length;
          candidateIndex += 1
        ) {
          current[candidateIndex] = base[baseIndex - 1]
            === candidate[candidateIndex - 1]
            ? previous[candidateIndex - 1]
            : Math.min(
              previous[candidateIndex] + 1,
              current[candidateIndex - 1] + 1,
            );
        }
        previous = current;
      }
      return previous[candidate.length];
    };
    let state = 0x51f15e;
    const randomByte = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state & 0x07;
    };

    for (let sample = 0; sample < 200; sample += 1) {
      const base = Buffer.from(
        Array.from({ length: randomByte() }, randomByte),
      );
      const candidate = Buffer.from(
        Array.from({ length: randomByte() }, randomByte),
      );
      const delta = controlledPromptDelta(base, candidate);
      assert.equal(
        delta.editDistanceBytes,
        referenceDistance(base, candidate),
        `sample ${sample}: ${base.toString("hex")} -> ${candidate.toString("hex")}`,
      );
      assert.equal(controlledPromptDelta(base, base).editDistanceBytes, 0);
    }
  });

  const identityDrifts: Array<{
    name: string;
    mutate: (fixture: Fixture) => void;
    message: RegExp;
  }> = [
    {
      name: "base commit",
      mutate: ({ evidence }) => {
        evidence.B.baseCommit = "c".repeat(40);
      },
      message: /baseCommit differs/,
    },
    {
      name: "active release",
      mutate: ({ evidence }) => {
        for (const value of allSnapshots(evidence.B)) {
          value.activeRelease =
            "/opt/openclaude/openclaude-v5-releases/rel-other";
        }
      },
      message: /deployment identity differs/,
    },
    {
      name: "runtime release",
      mutate: ({ evidence }) => {
        evidence.B.overlayContainer.runtimeTuple.runtimeRelease =
          "rel-runtime-other";
      },
      message: /runtime tuple differs/,
    },
    {
      name: "runtime image id",
      mutate: ({ evidence }) => {
        evidence.B.overlayContainer.runtimeTuple.imageId = digest("other-image");
      },
      message: /runtime tuple differs/,
    },
    {
      name: "platform bundle",
      mutate: ({ evidence }) => {
        evidence.B.overlayContainer.runtimeTuple.platformBundle =
          digest("other-bundle");
      },
      message: /runtime tuple differs/,
    },
    {
      name: "runtime image reference",
      mutate: ({ evidence }) => {
        evidence.B.overlayContainer.runtimeTuple.image =
          "openclaude-v5-runtime:other";
      },
      message: /runtime tuple differs/,
    },
    {
      name: "lock version",
      mutate: ({ evidence }) => {
        for (const value of allSnapshots(evidence.B)) value.lockVersion = 72;
      },
      message: /deployment identity differs/,
    },
    {
      name: "uid",
      mutate: ({ evidence }) => {
        evidence.B.uid = 626;
      },
      message: /uid differs|workspace artifact document identity/,
    },
    {
      name: "engine",
      mutate: ({ evidence }) => {
        evidence.B.engine = "codex";
      },
      message: /engine differs|workspace artifact document identity/,
    },
    {
      name: "agent id",
      mutate: ({ evidence }) => {
        evidence.B.agentId = "software-engineer";
      },
      message: /agentId differs|workspace artifact document identity/,
    },
    {
      name: "model",
      mutate: ({ evidence }) => {
        evidence.B.model = "deepseek-v4-flash";
      },
      message: /model differs/,
    },
    {
      name: "pair id",
      mutate: ({ evidence }) => {
        evidence.B.pairId = "research-pair-02";
      },
      message: /pairId differs/,
    },
    {
      name: "order",
      mutate: ({ evidence }) => {
        evidence.B.order = "B_FIRST";
      },
      message: /order differs/,
    },
    {
      name: "case id",
      mutate: ({ evidence }) => {
        evidence.B.evaluationCase.id = "different-case";
      },
      message: /evaluationCase differs|workspace artifact document identity/,
    },
    {
      name: "case category",
      mutate: ({ evidence }) => {
        evidence.B.evaluationCase.category = "software";
      },
      message: /evaluationCase differs|workspace artifact document identity/,
    },
    {
      name: "case workspace mode",
      mutate: ({ evidence }) => {
        evidence.B.evaluationCase.workspace = "none";
      },
      message: /evaluationCase differs|workspace artifact document identity/,
    },
    {
      name: "case pack SHA",
      mutate: ({ evidence }) => {
        evidence.B.evaluationCase.casePackSha256 =
          digest("different-case-pack");
      },
      message: /evaluationCase differs/,
    },
    {
      name: "case prompt SHA",
      mutate: ({ evidence }) => {
        evidence.B.evaluationCase.promptSha256 =
          digest("different-case-prompt");
      },
      message: /evaluationCase differs/,
    },
    {
      name: "reprovision helper file SHA",
      mutate: ({ evidence }) => {
        evidence.B.helpers.reprovision.sha256 = digest("different-file");
      },
      message: /helper file\/tree SHA identity differs/,
    },
    {
      name: "reprovision helper tree SHA",
      mutate: ({ evidence }) => {
        evidence.B.helpers.reprovision.treeSha256 = digest("different-tree");
      },
      message: /helper file\/tree SHA identity differs/,
    },
    {
      name: "turn helper file SHA",
      mutate: ({ evidence }) => {
        evidence.B.helpers.turn.sha256 = digest("different-turn-file");
      },
      message: /helper file\/tree SHA identity differs/,
    },
    {
      name: "turn helper tree SHA",
      mutate: ({ evidence }) => {
        evidence.B.helpers.turn.treeSha256 = digest("different-turn-tree");
      },
      message: /helper file\/tree SHA identity differs/,
    },
    {
      name: "dynamic inputs",
      mutate: ({ evidence }) => {
        const changed = {
          state: "file",
          bytes: 99,
          sha256: digest("different-user-profile"),
        };
        evidence.B.dynamicInputs.pre.inputs.userProfile = changed;
        evidence.B.dynamicInputs.post.inputs.userProfile =
          structuredClone(changed);
      },
      message: /dynamicInputs\.pre differs/,
    },
  ];

  for (const drift of identityDrifts) {
    test(`rejects ${drift.name} drift`, () => {
      const fixture = makeFixture();
      drift.mutate(fixture);
      rewriteArmB(fixture);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        drift.message,
      );
    });
  }

  test("rejects within-arm pre/post/restore deployment drift", () => {
    const fixture = makeFixture();
    fixture.evidence.B.restoreSnapshot.activeRelease =
      "/opt/openclaude/openclaude-v5-releases/rel-restore-drift";
    rewriteArmB(fixture);
    assert.throws(
      () => aggregatePair(fixture.armAPath, fixture.armBPath),
      /pre\/restore deployment identity differs/,
    );
  });

  test("requires persistent dynamic inputs to remain exact while allowing temporary workspace creation", () => {
    const valid = makeFixture();
    assert.doesNotThrow(() =>
      aggregatePair(valid.armAPath, valid.armBPath)
    );

    const persistentDrift = makeFixture();
    persistentDrift.evidence.B.dynamicInputs.post.inputs.userSoul.sha256 =
      digest("changed-during-turn");
    rewriteArmB(persistentDrift);
    assert.throws(
      () =>
        aggregatePair(
          persistentDrift.armAPath,
          persistentDrift.armBPath,
        ),
      /persistent dynamic inputs pre\/post differs/,
    );

    const dirtyPre = makeFixture();
    dirtyPre.evidence.B.dynamicInputs.pre.inputs.temporaryWorkspace = {
      state: "tree",
      files: 1,
      directories: 0,
      sha256: digest("dirty-pre"),
    };
    rewriteArmB(dirtyPre);
    assert.throws(
      () => aggregatePair(dirtyPre.armAPath, dirtyPre.armBPath),
      /temporaryWorkspace must be absent before/,
    );

    const unsafePost = makeFixture();
    unsafePost.evidence.B.dynamicInputs.post.inputs.temporaryWorkspace = {
      state: "file",
      bytes: 1,
      sha256: digest("unexpected-file"),
    };
    rewriteArmB(unsafePost);
    assert.throws(
      () => aggregatePair(unsafePost.armAPath, unsafePost.armBPath),
      /post state must be absent or tree/,
    );

    const dirtyScratch = makeFixture();
    dirtyScratch.evidence.B.dynamicInputs.pre.inputs.workspace.files = 1;
    dirtyScratch.evidence.B.dynamicInputs.pre.inputs.workspace.sha256 =
      digest("dirty-scratch");
    rewriteArmB(dirtyScratch);
    assert.throws(
      () => aggregatePair(dirtyScratch.armAPath, dirtyScratch.armBPath),
      /isolated scratch pre identity is invalid/,
    );

    const persistentScratchDrift = makeFixture();
    persistentScratchDrift.evidence.B.restored.persistentScratch.workspace.sha256 =
      digest("persistent-scratch-drift");
    rewriteArmB(persistentScratchDrift);
    assert.throws(
      () => aggregatePair(
        persistentScratchDrift.armAPath,
        persistentScratchDrift.armBPath,
      ),
      /persistent scratch before\/restore differs/,
    );

    const absentPersistentScratch = makeFixture();
    (absentPersistentScratch.evidence.B.standardBefore.persistentScratch as
      Record<string, unknown>).browserMcp = { state: "absent" };
    rewriteArmB(absentPersistentScratch);
    assert.throws(
      () => aggregatePair(
        absentPersistentScratch.armAPath,
        absentPersistentScratch.armBPath,
      ),
      /browserMcp tree identity is invalid/,
    );
  });

  test("rejects incomplete/wrong arms and invalid manifest or turn hashes", () => {
    const mutations: Array<[string, (evidence: Record<string, any>) => void, RegExp]> = [
      [
        "schema version",
        (value) => value.schemaVersion = 1,
        /schemaVersion must be 4/,
      ],
      ["status", (value) => value.status = "failed", /status must be completed/],
      ["arm", (value) => value.arm = "A", /arm must be B/],
      ["pair id", (value) => value.pairId = "bad id", /pairId is invalid/],
      ["order", (value) => value.order = "AB", /order must be/],
      [
        "manifest",
        (value) => value.prepared.manifestSha = digest("wrong-manifest"),
        /prepared manifest differs/,
      ],
      [
        "case source hash",
        (value) => value.turn.source.sha256 = "bad",
        /turn\.source\.sha256/,
      ],
      [
        "frame hash",
        (value) => value.turn.frames.sha256 = "bad",
        /turn\.frames\.sha256/,
      ],
      [
        "result hash",
        (value) => value.turn.resultSha256 = "bad",
        /turn\.resultSha256/,
      ],
      [
        "source/result hash disagreement",
        (value) => value.turn.resultSha256 = digest("different-result"),
        /source\/result SHA differ/,
      ],
    ];
    for (const [name, mutate, message] of mutations) {
      const fixture = makeFixture();
      mutate(fixture.evidence.B);
      rewriteArmB(fixture);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        message,
        name,
      );
    }
  });

  test("accepts the compatible rawFramesSha256 field", () => {
    const fixture = makeFixture();
    for (const arm of ["A", "B"] as const) {
      const frames = fixture.evidence[arm].turn.frames;
      fixture.evidence[arm].turn.rawFramesSha256 = frames.sha256;
      fixture.evidence[arm].turn.rawFramesBytes = frames.bytes;
      fixture.evidence[arm].turn.frames = undefined;
    }
    writeFileSync(
      fixture.armAPath,
      `${JSON.stringify(fixture.evidence.A, null, 2)}\n`,
    );
    rewriteArmB(fixture);
    assert.equal(
      aggregatePair(fixture.armAPath, fixture.armBPath).valid,
      true,
    );
  });

  test("rejects missing, self-reported, or observed prompt delta drift", () => {
    {
      const fixture = makeFixture();
      fixture.evidence.B.expectedPromptDeltaSha = undefined;
      rewriteArmB(fixture);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        /expectedPromptDeltaSha/,
      );
    }
    {
      const fixture = makeFixture();
      fixture.evidence.B.expectedPromptDeltaSha = digest("self-reported-other");
      rewriteArmB(fixture);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        /expectedPromptDeltaSha differs/,
      );
    }
    {
      const fixture = makeFixture();
      const wrong = digest("preregistered-but-not-actual");
      fixture.evidence.A.expectedPromptDeltaSha = wrong;
      fixture.evidence.B.expectedPromptDeltaSha = wrong;
      writeFileSync(
        fixture.armAPath,
        `${JSON.stringify(fixture.evidence.A, null, 2)}\n`,
      );
      rewriteArmB(fixture);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        /captured full-prompt hunk delta differs/,
      );
    }
  });

  test("reads complete prompt captures and rejects byte/hash tampering", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.prompts.B, "tampered", { mode: 0o600 });
    assert.throws(
      () => aggregatePair(fixture.armAPath, fixture.armBPath),
      /byte count differs|SHA differs/,
    );
  });

  test("reads complete workspace captures and rejects content, path, and counter tampering", () => {
    {
      const fixture = makeFixture();
      const document = JSON.parse(readFileSync(fixture.artifacts.B, "utf8"));
      document.entries[0].contentBase64 = Buffer.from("tampered").toString("base64");
      const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
      writeFileSync(fixture.artifacts.B, bytes, { mode: 0o600 });
      fixture.evidence.B.workspaceArtifact.bytes = bytes.length;
      fixture.evidence.B.workspaceArtifact.sha256 = createHash("sha256")
        .update(bytes)
        .digest("hex");
      rewriteArmB(fixture);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        /file bytes are incomplete or corrupted/,
      );
    }
    {
      const fixture = makeFixture();
      const document = JSON.parse(readFileSync(fixture.artifacts.B, "utf8"));
      document.entries[0].path = "../escaped.txt";
      const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
      writeFileSync(fixture.artifacts.B, bytes, { mode: 0o600 });
      fixture.evidence.B.workspaceArtifact.bytes = bytes.length;
      fixture.evidence.B.workspaceArtifact.sha256 = createHash("sha256")
        .update(bytes)
        .digest("hex");
      rewriteArmB(fixture);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        /entry identity is invalid/,
      );
    }
    {
      const fixture = makeFixture();
      fixture.evidence.B.workspaceArtifact.completeBytes += 1;
      rewriteArmB(fixture);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        /completeness counters differ/,
      );
    }
  });

  test("requires canonical root-owned 0600 inputs and a canonical root-owned 0700 output parent", () => {
    {
      const fixture = makeFixture();
      chmodSync(fixture.armBPath, 0o640);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        /root-owned, and mode 0600/,
      );
    }
    {
      const fixture = makeFixture();
      chmodSync(fixture.prompts.B, 0o644);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        /captured prompt must be canonical, root-owned, and mode 0600/,
      );
    }
    {
      const fixture = makeFixture();
      chmodSync(fixture.artifacts.B, 0o644);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        /captured workspace artifact must be canonical, root-owned, and mode 0600/,
      );
    }
    {
      const fixture = makeFixture();
      const linkedArtifact = join(fixture.directory, "linked-workspace.json");
      symlinkSync(fixture.artifacts.B, linkedArtifact);
      fixture.evidence.B.workspaceArtifact.capturedPath = linkedArtifact;
      rewriteArmB(fixture);
      assert.throws(
        () => aggregatePair(fixture.armAPath, fixture.armBPath),
        /captured workspace artifact must be a regular file, not a symlink/,
      );
    }
    {
      const fixture = makeFixture();
      const linkedEvidence = join(fixture.directory, "linked-arm-b.json");
      symlinkSync(fixture.armBPath, linkedEvidence);
      assert.throws(
        () => aggregatePair(fixture.armAPath, linkedEvidence),
        /regular file, not a symlink/,
      );
    }
    {
      const fixture = makeFixture();
      const unsafeOutputParent = join(fixture.directory, "unsafe-output");
      mkdirSync(unsafeOutputParent, { mode: 0o755 });
      chmodSync(unsafeOutputParent, 0o755);
      const output = join(unsafeOutputParent, "pair.json");
      const result = spawnSync(process.execPath, [
        aggregator,
        "--arm-a",
        fixture.armAPath,
        "--arm-b",
        fixture.armBPath,
        "--output",
        output,
      ], { encoding: "utf8" });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /output parent.*mode 0700/);
    }
    {
      const fixture = makeFixture();
      const secureOutputParent = join(fixture.directory, "secure-output");
      mkdirSync(secureOutputParent, { mode: 0o700 });
      chmodSync(secureOutputParent, 0o700);
      const linkedOutputParent = join(fixture.directory, "linked-output");
      symlinkSync(secureOutputParent, linkedOutputParent);
      const result = spawnSync(process.execPath, [
        aggregator,
        "--arm-a",
        fixture.armAPath,
        "--arm-b",
        fixture.armBPath,
        "--output",
        join(linkedOutputParent, "pair.json"),
      ], { encoding: "utf8" });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /output parent.*canonical/);
    }
  });

  test("help is side-effect free; dry-run writes nothing; apply uses wx and 0600", () => {
    const fixture = makeFixture();
    const help = spawnSync(
      process.execPath,
      [aggregator, "--help", "--output", fixture.outputPath],
      { encoding: "utf8" },
    );
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Purely|Without --apply|writes\s+nothing/i);
    assert.equal(
      spawnSync("test", ["-e", fixture.outputPath]).status,
      1,
      "help created output",
    );

    const baseArgs = [
      aggregator,
      "--arm-a",
      fixture.armAPath,
      "--arm-b",
      fixture.armBPath,
      "--output",
      fixture.outputPath,
    ];
    const dryRun = spawnSync(process.execPath, baseArgs, { encoding: "utf8" });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(JSON.parse(dryRun.stdout).applied, false);
    assert.equal(
      spawnSync("test", ["-e", fixture.outputPath]).status,
      1,
      "dry-run created output",
    );

    const applied = spawnSync(process.execPath, [...baseArgs, "--apply"], {
      encoding: "utf8",
    });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.stdout.trim(), fixture.outputPath);
    assert.equal(statSync(fixture.outputPath).mode & 0o777, 0o600);
    const firstBytes = readFileSync(fixture.outputPath);
    assert.equal(JSON.parse(firstBytes.toString("utf8")).valid, true);

    const repeated = spawnSync(process.execPath, [...baseArgs, "--apply"], {
      encoding: "utf8",
    });
    assert.equal(repeated.status, 2);
    assert.match(repeated.stderr, /must not already exist/);
    assert.deepEqual(readFileSync(fixture.outputPath), firstBytes);
  });

  test("requires three distinct absolute JSON paths", () => {
    const fixture = makeFixture();
    assert.throws(
      () =>
        parsePairArgs([
          "--arm-a",
          "relative-a.json",
          "--arm-b",
          fixture.armBPath,
          "--output",
          fixture.outputPath,
        ]),
      /absolute normalized/,
    );
    assert.throws(
      () =>
        parsePairArgs([
          "--arm-a",
          fixture.armAPath,
          "--arm-b",
          fixture.armBPath,
          "--output",
          fixture.armAPath,
        ]),
      /distinct/,
    );
  });
});
