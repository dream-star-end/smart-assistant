import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  ensureDeviceCa,
  extractDeviceIdFromSpiffe,
  extractSpiffeUris,
  issueDeviceCertificate,
} from "../desktop/deviceCa.js";

describe("device CA", () => {
  test("issues a device cert with isolated CA and SPIFFE SAN", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-unit-"));
    const prev = process.env.OPENCLAUDE_DEVICE_CA_DIR;
    process.env.OPENCLAUDE_DEVICE_CA_DIR = dir;
    try {
      await ensureDeviceCa();
      const id = randomUUID();
      const issued = await issueDeviceCertificate(id);
      assert.equal(issued.deviceId, id);
      assert.equal(issued.tlsClientFp.length, 32);
      assert.match(issued.certPem, /BEGIN CERTIFICATE/);
      assert.match(issued.keyPem, /BEGIN (EC )?PRIVATE KEY/);
      const uris = await extractSpiffeUris(issued.certPem);
      assert.ok(uris.some((u) => extractDeviceIdFromSpiffe(u) === id));
    } finally {
      if (prev === undefined) delete process.env.OPENCLAUDE_DEVICE_CA_DIR;
      else process.env.OPENCLAUDE_DEVICE_CA_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
