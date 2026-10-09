/**
 * OCV5-365: idle outbox scans must not log one info line per 5s tick.
 * Kept out of cursorExternalApiOutbox.test.ts, whose leaf list is pinned by
 * scripts/check-v5-session-unavailable-rootfix.ts (A_EXTERNAL_LEAVES).
 * Run: npx tsx --test packages/commercial/src/__tests__/cursorExternalApiOutboxScanLog.test.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Logger } from "../logging/logger.js";
import { openCursorExternalApiOutbox } from "../billing/cursorExternalApiOutbox.js";

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
  return logger as unknown as Logger;
}

test("idle scans log one heartbeat, not one line per tick (OCV5-365)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-outbox-idle-log-"));
  const lines: Array<Record<string, unknown>> = [];
  try {
    const box = await openCursorExternalApiOutbox({ directory: dir });
    const deps = { pool: {} as never, pricing: { get: () => null } as never, logger: capturingLogger(lines) };
    for (let i = 0; i < 5; i += 1) await box.scanOnce(deps);
    assert.equal(lines.filter((l) => l.msg === "cursor_external_outbox_scan").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
