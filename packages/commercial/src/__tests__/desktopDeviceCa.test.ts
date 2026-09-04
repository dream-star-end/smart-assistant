import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  DeviceCaError,
  ensureDeviceCa,
  ensureDesktopOriginCert,
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

  test("mismatched pre-existing key/cert fails closed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-bad-"));
    const prev = process.env.OPENCLAUDE_DEVICE_CA_DIR;
    process.env.OPENCLAUDE_DEVICE_CA_DIR = dir;
    try {
      await writeFile(path.join(dir, "ca.key"), "not-a-key", { mode: 0o600 });
      await writeFile(path.join(dir, "ca.crt"), "not-a-cert", { mode: 0o644 });
      await assert.rejects(
        () => ensureDeviceCa(),
        (e: unknown) => e instanceof DeviceCaError,
      );
    } finally {
      if (prev === undefined) delete process.env.OPENCLAUDE_DEVICE_CA_DIR;
      else process.env.OPENCLAUDE_DEVICE_CA_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two child processes initialize one matching CA", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-race-"));
    const worker = fileURLToPath(new URL("./desktopDeviceCaConcurrent.worker.ts", import.meta.url));
    const run = () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", worker], {
        env: { ...process.env, OPENCLAUDE_DEVICE_CA_DIR: dir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => { out += String(c); });
      child.stderr.on("data", (c) => { err += String(c); });
      child.on("close", (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`worker exit ${code}: ${err || out}`));
      });
    });
    try {
      const [a, b] = await Promise.all([run(), run()]);
      assert.equal(a.length, 64);
      assert.equal(a, b);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
