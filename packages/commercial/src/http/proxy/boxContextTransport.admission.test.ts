import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileBoxContextTransport, restoreBoxContextRequest } from "./boxContextTransport.js";
import { PROXY_BYTE_BUDGET_BOX_NATIVE_V1 } from "./shared.js";
import { contextProbeBody, contextProbeHarness } from "./testing/boxContextTransportHarness.js";
import { runBoxContextTransportProbe } from "./testing/boxContextTransportProbe.js";

async function fixture(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "g607-admission-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("OCV5-607 restores all 91 images with unchanged canonical bytes and v1 context hash", async () => {
  await fixture(async (dir) => {
    const result = await runBoxContextTransportProbe(dir);
    assert.equal(result.images, 91);
    assert.ok(result.bodyBytes > 16 * 1024 * 1024);
  });
});

test("context registration cannot execute Cursor, external API or an unverified Box route", async () => {
  await fixture(async (dir) => {
    const store = new FileBoxContextTransport(dir);
    for (const options of [
      { external: true }, { badSignature: true }, { owner: false }, { provider: "anthropic" },
      { localCatalog: true }, { leaseOnly: true },
    ]) {
      const h = contextProbeHarness(store, options);
      try {
        const response = await h.call(contextProbeBody([{ role: "user", content: "test" }]));
        assert.ok(response.statusCode >= 400);
        if (options.localCatalog) assert.equal(response.json().error?.code,
          "BOX_CONTEXT_TRANSPORT_UNAVAILABLE", "valid local-catalog budget is not a bridge capability");
        assert.deepEqual(h.counts, { prechecks: 0, db: 0, models: 0, cursor: 0, puts: 0, gets: 0 });
      } finally { h.close(); }
    }
    const cursor = contextProbeHarness(store);
    try {
      const response = await cursor.call(contextProbeBody([{ role: "user", content: "test" }],
        { model: "fable-5.1" }));
      assert.equal(response.statusCode, 400);
      assert.equal(cursor.counts.cursor, 0);
      assert.equal(cursor.counts.models, 0);
    } finally { cursor.close(); }
    assert.equal((await readdir(dir)).length, 0);
  });
});

test("transport schema and restored total/count limits fail before reservation", async () => {
  await fixture(async (dir) => {
    const store = new FileBoxContextTransport(dir);
    const binding = { uid: "765", containerId: "765", model: "box-api-claude-opus-5-5",
      sessionId: "g607-native-session" };
    const initial = await store.put(binding, [{ role: "user", content: "x".repeat(23 * 1024 * 1024) }]);
    const h = contextProbeHarness(store);
    try {
      const tooLarge = await h.call(contextProbeBody([
        { role: "user", content: "y".repeat(2 * 1024 * 1024) },
      ], { oc_context_transport: { version: 1, reference: initial.reference } }), "/v1/messages");
      assert.equal(tooLarge.statusCode, 413);
      const missing = await h.call(contextProbeBody([{ role: "user", content: "test" }],
        { oc_context_transport: { version: 1 } }), "/v1/messages");
      assert.equal(missing.statusCode, 400);
      const count = await store.put(binding, Array.from({ length: 2000 },
        () => ({ role: "user", content: "test" })));
      await assert.rejects(restoreBoxContextRequest({ store, uid: 765n, containerId: 765n,
        body: contextProbeBody([{ role: "user", content: "extra" }],
          { oc_context_transport: { version: 1, reference: count.reference } }),
        budget: PROXY_BYTE_BUDGET_BOX_NATIVE_V1, stage: false }),
      (e: any) => e.code === "BOX_CONTEXT_REF_INVALID");
      assert.equal(h.counts.prechecks, 0);
      assert.equal(h.counts.models, 0);
      assert.equal(h.counts.db, 0);
    } finally { h.close(); }
  });
});


test("a stored reference does not turn local catalog or lease-only requests into signed bridge owners", async () => {
  await fixture(async (dir) => {
    const store = new FileBoxContextTransport(dir);
    const reference = await store.put({ uid: "765", containerId: "765",
      model: "box-api-claude-opus-5-5", sessionId: "g607-native-session" },
    [{ role: "user", content: "private prefix" }]);
    for (const options of [{ localCatalog: true }, { leaseOnly: true }]) {
      const h = contextProbeHarness(store, options);
      try {
        const response = await h.call(contextProbeBody([{ role: "user", content: "tail" }],
          { oc_context_transport: { version: 1, reference: reference.reference } }), "/v1/messages");
        assert.ok(response.statusCode >= 400);
        assert.equal(h.counts.gets, 0);
        assert.equal(h.counts.prechecks, 0);
        assert.equal(h.counts.models, 0);
      } finally { h.close(); }
    }
  });
});
