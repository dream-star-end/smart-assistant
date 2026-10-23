import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm, link, unlink, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { FileBoxContextTransport, BoxContextTransportError } from "./boxContextTransport.js";

const binding = { uid: "765", containerId: "765", model: "box-api-claude-opus-5-5",
  sessionId: "g607-test-session" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "g607-context-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const rejectCode = (code: string) => (e: unknown) =>
  e instanceof BoxContextTransportError && e.code === code;

test("lossless context transport preserves every byte of a 17 MiB history after restart", async () => {
  await fixture(async (dir) => {
    const store = new FileBoxContextTransport(dir);
    const image = Buffer.alloc(146_000, 79).toString("base64");
    const messages = Array.from({ length: 91 }, (_, i) => ({
      role: "user", content: [{ type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: image },
        marker: "image-" + i }],
    }));
    const raw = JSON.stringify(messages);
    assert.ok(Buffer.byteLength(raw) > 16 * 1024 * 1024);
    const ref = await store.put(binding, messages);
    assert.equal(ref.messages_sha256, sha(raw));
    assert.equal(ref.message_count, 91);
    const restored = await new FileBoxContextTransport(dir).get(binding, ref.reference);
    assert.equal(JSON.stringify(restored), raw);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    assert.equal(names.length, 1);
    assert.equal((await stat(path.join(dir, names[0]!))).mode & 0o777, 0o600);
  });
});

test("context references cannot cross user, container, model or native session", async () => {
  await fixture(async (dir) => {
    const store = new FileBoxContextTransport(dir);
    const ref = await store.put(binding, [{ role: "user", content: "private fixture" }]);
    for (const other of [
      { ...binding, uid: "247" }, { ...binding, containerId: "247" },
      { ...binding, model: "box-api-claude-sonnet-5-5" }, { ...binding, sessionId: "other" },
    ]) await assert.rejects(store.get(other, ref.reference), rejectCode("BOX_CONTEXT_REF_EXPIRED"));
    await assert.rejects(store.get(binding, "../invalid"), rejectCode("BOX_CONTEXT_REF_INVALID"));
  });
});

test("same-size corruption is rejected without returning a partial prefix", async () => {
  await fixture(async (dir) => {
    const store = new FileBoxContextTransport(dir);
    const ref = await store.put(binding, [{ role: "user", content: "original" }]);
    const name = (await readdir(dir)).find((n) => n.endsWith(".json"))!;
    const file = path.join(dir, name);
    await writeFile(file, (await readFile(file, "utf8")).replace("original", "tampered"));
    await assert.rejects(store.get(binding, ref.reference), rejectCode("BOX_CONTEXT_REF_INVALID"));
  });
});

test("cache files reject symlinks and extra hardlinks", async () => {
  await fixture(async (dir) => {
    const store = new FileBoxContextTransport(dir);
    const ref = await store.put(binding, [{ role: "user", content: "fixture" }]);
    const name = (await readdir(dir)).find((n) => n.endsWith(".json"))!;
    const file = path.join(dir, name);
    const extra = path.join(dir, "own-extra-link");
    await link(file, extra);
    await assert.rejects(store.get(binding, ref.reference), rejectCode("BOX_CONTEXT_REF_INVALID"));
    await unlink(extra);
    assert.equal((await store.get(binding, ref.reference)).length, 1);
    await writeFile(extra, "outside fixture");
    await unlink(file);
    await symlink(extra, file);
    await assert.rejects(store.get(binding, ref.reference), rejectCode("BOX_CONTEXT_REF_INVALID"));
    assert.equal(await readFile(extra, "utf8"), "outside fixture");
  });
});

test("expired references fail before use and garbage collection preserves unrelated files", async () => {
  await fixture(async (dir) => {
    let now = Date.now();
    const store = new FileBoxContextTransport(dir, () => now);
    await writeFile(path.join(dir, "KEEP"), "own sentinel");
    const ref = await store.put(binding, [{ role: "user", content: "old" }]);
    now = ref.expires_at + 1;
    await assert.rejects(store.get(binding, ref.reference), rejectCode("BOX_CONTEXT_REF_EXPIRED"));
    await store.put(binding, [{ role: "user", content: "new" }]);
    assert.equal((await readdir(dir)).filter((n) => n.endsWith(".json")).length, 1);
    assert.equal(await readFile(path.join(dir, "KEEP"), "utf8"), "own sentinel");
  });
});

test("independent store instances serialize file publication and quota with kernel locks", async () => {
  await fixture(async (dir) => {
    const stores = [new FileBoxContextTransport(dir), new FileBoxContextTransport(dir)];
    const refs = await Promise.all(Array.from({ length: 12 }, async (_, i) =>
      stores[i % 2]!.put(binding, [{ role: "user", content: "item-" + i }])));
    assert.equal(new Set(refs.map((r) => r.reference)).size, 12);
    await Promise.all(refs.map(async (ref, i) =>
      assert.deepEqual(await stores[(i + 1) % 2]!.get(binding, ref.reference),
        [{ role: "user", content: "item-" + i }])));
    assert.equal((await readdir(dir)).filter((n) => n.endsWith(".part")).length, 0);
  });
});

test("context expansion cannot evade the original total or message count ceiling", async () => {
  await fixture(async (dir) => {
    const store = new FileBoxContextTransport(dir);
    await assert.rejects(store.put(binding, [{ role: "user", content: "x".repeat(24 * 1024 * 1024) }]),
      rejectCode("BOX_CONTEXT_TOO_LARGE"));
    await assert.rejects(store.put(binding, Array.from({ length: 2001 }, () => ({}))),
      rejectCode("BOX_CONTEXT_TOO_LARGE"));
    assert.equal((await readdir(dir)).length, 0);
  });
});

test("cache entry count is bounded and older references can be re-registered", async () => {
  await fixture(async (dir) => {
    const store = new FileBoxContextTransport(dir);
    const first = await store.put(binding, [{ role: "user", content: "first" }]);
    for (let i = 0; i < 128; i++) await store.put(binding, [{ role: "user", content: "later-" + i }]);
    assert.equal((await readdir(dir)).filter((n) => n.endsWith(".json")).length, 128);
    const peer = new FileBoxContextTransport(dir);
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? peer : store).put(binding, [{ role: "user", content: "concurrent-" + i }])));
    assert.equal((await readdir(dir)).filter((n) => n.endsWith(".json")).length, 128,
      "kernel lock also serializes quota admission, not only unique filenames");
    await assert.rejects(store.get(binding, first.reference), rejectCode("BOX_CONTEXT_REF_EXPIRED"));
    const again = await store.put(binding, [{ role: "user", content: "first" }]);
    assert.deepEqual(await store.get(binding, again.reference), [{ role: "user", content: "first" }]);
  });
});

