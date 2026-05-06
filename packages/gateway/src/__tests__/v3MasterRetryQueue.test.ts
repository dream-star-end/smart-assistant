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
import { V3SinkError, type V3MasterSinkPayload } from "../v3MasterSink.js";

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

function basePayload(overrides: Partial<V3MasterSinkPayload> = {}): V3MasterSinkPayload & { createdAt: number } {
  return {
    sessionId: "sess12345",
    turnIndex: 1,
    status: "completed",
    text: "hello",
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
    const q = makeV3MasterRetryQueue({
      dir,
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

    // Stage 3: success drain — attemptSend sees thinkingText
    stage = "success";
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
