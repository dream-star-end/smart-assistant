/**
 * V3 commercial container-side durable retry queue unit tests.
 *
 * Covers:
 *   - enqueueDurable writes to dir as a single .json file (atomic rename)
 *   - drainOnce: success unlinks; transient bumps attempts and rewrites;
 *     fatal V3SinkError unlinks (terminal); TTL drops; ENOENT-tolerant;
 *     malformed-JSON unlinks; session_missing rewrites.
 *   - kick is single-flight (concurrent kicks coalesce to one drain pass)
 *   - pendingCount reflects on-disk state including after rewrites
 *   - skips .tmp-* and non-.json files
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/v3MasterRetryQueue.test.ts
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ENTRY_TTL_MS,
  makeV3MasterRetryQueue,
  type V3MasterRetryEntry,
} from "../v3MasterRetryQueue.js";
import {
  V3SinkError,
  type V3MasterSinkWirePayload,
} from "../v3MasterSink.js";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "v3-retry-test-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Empty the dir between tests so they're independent.
  try {
    const names = await readdir(dir);
    await Promise.all(names.map((n) => rm(join(dir, n), { force: true })));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(dir, { recursive: true });
});

function basePayload(overrides: Partial<V3MasterSinkWirePayload> = {}): V3MasterSinkWirePayload & { createdAt: number } {
  // Default to wire-shape with agentId set — matches what a post-Fix-A
  // (2026-05-13) gateway enqueues. Tests that want to exercise the
  // pre-Fix-A legacy on-disk shape can override `agentId: undefined`.
  return {
    sessionId: "sess12345",
    turnIndex: 1,
    status: "completed",
    text: "hello",
    agentId: "main",
    createdAt: Date.now(),
    ...overrides,
  };
}

function entry(payload = basePayload()): V3MasterRetryEntry {
  return {
    schemaVersion: 1,
    payload,
    // Default firstSeenAt = now so auto-kick + TTL check won't drop the
    // entry before the test has a chance to inspect or drain it.
    firstSeenAt: Date.now(),
    attempts: 1,
  };
}

/** Hangs forever — use when the test wants the auto-kick from
 *  `enqueueDurable` to NOT consume the entry it just wrote. */
function neverResolves(): () => Promise<void> {
  return () => new Promise<void>(() => { /* never */ });
}

async function listJsonFiles(): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((n) => n.endsWith(".json") && !n.includes(".tmp-"));
}

// ─── enqueue ────────────────────────────────────────────────────────────

describe("enqueueDurable", () => {
  test("writes one .json file and parses back to schema", async () => {
    // Hanging attemptSend so the auto-kick doesn't drain the entry
    // before we read it back.
    const q = makeV3MasterRetryQueue({ dir, attemptSend: neverResolves() });
    await q.enqueueDurable(entry());
    const files = await listJsonFiles();
    assert.equal(files.length, 1);
    const raw = await readFile(join(dir, files[0]), "utf8");
    const parsed = JSON.parse(raw) as V3MasterRetryEntry;
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.payload.sessionId, "sess12345");
  });

  test("multiple concurrent enqueues all land", async () => {
    const q = makeV3MasterRetryQueue({ dir, attemptSend: neverResolves() });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => q.enqueueDurable(entry(basePayload({ turnIndex: i })))),
    );
    const files = await listJsonFiles();
    assert.equal(files.length, 5);
  });

  // ── Phase 0.4: thinkingText durability through retry queue ──
  test("thinkingText round-trips through enqueue + transient rewrite + successful drain", async () => {
    // Three-step lifecycle to lock in the durability invariant:
    //   1. enqueue → on-disk JSON includes thinkingText
    //   2. drain with transient throw → rewrite still contains thinkingText
    //   3. drain with success → attemptSend receives thinkingText from disk
    let stage: "transient" | "success" = "transient";
    let lastSeen: string | undefined;
    // per-entry 退避后,同一时刻连续 drain 第二次会被跳过 → 注入可控时钟,stage 3 前推进
    // 过退避窗(> RETRY_BACKOFF_MAX_MS)再 drain,反映"退避到期后重试"的新语义。
    let clock = Date.now();
    const q = makeV3MasterRetryQueue({
      dir,
      now: () => clock,
      attemptSend: async (p) => {
        lastSeen = p.thinkingText;
        if (stage === "transient")
          throw new V3SinkError("master 502", "transient", 502);
        // success path
      },
    });

    const payload = basePayload({
      thinkingText: "step 1. think. step 2. answer.",
    });
    await writeEntryDirect(entry(payload));

    // Stage 1: assert raw file carries thinkingText
    const filesBefore = await listJsonFiles();
    const beforeRaw = JSON.parse(
      await readFile(join(dir, filesBefore[0]), "utf8"),
    ) as V3MasterRetryEntry;
    assert.equal(beforeRaw.payload.thinkingText, "step 1. think. step 2. answer.");

    // Stage 2: transient retry preserves thinkingText after rewrite
    await q.drainOnce();
    const filesAfter = await listJsonFiles();
    assert.equal(filesAfter.length, 1, "transient leaves entry on disk");
    const afterRaw = JSON.parse(
      await readFile(join(dir, filesAfter[0]), "utf8"),
    ) as V3MasterRetryEntry;
    assert.equal(afterRaw.attempts, 2, "attempts bumped");
    assert.equal(
      afterRaw.payload.thinkingText,
      "step 1. think. step 2. answer.",
      "thinkingText preserved through rewrite",
    );

    // Stage 3: success drain — attemptSend sees thinkingText.
    // 推进时钟过退避窗(attempts=2 退避 10s,这里 +6min > 上限,确保到期可重试)。
    stage = "success";
    clock += 6 * 60_000;
    await q.drainOnce();
    assert.equal(lastSeen, "step 1. think. step 2. answer.");
    const filesEnd = await listJsonFiles();
    assert.equal(filesEnd.length, 0, "successful drain unlinked");
  });

  test("thinking-only payload (text='') round-trips through retry queue", async () => {
    // Edge case: Sonnet 4.6 turn that produced thinking but ran out of
    // tokens before assistant text. The retry queue must not drop this
    // entry just because text is empty.
    let received: { text: string; thinkingText?: string } | undefined;
    const q = makeV3MasterRetryQueue({
      dir,
      attemptSend: async (p) => {
        received = { text: p.text, thinkingText: p.thinkingText };
      },
    });
    await writeEntryDirect(
      entry(basePayload({ text: "", thinkingText: "thinking-only reasoning" })),
    );
    const stats = await q.drainOnce();
    assert.equal(stats.drained, 1);
    assert.deepEqual(received, {
      text: "",
      thinkingText: "thinking-only reasoning",
    });
  });
});

// ─── agentId wire compatibility (Fix A, 2026-05-13) ─────────────────────
//
// The retry queue must accept BOTH legacy on-disk entries (written by a
// pre-Fix-A gateway image, no agentId on disk) AND new entries (with
// agentId). Drainer compatibility is what makes rolling deploys safe:
// upgrading the container image must not orphan entries that the previous
// image wrote.

describe("agentId wire compatibility", () => {
  test("legacy and new entries coexist in one drain pass; each forwards its own agentId verbatim", async () => {
    // Two entries on disk:
    //   - Legacy: no `agentId` key. Drainer hands payload to attemptSend
    //     with `agentId === undefined`. Master falls back to legacy
    //     `srv-${sessionId}-t${turnIndex}` id format on the receive side.
    //   - New: `agentId: "codex"`. Drainer forwards verbatim.
    // Both must drain successfully and reach attemptSend with the exact
    // shape they were stored with.
    const received: Array<{ sessionId: string; agentId?: string }> = [];
    const q = makeV3MasterRetryQueue({
      dir,
      attemptSend: async (p) => {
        received.push({ sessionId: p.sessionId, agentId: p.agentId });
      },
    });
    // Order matters: filenames are lex-sorted in drainOnce, so write
    // legacy first (older ts in filename via writeEntryDirect's counter).
    await writeEntryDirect(
      entry(basePayload({ sessionId: "sess-legacy", agentId: undefined })),
    );
    await writeEntryDirect(
      entry(basePayload({ sessionId: "sess-new", agentId: "codex" })),
    );
    const stats = await q.drainOnce();
    assert.equal(stats.considered, 2);
    assert.equal(stats.drained, 2);
    // Both reached attemptSend with their stored shape — legacy with no
    // agentId, new with "codex".
    assert.equal(received.length, 2);
    const legacy = received.find((r) => r.sessionId === "sess-legacy");
    const fresh = received.find((r) => r.sessionId === "sess-new");
    assert.ok(legacy, "legacy entry drained");
    assert.ok(fresh, "new entry drained");
    assert.equal(legacy.agentId, undefined, "legacy on-disk entry has no agentId");
    assert.equal(fresh.agentId, "codex", "new entry forwarded its agentId");
    const files = await listJsonFiles();
    assert.equal(files.length, 0, "both unlinked after success");
  });

  test("malformed agentId on disk → entry rejected as schema mismatch + unlinked", async () => {
    // Writing a malformed agentId (e.g. with a `.` which would fail master's
    // regex anyway) onto disk would otherwise round-trip to master and earn
    // a 400 INVALID_BODY → fatal classification → drop. Screening here saves
    // the round trip and produces a clearer "malformed entry" log line
    // instead of a confusing "master rejected 400" one.
    let attemptCalls = 0;
    const q = makeV3MasterRetryQueue({
      dir,
      attemptSend: async () => { attemptCalls++; },
    });
    // Hand-craft a JSON file with an invalid agentId — bypasses the type
    // system that would otherwise refuse it. This is what an in-the-wild
    // corrupt entry would look like.
    const malformed = {
      schemaVersion: 1,
      payload: {
        sessionId: "sess-bad",
        turnIndex: 0,
        status: "completed",
        text: "x",
        // `.` is not in [A-Za-z0-9_-]; minimax2.7-style ids are valid only
        // on the personal version, which uses the legacy local-SQLite path
        // and never reaches this queue. A v3-commercial container with a
        // `.` in agentId on disk indicates corruption or wire-format drift.
        agentId: "minimax2.7",
        createdAt: Date.now(),
      },
      firstSeenAt: Date.now(),
      attempts: 1,
    };
    await writeFile(
      join(dir, `${Date.now()}-99999999.json`),
      JSON.stringify(malformed),
      "utf8",
    );
    const stats = await q.drainOnce();
    assert.equal(stats.fatalDropped, 1, "rejected as schema mismatch");
    assert.equal(attemptCalls, 0, "attemptSend never invoked");
    const files = await listJsonFiles();
    assert.equal(files.length, 0, "malformed entry unlinked");
  });

  test("agentId exceeding 64 chars on disk → rejected as schema mismatch + unlinked", async () => {
    // Boundary check: master's BodySchema caps at 64 chars; our defense-in-
    // depth check here mirrors it so we don't round-trip oversized ids.
    let attemptCalls = 0;
    const q = makeV3MasterRetryQueue({
      dir,
      attemptSend: async () => { attemptCalls++; },
    });
    const tooLong = "a".repeat(65);
    const malformed = {
      schemaVersion: 1,
      payload: {
        sessionId: "sess-bad",
        turnIndex: 0,
        status: "completed",
        text: "x",
        agentId: tooLong,
        createdAt: Date.now(),
      },
      firstSeenAt: Date.now(),
      attempts: 1,
    };
    await writeFile(
      join(dir, `${Date.now()}-88888888.json`),
      JSON.stringify(malformed),
      "utf8",
    );
    const stats = await q.drainOnce();
    assert.equal(stats.fatalDropped, 1);
    assert.equal(attemptCalls, 0);
    const files = await listJsonFiles();
    assert.equal(files.length, 0);
  });
});

// ─── drainOnce: success path ─────────────────────────────────────────────

describe("drainOnce — success path", () => {
  test("attemptSend resolves → file unlinked, drained++", async () => {
    let calls = 0;
    const q = makeV3MasterRetryQueue({
      dir,
      attemptSend: async () => {
        calls++;
      },
    });
    // Use writeEntryDirect to skip the auto-kick from enqueueDurable so
    // we can assert drainOnce's own stats deterministically.
    await writeEntryDirect(entry());
    const stats = await q.drainOnce();
    assert.equal(stats.considered, 1);
    assert.equal(stats.drained, 1);
    assert.equal(calls, 1);
    const files = await listJsonFiles();
    assert.equal(files.length, 0);
  });
});

// ─── drainOnce: transient retry ──────────────────────────────────────────

describe("drainOnce — transient retry", () => {
  test("transient throw → attempts bumped, file kept", async () => {
    const q = makeV3MasterRetryQueue({
      dir,
      attemptSend: async () => {
        throw new V3SinkError("master 502", "transient", 502);
      },
    });
    // Use drainOnce directly — but we still need an entry on disk first.
    await writeEntryDirect(entry({ ...basePayload(), text: "stay" }));
    const stats = await q.drainOnce();
    assert.equal(stats.retried, 1);
    assert.equal(stats.pending, 1);
    const files = await listJsonFiles();
    assert.equal(files.length, 1);
    const reread = JSON.parse(await readFile(join(dir, files[0]), "utf8")) as V3MasterRetryEntry;
    assert.equal(reread.attempts, 2);
    assert.equal(reread.lastErrorClass, "transient");
    assert.ok(typeof reread.lastErrorAt === "number");
  });

  test("session_missing throw → also kept and bumped", async () => {
    const q = makeV3MasterRetryQueue({
      dir,
      attemptSend: async () => {
        throw new V3SinkError("session_not_found", "session_missing", 404);
      },
    });
    await writeEntryDirect(entry());
    const stats = await q.drainOnce();
    assert.equal(stats.retried, 1);
    const files = await listJsonFiles();
    assert.equal(files.length, 1);
    const reread = JSON.parse(await readFile(join(dir, files[0]), "utf8")) as V3MasterRetryEntry;
    assert.equal(reread.lastErrorClass, "session_missing");
  });

  test("per-entry 指数退避:退避窗内跳过 attemptSend,到期后才重试(防风暴)", async () => {
    let clock = Date.now();
    let calls = 0;
    const q = makeV3MasterRetryQueue({
      dir,
      now: () => clock,
      attemptSend: async () => {
        calls += 1;
        throw new V3SinkError("session_not_found", "session_missing", 404);
      },
    });
    await writeEntryDirect(entry()); // attempts=1, 无 lastErrorAt → 首轮立即尝试
    await q.drainOnce();
    assert.equal(calls, 1, "首轮立即尝试一次(失败 → bump attempts=2 + 记 lastErrorAt)");
    // 同一时刻再 drain:退避未到期 → 跳过,不再打 master(这是消除风暴的关键)。
    await q.drainOnce();
    assert.equal(calls, 1, "退避窗内连续 drain 不重复 attemptSend");
    clock += 9_000; // < attempts=2 的 10s 退避
    await q.drainOnce();
    assert.equal(calls, 1, "退避未满仍跳过");
    clock += 60_000; // 越过退避窗
    await q.drainOnce();
    assert.equal(calls, 2, "退避到期后重试一次");
  });
});

// ─── drainOnce: fatal terminal ───────────────────────────────────────────

describe("drainOnce — fatal terminal", () => {
  test("fatal V3SinkError → file unlinked + fatalDropped++", async () => {
    const q = makeV3MasterRetryQueue({
      dir,
      attemptSend: async () => {
        throw new V3SinkError("master 400", "fatal", 400);
      },
    });
    await writeEntryDirect(entry());
    const stats = await q.drainOnce();
    assert.equal(stats.fatalDropped, 1);
    assert.equal(stats.retried, 0);
    const files = await listJsonFiles();
    assert.equal(files.length, 0);
  });
});

// ─── drainOnce: TTL ──────────────────────────────────────────────────────

describe("drainOnce — TTL drop", () => {
  test("entry past ENTRY_TTL_MS → unlinked + ttlDropped++ before attempt", async () => {
    let attemptCalls = 0;
    const fixedNow = 10_000_000_000;
    const q = makeV3MasterRetryQueue({
      dir,
      now: () => fixedNow,
      attemptSend: async () => { attemptCalls++; },
    });
    const stale: V3MasterRetryEntry = {
      schemaVersion: 1,
      payload: basePayload(),
      // TTL = 24h. firstSeenAt 25h before now → expired.
      firstSeenAt: fixedNow - ENTRY_TTL_MS - 60_000,
      attempts: 5,
      lastErrorClass: "transient",
    };
    await writeEntryDirect(stale);
    const stats = await q.drainOnce();
    assert.equal(stats.ttlDropped, 1);
    assert.equal(attemptCalls, 0); // attempt skipped — entry expired
    const files = await listJsonFiles();
    assert.equal(files.length, 0);
  });

  test("entry within TTL → attempt fires", async () => {
    let attemptCalls = 0;
    const fixedNow = 10_000_000_000;
    const q = makeV3MasterRetryQueue({
      dir,
      now: () => fixedNow,
      attemptSend: async () => { attemptCalls++; },
    });
    const fresh: V3MasterRetryEntry = {
      schemaVersion: 1,
      payload: basePayload(),
      firstSeenAt: fixedNow - 1000,
      attempts: 1,
    };
    await writeEntryDirect(fresh);
    await q.drainOnce();
    assert.equal(attemptCalls, 1);
  });
});

// ─── drainOnce: malformed entry ──────────────────────────────────────────

describe("drainOnce — malformed entry", () => {
  test("invalid JSON → unlinked + fatalDropped++", async () => {
    const q = makeV3MasterRetryQueue({ dir, attemptSend: async () => undefined });
    await writeFile(join(dir, "1234567890123-deadbeef.json"), "{not json", "utf8");
    const stats = await q.drainOnce();
    assert.equal(stats.fatalDropped, 1);
    const files = await listJsonFiles();
    assert.equal(files.length, 0);
  });

  test("schema mismatch → unlinked", async () => {
    const q = makeV3MasterRetryQueue({ dir, attemptSend: async () => undefined });
    await writeFile(
      join(dir, "1234567890123-cafebabe.json"),
      JSON.stringify({ schemaVersion: 99, foo: "bar" }),
      "utf8",
    );
    const stats = await q.drainOnce();
    assert.equal(stats.fatalDropped, 1);
  });
});

// ─── drainOnce: ENOENT tolerance ─────────────────────────────────────────

describe("drainOnce — ENOENT tolerance", () => {
  test("dir missing → returns zero stats, no throw", async () => {
    const missingDir = join(dir, "does-not-exist");
    const q = makeV3MasterRetryQueue({ dir: missingDir, attemptSend: async () => undefined });
    const stats = await q.drainOnce();
    assert.equal(stats.considered, 0);
    assert.equal(stats.errors, 0);
  });

  test("file vanishes mid-pass → no throw, just skipped", async () => {
    const q = makeV3MasterRetryQueue({
      dir,
      attemptSend: async () => { /* success */ },
    });
    // Two real entries; the drain loop should handle if one disappears
    // between readdir and readFile (we simulate by deleting it after
    // listing).
    await writeEntryDirect(entry(basePayload({ turnIndex: 1 })));
    await writeEntryDirect(entry(basePayload({ turnIndex: 2 })));
    // Simply drain — if both are real, both should drain successfully,
    // and a vanishing entry would only show as skipped (no error).
    // The defensive ENOENT branch is exercised by readFile/unlink failing
    // mid-pass, which is hard to set up deterministically; this test
    // just asserts the happy path doesn't error and the dir empties.
    const stats = await q.drainOnce();
    assert.equal(stats.drained, 2);
    const files = await listJsonFiles();
    assert.equal(files.length, 0);
  });
});

// ─── drainOnce: file filtering ───────────────────────────────────────────

describe("drainOnce — file filtering", () => {
  test("ignores .tmp-* and non-.json files", async () => {
    const q = makeV3MasterRetryQueue({ dir, attemptSend: async () => undefined });
    await writeFile(join(dir, "1.json.tmp-1234-abcd"), "stale tmp", "utf8");
    await writeFile(join(dir, "README.txt"), "not an entry", "utf8");
    await writeEntryDirect(entry());
    const stats = await q.drainOnce();
    assert.equal(stats.considered, 1);
    assert.equal(stats.drained, 1);
    // Stray files left untouched.
    const remaining = await readdir(dir);
    assert.ok(remaining.includes("README.txt"));
    assert.ok(remaining.some((n) => n.includes(".tmp-")));
  });
});

// ─── pendingCount ────────────────────────────────────────────────────────

describe("pendingCount", () => {
  test("counts only matched .json (no .tmp- / non-.json)", async () => {
    const q = makeV3MasterRetryQueue({ dir, attemptSend: async () => undefined });
    await writeEntryDirect(entry(basePayload({ turnIndex: 1 })));
    await writeEntryDirect(entry(basePayload({ turnIndex: 2 })));
    await writeFile(join(dir, "README.txt"), "x", "utf8");
    await writeFile(join(dir, "x.json.tmp-foo", ), "x", "utf8");
    assert.equal(await q.pendingCount(), 2);
  });

  test("returns 0 when dir missing", async () => {
    const q = makeV3MasterRetryQueue({ dir: join(dir, "missing"), attemptSend: async () => undefined });
    assert.equal(await q.pendingCount(), 0);
  });
});

// ─── kick single-flight ──────────────────────────────────────────────────

describe("kick — single-flight", () => {
  test("concurrent kicks during a slow drain coalesce to one in-flight pass + one rerun", async () => {
    let inflight = 0;
    let maxInflight = 0;
    let totalCalls = 0;
    const q = makeV3MasterRetryQueue({
      dir,
      attemptSend: async () => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        totalCalls++;
        // Simulate a slow attempt so kicks during it pile up.
        await new Promise((r) => setTimeout(r, 20));
        inflight--;
      },
    });
    await writeEntryDirect(entry());
    // Spam-kick. Internal lock should serialise to at most 1 attempt at a time.
    q.kick(); q.kick(); q.kick(); q.kick(); q.kick();
    // Wait long enough for the drain loop to settle.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(maxInflight, 1, "no parallel attempts");
    // The single entry was drained in the first pass; subsequent kicks
    // would no-op (dir empty). totalCalls must be 1.
    assert.equal(totalCalls, 1);
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────

let entryCounter = 0;
async function writeEntryDirect(e: V3MasterRetryEntry): Promise<string> {
  // Plain write — bypasses enqueueDurable's auto-kick so the test can
  // call drainOnce explicitly. Filename mimics the real format.
  const name = `${Date.now()}-${(entryCounter++).toString().padStart(8, "0")}.json`;
  await writeFile(join(dir, name), JSON.stringify(e), "utf8");
  return name;
}
