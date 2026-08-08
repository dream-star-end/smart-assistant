import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import type { TutorialCase } from "../../packages/web-react/src/lib/tutorialCaseCatalog.ts";
import { validateVerifiedEvidenceForTest } from "../check-v5-tutorials.ts";

const roots: string[] = [];
const CASE_ID = "research-bike-demand";
const RUN_IDS = ["run-1", "run-2", "run-3"] as const;

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writePublic(root: string, path: string, bytes: string | Buffer): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function makeFixture(): {
  root: string;
  item: TutorialCase;
  setEvidence: (value: unknown) => void;
  setMessages: (messages: Array<Record<string, unknown>>) => void;
} {
  const root = mkdtempSync(join(tmpdir(), "v5-tutorial-evidence-"));
  roots.push(root);
  const starterPrompt = "固定测试指令";
  const inputMaterials = [
    {
      title: "固定输入",
      description: "测试用冻结输入",
      assetPath: `tutorialCaseCatalog.ts#${CASE_ID}/input`,
      revision: "fixture-v1",
      sha256: sha256("fixture"),
      bytes: 7,
      inlineContent: "fixture",
      preparation: "无需准备",
    },
  ];
  const checkTitles = ["输出正确", "正常路径保持"];
  const artifactBytes = "verified artifact\n";
  const actualArtifacts = [
    {
      title: "结果文件",
      path: `/tutorials/cases/${CASE_ID}/artifacts/result.txt`,
      sha256: sha256(artifactBytes),
      bytes: Buffer.byteLength(artifactBytes),
      mimeType: "text/plain",
    },
  ];
  writePublic(root, actualArtifacts[0].path, artifactBytes);

  const inputBytes = json({
    schemaVersion: 1,
    caseId: CASE_ID,
    starterPrompt,
    materials: inputMaterials,
  });
  const inputPath = `/tutorials/cases/${CASE_ID}/input.json`;
  writePublic(root, inputPath, inputBytes);

  const checksPath = `/tutorials/cases/${CASE_ID}/checks.json`;
  const evidencePath = `/tutorials/cases/${CASE_ID}/evidence/run-1/check-1.json`;
  let evidenceValue: unknown = {
    schemaVersion: 1,
    caseId: CASE_ID,
    runId: "run-1",
    checkTitle: checkTitles[0],
    status: "passed",
    assertions: [
      { label: "exit code", expected: "0", actual: "0", passed: true },
    ],
  };
  let messages: Array<Record<string, unknown>> = [
    { id: "msg-user", role: "user", text: "固定问题", ts: 0 },
    { id: "msg-assistant", role: "assistant", text: "完整回答", ts: 1 },
  ];

  const replay = {
    status: "verified" as const,
    disclosure: "测试 fixture",
    messagesPath: `/tutorials/cases/${CASE_ID}/messages-manifest.json`,
    provenance: {
      capturedAt: "2026-08-08T00:00:00.000Z",
      release: "fixture-release",
      runIds: RUN_IDS,
      inputSha256: sha256(inputBytes),
      messagesSha256: "",
      messageCount: 2,
      bytes: 0,
      repeatRuns: 3,
      agentId: "research-assistant",
      modelId: "deepseek-v4-pro",
      engine: "ccb" as const,
    },
    checkReport: checksPath,
    actualArtifacts,
  };

  function writeMessages(): void {
    const pagePath = `/tutorials/cases/${CASE_ID}/messages-0001.json`;
    const page = json({
      schemaVersion: 1,
      caseId: CASE_ID,
      pageIndex: 0,
      startOrdinal: 0,
      messages,
    });
    writePublic(root, pagePath, page);
    const manifest = json({
      schemaVersion: 1,
      caseId: CASE_ID,
      messageCount: messages.length,
      pages: [
        {
          path: pagePath,
          sha256: sha256(page),
          bytes: Buffer.byteLength(page),
          messageCount: messages.length,
          startOrdinal: 0,
        },
      ],
    });
    writePublic(root, replay.messagesPath, manifest);
    replay.provenance.messagesSha256 = sha256(manifest);
    replay.provenance.messageCount = messages.length;
    replay.provenance.bytes = Buffer.byteLength(manifest);
  }

  function writeChecks(): void {
    const runs = RUN_IDS.map((runId) => ({
      runId,
      status: "passed",
      agentId: replay.provenance.agentId,
      modelId: replay.provenance.modelId,
      engine: replay.provenance.engine,
      checks: checkTitles.map((title, checkIndex) => {
        const path =
          runId === "run-1" && checkIndex === 0
            ? evidencePath
            : `/tutorials/cases/${CASE_ID}/evidence/${runId}/check-${checkIndex + 1}.json`;
        const value =
          runId === "run-1" && checkIndex === 0
            ? evidenceValue
            : {
                schemaVersion: 1,
                caseId: CASE_ID,
                runId,
                checkTitle: title,
                status: "passed",
                assertions: [
                  { label: "exit code", expected: "0", actual: "0", passed: true },
                ],
              };
        const bytes = json(value);
        writePublic(root, path, bytes);
        return {
          title,
          status: "passed",
          evidencePath: path,
          evidenceSha256: sha256(bytes),
          evidenceBytes: Buffer.byteLength(bytes),
        };
      }),
    }));
    writePublic(
      root,
      checksPath,
      json({
        schemaVersion: 1,
        caseId: CASE_ID,
        input: {
          path: inputPath,
          sha256: sha256(inputBytes),
          bytes: Buffer.byteLength(inputBytes),
        },
        selectedRunId: "run-1",
        runs,
        artifacts: actualArtifacts,
      }),
    );
  }

  writeMessages();
  writeChecks();
  const item = {
    id: CASE_ID,
    starterPrompt,
    inputMaterials,
    artifacts: [
      { title: "结果文件", format: "Text", description: "测试产物" },
    ],
    checks: checkTitles.map((title) => ({
      title,
      method: "读取 fixture",
      passCriterion: "断言通过",
    })),
    replay,
  } as unknown as TutorialCase;
  return {
    root,
    item,
    setEvidence(value) {
      evidenceValue = value;
      writeChecks();
    },
    setMessages(value) {
      messages = value;
      writeMessages();
    },
  };
}

test("verified tutorial fixture passes the complete static evidence gate", () => {
  const fixture = makeFixture();
  assert.doesNotThrow(() =>
    validateVerifiedEvidenceForTest(fixture.item as never, fixture.root),
  );
});

test("empty evidence cannot claim a passed tutorial check", () => {
  const fixture = makeFixture();
  fixture.setEvidence({});
  assert.throws(
    () => validateVerifiedEvidenceForTest(fixture.item as never, fixture.root),
    /验收证据字段不完整/,
  );
});

test("identity fields in a verified message fail the CI evidence gate", () => {
  const fixture = makeFixture();
  fixture.setMessages([
    { id: "msg-user", role: "user", text: "固定问题", ts: 0 },
    {
      id: "msg-assistant",
      role: "assistant",
      text: "完整回答",
      ts: 1,
      email: "private@example.com",
    },
  ]);
  assert.throws(
    () => validateVerifiedEvidenceForTest(fixture.item as never, fixture.root),
    /禁止公开的生产身份字段/,
  );
});
