import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { FileBoxContextTransport, restoreBoxContextRequest } from "../boxContextTransport.js";
import {
  enforceFieldByteBudgets, enforceVerifiedProxyBudget, PROXY_BYTE_BUDGET_BOX_NATIVE_V1,
  runWithVerifiedProxyByteBudget, type ProxyBody,
} from "../shared.js";
import { deriveBoxContextHash } from "../boxCallFingerprint.js";
import { boxContextSummary } from "../boxContextMetrics.js";
import { contextProbeBody, contextProbeHarness } from "./boxContextTransportHarness.js";

/** Valid JPEGs with private synthetic APP15 bytes make the regression measure
 * actual base64 envelopes, without changing image resolution or quantization. */
export async function contextProbeHistory(): Promise<unknown[]> {
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3,
    background: { r: 123, g: 71, b: 201 } } }).jpeg().toBuffer();
  const images = Array.from({ length: 91 }, (_, i) => {
    const blocks = Array.from({ length: 3 }, () => {
      const raw = Buffer.alloc(48_004, i);
      raw[0] = 0xff; raw[1] = 0xef; raw.writeUInt16BE(48_002, 2);
      return raw;
    });
    const bytes = Buffer.concat([jpeg.subarray(0, 2), ...blocks, jpeg.subarray(2)]);
    return { type: "image", source: {
      type: "base64", media_type: "image/jpeg", data: bytes.toString("base64"),
    } };
  });
  const messages: unknown[] = [{ role: "user", content: "Read every fixture and retain the last marker." }];
  for (const [i, image] of images.slice(0, 85).entries()) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_g607_" + i,
      name: "Read", input: { file_path: "synthetic-" + i + ".jpg" } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_g607_" + i,
      content: [image] }] });
  }
  const pending = images.slice(85).map((image, i) => ({
    use: { type: "tool_use", id: "toolu_g607_tail_" + i, name: "Read",
      input: { file_path: "synthetic-tail-" + i + ".jpg" } },
    result: { type: "tool_result", tool_use_id: "toolu_g607_tail_" + i, content: [image] },
  }));
  messages.push({ role: "assistant", content: pending.map((p) => p.use) });
  messages.push({ role: "user", content: pending.map((p) => p.result) });
  return messages;
}

export async function runBoxContextTransportProbe(directory: string,
  verifyLegacyClaim?: (body: ProxyBody) => Promise<void>): Promise<{
  bodyBytes: number; messages: number; images: number; registrations: number;
}> {
  const store = new FileBoxContextTransport(directory);
  const harness = contextProbeHarness(store);
  const messages = await contextProbeHistory();
  const session = "g607-" + randomBytes(8).toString("hex");
  const original = contextProbeBody(messages, {
    metadata: { session_id: session,
      user_id: JSON.stringify({ session_id: session, oc_turn_key: randomBytes(32).toString("hex") }) },
    tools: [{ name: "Read", description: "Read",
    input_schema: { type: "object", properties: { file_path: { type: "string" } } } }] });
  const originalJSON = JSON.stringify(original);
  const bytes = Buffer.byteLength(originalJSON);
  assert.ok(bytes > 16 * 1024 * 1024 && bytes < 24 * 1024 * 1024);
  enforceFieldByteBudgets({ ...original, messages: original.messages.slice(0, -2) },
    PROXY_BYTE_BUDGET_BOX_NATIVE_V1); // the preceding legacy request was admissible
  assert.throws(() => enforceFieldByteBudgets(original, PROXY_BYTE_BUDGET_BOX_NATIVE_V1),
    (e: any) => e.code === "BODY_FIELD_TOO_LARGE");
  try {
    const old = await harness.call(original, "/v1/messages");
    assert.equal(old.statusCode, 413);
    assert.equal(old.json().error?.code, "BODY_FIELD_TOO_LARGE");
    let reference: string | undefined;
    let registrations = 0;
    const prefixEnd = messages.length - 1;
    for (let offset = 0; offset < prefixEnd; offset += 20) {
      const end = Math.min(offset + 20, prefixEnd);
      const request = { ...original, stream: false,
        messages: messages.slice(offset, end),
        oc_context_transport: { version: 1 as const, ...(reference ? { reference } : {}) } };
      enforceVerifiedProxyBudget(request, Buffer.byteLength(JSON.stringify(request)),
        PROXY_BYTE_BUDGET_BOX_NATIVE_V1);
      const response = await harness.call(request);
      assert.equal(response.statusCode, 200, "stage must finish before precheck/model work");
      const ref = response.json();
      assert.equal(ref.message_count, end);
      assert.equal(ref.messages_sha256,
        createHash("sha256").update(JSON.stringify(messages.slice(0, end))).digest("hex"));
      reference = ref.reference;
      registrations++;
    }
    const wire = { ...original, messages: messages.slice(prefixEnd),
      oc_context_transport: { version: 1 as const, reference: reference! } };
    enforceVerifiedProxyBudget(wire, Buffer.byteLength(JSON.stringify(wire)),
      PROXY_BYTE_BUDGET_BOX_NATIVE_V1);
    const restored = await restoreBoxContextRequest({ store, uid: 765n, containerId: 765n,
      body: wire, budget: PROXY_BYTE_BUDGET_BOX_NATIVE_V1, stage: false });
    assert.equal(JSON.stringify(restored.body), originalJSON);
    const summary = boxContextSummary(restored.body);
    assert.equal(summary.imageCount, 91);
    assert.equal(summary.uniqueImageCount, 91);
    assert.equal(summary.summaryComplete, true);
    assert.ok(summary.mediaBase64Bytes > 16 * 1024 * 1024);
    const contextHash = (body: ProxyBody) => runWithVerifiedProxyByteBudget(
      PROXY_BYTE_BUDGET_BOX_NATIVE_V1, () => deriveBoxContextHash(body));
    assert.equal(contextHash(restored.body), contextHash(original),
      "the original v1 context commitment is unchanged by references");
    const altered = structuredClone(restored.body);
    (altered.messages[0] as { content: string }).content += " changed";
    assert.notEqual(contextHash(altered), contextHash(original));
    assert.deepEqual({ prechecks: harness.counts.prechecks, db: harness.counts.db,
      models: harness.counts.models, cursor: harness.counts.cursor },
    { prechecks: 0, db: 0, models: 0, cursor: 0 });
    assert.equal(JSON.stringify(original), originalJSON, "original input stays untouched");
    if (verifyLegacyClaim) await runWithVerifiedProxyByteBudget(
      PROXY_BYTE_BUDGET_BOX_NATIVE_V1, () => verifyLegacyClaim(restored.body));
    return { bodyBytes: bytes, messages: messages.length, images: 91, registrations };
  } finally { harness.close(); }
}

