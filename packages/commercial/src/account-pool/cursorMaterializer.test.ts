import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  CURSOR_POOL_OWNED_MARKER,
  fingerprintCursorKey,
  isCanonicalCursorKeyFile,
  normalizeCursorApiKey,
  slotFileName,
  syncCursorAuthDir,
} from "./cursorMaterializer.js";

const KEY_A = `crsr_${"a".repeat(64)}`;
const KEY_B = `crsr_${"b".repeat(64)}`;

describe("cursor key helpers", () => {
  test("accepts crsr_ keys and rejects junk", () => {
    assert.equal(normalizeCursorApiKey(` ${KEY_A}\n`), KEY_A);
    assert.throws(() => normalizeCursorApiKey("not-a-key"), /invalid_cursor_api_key/);
  });

  test("slot names match oc-cursor canonical pool", () => {
    assert.equal(slotFileName(0), "api-key");
    assert.equal(slotFileName(1), "api-key.2");
    assert.equal(isCanonicalCursorKeyFile("api-key"), true);
    assert.equal(isCanonicalCursorKeyFile("api-key.2"), true);
    assert.equal(isCanonicalCursorKeyFile("api-key.1"), false);
    assert.equal(isCanonicalCursorKeyFile("api-key.bak-20260816"), false);
  });
});

describe("syncCursorAuthDir", () => {
  test("imports host files when the pool is empty, then writes active slots", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "oc-cursor-auth-"));
    writeFileSync(join(authDir, "api-key"), `${KEY_A}\n`, { mode: 0o600 });
    writeFileSync(join(authDir, "api-key.2"), `${KEY_B}\n`, { mode: 0o600 });
    writeFileSync(join(authDir, "api-key.bak-20260816"), "stale\n", { mode: 0o600 });

    const created: Array<{ label: string; token: string }> = [];
    let pool: Array<{ id: bigint; provider: "cursor"; status: "active"; cooldown_until: Date | null; token: string }> = [];

    const result = await syncCursorAuthDir({
      authDir,
      runtimeChannel: "v5",
      now: () => new Date("2026-08-19T00:00:00Z"),
      listAccounts: async () => pool as never,
      createAccount: async (input) => {
        created.push({ label: input.label, token: input.token });
        const row = {
          id: BigInt(created.length),
          provider: "cursor" as const,
          status: "active" as const,
          cooldown_until: null,
          token: input.token,
        };
        pool = [...pool, row];
        return { id: row.id, provider: row.provider, status: row.status, cooldown_until: null } as never;
      },
      getCursorTokenSnapshot: async (id) => {
        const row = pool.find((item) => item.id === BigInt(String(id)));
        return row ? { token: Buffer.from(row.token, "utf8") } as never : null;
      },
    });

    assert.equal(result.imported, 2);
    assert.equal(result.written, 2);
    assert.deepEqual(created.map((row) => row.token), [KEY_A, KEY_B]);
    assert.equal(readFileSync(join(authDir, "api-key"), "utf8"), `${KEY_A}\n`);
    assert.equal(readFileSync(join(authDir, "api-key.2"), "utf8"), `${KEY_B}\n`);
    assert.equal(readdirSync(authDir).includes("api-key.bak-20260816"), true);
    assert.equal(result.fingerprints[0], fingerprintCursorKey(KEY_A));
    assert.equal(existsSync(join(authDir, CURSOR_POOL_OWNED_MARKER)), true);
    assert.match(readFileSync(join(authDir, ".quota-class"), "utf8"), /api-key unknown/);
    assert.match(readFileSync(join(authDir, ".quota-class"), "utf8"), /api-key\.2 unknown/);
  });

  test("writes learned cursor_only into the sidecar without secrets", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "oc-cursor-auth-"));
    const result = await syncCursorAuthDir({
      authDir,
      listAccounts: async () =>
        [
          { id: 1n, provider: "cursor", status: "active", cooldown_until: null, cursor_quota_class: "cursor_only" },
          { id: 2n, provider: "cursor", status: "active", cooldown_until: null, cursor_quota_class: "other_ok" },
        ] as never,
      createAccount: async () => {
        throw new Error("must not import when pool already has rows");
      },
      getCursorTokenSnapshot: async (id) => {
        const key = String(id) === "1" ? KEY_A : KEY_B;
        return { token: Buffer.from(key, "utf8") } as never;
      },
    });
    assert.equal(result.written, 2);
    const sidecar = readFileSync(join(authDir, ".quota-class"), "utf8");
    assert.match(sidecar, /^# quota-class v1\n/);
    assert.match(sidecar, /api-key cursor_only/);
    assert.match(sidecar, /api-key\.2 other_ok/);
    assert.doesNotMatch(sidecar, /crsr_/);
  });

  test("writes cursor_sand_enabled into .sand-mode sidecar", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "oc-cursor-auth-"));
    const result = await syncCursorAuthDir({
      authDir,
      listAccounts: async () =>
        [
          { id: 1n, provider: "cursor", status: "active", cooldown_until: null, cursor_quota_class: "cursor_only", cursor_sand_enabled: true },
          { id: 2n, provider: "cursor", status: "active", cooldown_until: null, cursor_quota_class: "other_ok", cursor_sand_enabled: false },
        ] as never,
      createAccount: async () => {
        throw new Error("must not import when pool already has rows");
      },
      getCursorTokenSnapshot: async (id) => {
        const key = String(id) === "1" ? KEY_A : KEY_B;
        return { token: Buffer.from(key, "utf8") } as never;
      },
    });
    assert.equal(result.written, 2);
    const sidecar = readFileSync(join(authDir, ".sand-mode"), "utf8");
    assert.match(sidecar, /^# sand-mode v1\n/);
    assert.match(sidecar, /api-key 1/);
    assert.match(sidecar, /api-key\.2 0/);
  });


  test("after first import, deleting the last pool row does not re-import leftover host files", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "oc-cursor-auth-"));
    writeFileSync(join(authDir, "api-key"), `${KEY_A}\n`, { mode: 0o600 });

    const created: string[] = [];
    let pool: Array<{ id: bigint; provider: "cursor"; status: "active"; cooldown_until: Date | null; token: string }> = [];

    await syncCursorAuthDir({
      authDir,
      runtimeChannel: "v5",
      listAccounts: async () => pool as never,
      createAccount: async (input) => {
        created.push(input.token);
        const row = {
          id: BigInt(created.length),
          provider: "cursor" as const,
          status: "active" as const,
          cooldown_until: null,
          token: input.token,
        };
        pool = [...pool, row];
        return { id: row.id, provider: row.provider, status: row.status, cooldown_until: null } as never;
      },
      getCursorTokenSnapshot: async (id) => {
        const row = pool.find((item) => item.id === BigInt(String(id)));
        return row ? { token: Buffer.from(row.token, "utf8") } as never : null;
      },
    });
    assert.deepEqual(created, [KEY_A]);
    assert.equal(existsSync(join(authDir, CURSOR_POOL_OWNED_MARKER)), true);

    pool = [];
    const afterDelete = await syncCursorAuthDir({
      authDir,
      runtimeChannel: "v5",
      listAccounts: async () => [] as never,
      createAccount: async () => {
        throw new Error("must not re-import after the pool has already owned this dir");
      },
      getCursorTokenSnapshot: async () => null,
    });

    assert.equal(afterDelete.imported, 0);
    assert.equal(afterDelete.skipped, "empty-pool-keep-files");
    assert.equal(readFileSync(join(authDir, "api-key"), "utf8"), `${KEY_A}\n`);
    assert.equal(created.length, 1);
  });

  test("drops disabled or cooling keys from the host pool and keeps bak files", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "oc-cursor-auth-"));
    writeFileSync(join(authDir, "api-key"), `${KEY_A}\n`, { mode: 0o600 });
    writeFileSync(join(authDir, "api-key.2"), `${KEY_B}\n`, { mode: 0o600 });
    writeFileSync(join(authDir, "api-key.bak-keep"), "keep\n", { mode: 0o600 });

    const result = await syncCursorAuthDir({
      authDir,
      runtimeChannel: "v5",
      now: () => new Date("2026-08-19T00:00:00Z"),
      listAccounts: async () =>
        [
          { id: 2n, provider: "cursor", status: "active", cooldown_until: null },
          { id: 1n, provider: "cursor", status: "disabled", cooldown_until: null },
        ] as never,
      createAccount: async () => {
        throw new Error("must not import when pool already has rows");
      },
      getCursorTokenSnapshot: async (id) => {
        if (String(id) !== "2") return null;
        return { token: Buffer.from(KEY_B, "utf8") } as never;
      },
    });

    assert.equal(result.imported, 0);
    assert.equal(result.written, 1);
    assert.equal(readFileSync(join(authDir, "api-key"), "utf8"), `${KEY_B}\n`);
    assert.equal(readdirSync(authDir).includes("api-key.2"), false);
    assert.equal(readdirSync(authDir).includes("api-key.bak-keep"), true);
  });

  test("keeps host files when every pool row is disabled", async () => {
    const authDir = mkdtempSync(join(tmpdir(), "oc-cursor-auth-"));
    writeFileSync(join(authDir, "api-key"), `${KEY_A}\n`, { mode: 0o600 });

    const result = await syncCursorAuthDir({
      authDir,
      listAccounts: async () =>
        [{ id: 1n, provider: "cursor", status: "disabled", cooldown_until: null }] as never,
      createAccount: async () => {
        throw new Error("must not import when pool already has rows");
      },
      getCursorTokenSnapshot: async () => null,
    });

    assert.equal(result.skipped, "empty-pool-keep-files");
    assert.equal(readFileSync(join(authDir, "api-key"), "utf8"), `${KEY_A}\n`);
  });
});
