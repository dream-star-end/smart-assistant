/**
 * Real-FS unit tests for the Cursor external API outbox (no PG).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import type { Logger } from "../logging/logger.js";
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
    try {
      const box = await openCursorExternalApiOutbox({ directory: dir });
      await box.writeIntent(intent());
      const first = await box.writeReady(ready());
      const second = await box.writeReady(ready({ plan: { settleStatus: "error", costCredits: "0", snapshotJson: "{}" } }));
      assert.equal(second.plan.costCredits, first.plan.costCredits);
      assert.equal((await box.read(BILLING))?.phase, "ready");
      assert.equal(await box.unlink(BILLING), true);
      assert.equal(await box.read(BILLING), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("intent cannot replace an existing ready", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-"));
    try {
      const box = await openCursorExternalApiOutbox({ directory: dir });
      await box.writeReady(ready());
      await assert.rejects(() => box.writeIntent(intent()), /cannot replace ready/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("corrupt / unknown / oversized files are observed and do not starve later ready", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-"));
    try {
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unwritable directory fails open and does not fall back to the selfhost path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-nodir-"));
    const asFile = path.join(dir, "not-a-directory");
    await writeFile(asFile, "x");
    try {
      await assert.rejects(
        () => openCursorExternalApiOutbox({ directory: asFile }),
        (err: unknown) => {
          assert.equal((err as Error).name, "CursorExternalOutboxDirectoryError");
          assert.doesNotMatch((err as Error).message, new RegExp(SELFHOST_CURSOR_EXTERNAL_API_OUTBOX_DIR));
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function capturingLogger(lines: Array<Record<string, unknown>>): Logger {
  const push = (level: string, msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, ...(fields ?? {}) });
  };
  const logger = {
    trace: (msg: string, fields?: Record<string, unknown>) => push("trace", msg, fields),
    debug: (msg: string, fields?: Record<string, unknown>) => push("debug", msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => push("info", msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => push("warn", msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => push("error", msg, fields),
    child: () => logger,
  };
  return logger;
}

describe("cursorExternalApiOutbox startScanner lifecycle", () => {
  test("live timer continues after the first completed empty batch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-live-"));
    let handle: { stop: () => Promise<void> } | undefined;
    let scans = 0;
    try {
      const box = await openCursorExternalApiOutbox({ directory: dir });
      const realScan = box.scanOnce.bind(box);
      box.scanOnce = async (deps) => {
        scans += 1;
        return realScan(deps);
      };
      handle = box.startScanner({
        pool: {} as never,
        pricing: { get: () => {
          throw new Error("empty FS must not need pricing");
        } } as never,
        intervalMs: 500,
      });
      await new Promise((r) => setTimeout(r, 1750));
      await handle.stop();
      handle = undefined;
      assert.ok(scans >= 2, `live scanner must tick more than once, scans=${scans}`);
    } finally {
      await handle?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("second batch still runs after a non-empty first scan, then stop drains and restart works", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-second-"));
    let handle: { stop: () => Promise<void> } | undefined;
    const scans: number[] = [];
    const lines: Array<Record<string, unknown>> = [];
    try {
      const box = await openCursorExternalApiOutbox({ directory: dir });
      await writeFile(path.join(dir, "00-corrupt.json"), "{", "utf8");
      await writeFile(
        path.join(dir, "01-unknown.json"),
        JSON.stringify({ schema: 1, phase: "other", billingId: "b".repeat(32) }),
        "utf8",
      );
      await box.writeIntent(intent({ billingId: "c".repeat(32) }));
      const realScan = box.scanOnce.bind(box);
      box.scanOnce = async (deps) => {
        const result = await realScan(deps);
        scans.push(result.scanned);
        return result;
      };
      handle = box.startScanner({
        pool: {} as never,
        pricing: { get: () => null } as never,
        intervalMs: 500,
        logger: capturingLogger(lines),
      });
      await new Promise((r) => setTimeout(r, 1750));
      await handle.stop();
      const afterStop = scans.length;
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(scans.length, afterStop, "stop must not start a new batch");
      handle = box.startScanner({
        pool: {} as never,
        pricing: { get: () => null } as never,
        intervalMs: 500,
        logger: capturingLogger(lines),
      });
      await new Promise((r) => setTimeout(r, 1200));
      await handle.stop();
      handle = undefined;
      assert.ok(scans.length >= 3, `restart must tick, scans=${scans.length}`);
      const scanLogs = lines.filter((l) => l.msg === "cursor_external_outbox_scan");
      assert.ok(scanLogs.length >= 2);
      assert.ok(scanLogs.some((l) => Number(l.intent) >= 1));
      assert.ok(scanLogs.some((l) => Number(l.unknown) >= 1));
      assert.ok(scanLogs.some((l) => Number(l.corrupt) >= 1));
      assert.equal(scanLogs.some((l) => JSON.stringify(l).includes("prompt")), false);
    } finally {
      await handle?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("scanOnce failure does not pin inFlight; the next tick retries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-fail-"));
    let handle: { stop: () => Promise<void> } | undefined;
    let calls = 0;
    const lines: Array<Record<string, unknown>> = [];
    try {
      const box = await openCursorExternalApiOutbox({ directory: dir });
      box.scanOnce = async () => {
        calls += 1;
        throw new Error(`scan boom ${calls}`);
      };
      handle = box.startScanner({
        pool: {} as never,
        pricing: { get: () => null } as never,
        intervalMs: 500,
        logger: capturingLogger(lines),
      });
      await new Promise((r) => setTimeout(r, 1750));
      await handle.stop();
      handle = undefined;
      assert.ok(calls >= 2, `failed ticks must retry, calls=${calls}`);
      assert.ok(lines.some((l) => l.msg === "cursor_external_outbox_scan_failed"));
    } finally {
      await handle?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("listBatch stops at the file limit without requiring a full sorted listing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-limit-"));
    try {
      const box = await openCursorExternalApiOutbox({ directory: dir });
      for (let i = 0; i < 80; i += 1) {
        const id = i.toString(16).padStart(32, "0");
        await writeFile(path.join(dir, `${id}.json`), "{", "utf8");
      }
      const started = Date.now();
      const batch = await box.listBatch({ limit: 8, deadlineMs: 2_000 });
      const elapsed = Date.now() - started;
      assert.equal(batch.observations.length, 8);
      assert.equal(batch.scanned, 8);
      assert.equal(batch.truncated, true);
      assert.ok(elapsed < 2_000, `bounded batch should not need the full dir, elapsed=${elapsed}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bounded batches eventually visit every retained record regardless of dirent order", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-fair-"));
    try {
      const box = await openCursorExternalApiOutbox({ directory: dir });
      const ids = Array.from({ length: 80 }, (_, i) =>
        createHash("sha256").update(`fair-${i}`).digest("hex").slice(0, 32),
      );
      for (const id of ids) await box.writeIntent(intent({ billingId: id }));
      const seen = new Set<string>();
      const ends: string[] = [];
      for (let i = 0; i < 16; i += 1) {
        const batch = await box.listBatch({ limit: 32, deadlineMs: 2_000 });
        for (const o of batch.observations) seen.add(o.file);
        ends.push(batch.observations.at(-1)?.file ?? "");
        assert.ok(batch.observations.length <= 32);
      }
      assert.equal(seen.size, 80, `must cover all 80, seen=${seen.size} ends=${ends.join(">")}`);
      const missing = ids.map((id) => `${id}.json`).find((f) => !seen.has(f));
      assert.equal(missing, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a later ready behind long-lived intent/unknown/corrupt becomes visible", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-later-"));
    try {
      const box = await openCursorExternalApiOutbox({ directory: dir });
      await writeFile(path.join(dir, "00-corrupt.json"), "{", "utf8");
      await writeFile(
        path.join(dir, "01-unknown.json"),
        JSON.stringify({ schema: 1, phase: "other", billingId: "b".repeat(32) }),
        "utf8",
      );
      const ids = Array.from({ length: 40 }, (_, i) =>
        createHash("sha256").update(`later-${i}`).digest("hex").slice(0, 32),
      );
      for (const id of ids) await box.writeIntent(intent({ billingId: id }));
      const first = await box.listBatch({ limit: 8 });
      assert.equal(first.observations.length, 8);
      const target = ids[ids.length - 1]!;
      await box.writeReady(ready({ billingId: target }));
      let sawReady = false;
      for (let i = 0; i < 12; i += 1) {
        const batch = await box.listBatch({ limit: 8 });
        if (batch.observations.some((o) => o.kind === "ready" && o.file === `${target}.json`)) {
          sawReady = true;
          break;
        }
      }
      assert.equal(sawReady, true, "sealed ready must appear in a later bounded batch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("new files are visited and deleted files do not stall the cursor", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-mut-"));
    try {
      const box = await openCursorExternalApiOutbox({ directory: dir });
      const firstId = createHash("sha256").update("mut-0").digest("hex").slice(0, 32);
      await box.writeIntent(intent({ billingId: firstId }));
      const batch1 = await box.listBatch({ limit: 8 });
      assert.equal(batch1.observations.some((o) => o.file === `${firstId}.json`), true);
      await unlink(path.join(dir, `${firstId}.json`));
      const added = createHash("sha256").update("mut-new").digest("hex").slice(0, 32);
      await box.writeIntent(intent({ billingId: added }));
      let sawAdded = false;
      for (let i = 0; i < 6; i += 1) {
        const batch = await box.listBatch({ limit: 8 });
        if (batch.observations.some((o) => o.file === `${added}.json`)) sawAdded = true;
        assert.equal(batch.observations.some((o) => o.file === `${firstId}.json`), false);
      }
      assert.equal(sawAdded, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

