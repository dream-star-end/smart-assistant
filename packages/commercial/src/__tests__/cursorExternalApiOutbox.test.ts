/**
 * Real-FS unit tests for the Cursor external API outbox (no PG).
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  cursorExternalApiOutboxDirForFlavor,
  openCursorExternalApiOutbox,
  SELFHOST_CURSOR_EXTERNAL_API_OUTBOX_DIR,
  type CursorExternalIntentRecord,
  type CursorExternalReadyRecord,
} from "../billing/cursorExternalApiOutbox.js";

const BILLING = "a".repeat(32);

function intent(over: Partial<CursorExternalIntentRecord> = {}): CursorExternalIntentRecord {
  return {
    schema: 1,
    phase: "intent",
    billingId: BILLING,
    userId: "3",
    modelId: "cursor-fable-5.1-high",
    accountId: "17",
    apiKeyId: "9",
    sessionId: null,
    turnKey: null,
    parentTurnKey: null,
    parentSessionId: null,
    delegateAgentId: null,
    basis: {
      modelId: "cursor-fable-5.1-high",
      displayName: "Fable",
      inputPerMtok: "1500",
      outputPerMtok: "7500",
      cacheReadPerMtok: "150",
      cacheWritePerMtok: "1875",
      catalogMultiplier: "1.000",
      settleSurcharge: null,
      capturedAt: "2026-09-08T00:00:00.000Z",
    },
    createdAt: "2026-09-08T00:00:00.000Z",
    ...over,
  };
}

function ready(over: Partial<CursorExternalReadyRecord> = {}): CursorExternalReadyRecord {
  return {
    ...intent(),
    phase: "ready",
    engineStatus: "success",
    terminalCode: null,
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    plan: {
      settleStatus: "success",
      costCredits: "12",
      snapshotJson: JSON.stringify({ model_id: "cursor-fable-5.1-high" }),
    },
    sealedAt: "2026-09-08T00:00:01.000Z",
    ...over,
  };
}

describe("cursorExternalApiOutboxDirForFlavor", () => {
  test("only selfhost gets the explicit StateDirectory path; commercial never defaults", () => {
    assert.equal(cursorExternalApiOutboxDirForFlavor("selfhost"), SELFHOST_CURSOR_EXTERNAL_API_OUTBOX_DIR);
    assert.equal(cursorExternalApiOutboxDirForFlavor("commercial"), null);
    assert.equal(cursorExternalApiOutboxDirForFlavor(null), null);
    assert.equal(cursorExternalApiOutboxDirForFlavor(undefined), null);
  });
});

describe("cursorExternalApiOutbox FS", () => {
  test("intent then ready, seal-once does not rewrite, unlink removes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    await box.writeIntent(intent());
    const first = await box.writeReady(ready());
    const second = await box.writeReady(ready({ plan: { settleStatus: "error", costCredits: "0", snapshotJson: "{}" } }));
    assert.equal(second.plan.costCredits, first.plan.costCredits);
    assert.equal((await box.read(BILLING))?.phase, "ready");
    assert.equal(await box.unlink(BILLING), true);
    assert.equal(await box.read(BILLING), null);
  });

  test("intent cannot replace an existing ready", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    await box.writeReady(ready());
    await assert.rejects(() => box.writeIntent(intent()), /cannot replace ready/);
  });

  test("corrupt / unknown / oversized files are observed and do not starve later ready", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-"));
    const box = await openCursorExternalApiOutbox({ directory: dir });
    await writeFile(path.join(dir, "00-corrupt.json"), "{not json", "utf8");
    await writeFile(path.join(dir, "01-unknown.json"), JSON.stringify({ schema: 1, phase: "other", billingId: "b".repeat(32) }), "utf8");
    await writeFile(path.join(dir, `${"c".repeat(32)}.json`), "x".repeat(70 * 1024), "utf8");
    await box.writeReady(ready({ billingId: "f".repeat(32) }));
    const batch = await box.listBatch({ limit: 32 });
    const kinds = batch.observations.map((o) => o.kind);
    assert.ok(kinds.includes("corrupt"));
    assert.ok(kinds.includes("unknown"));
    assert.ok(kinds.includes("ready"));
    const readyObs = batch.observations.filter((o) => o.kind === "ready");
    assert.equal(readyObs.length, 1);
  });

  test("unwritable directory fails open and does not fall back to the selfhost path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-nodir-"));
    const asFile = path.join(dir, "not-a-directory");
    await writeFile(asFile, "x");
    await assert.rejects(
      () => openCursorExternalApiOutbox({ directory: asFile }),
      (err: unknown) => {
        assert.equal((err as Error).name, "CursorExternalOutboxDirectoryError");
        assert.doesNotMatch((err as Error).message, new RegExp(SELFHOST_CURSOR_EXTERNAL_API_OUTBOX_DIR));
        return true;
      },
    );
  });
});
