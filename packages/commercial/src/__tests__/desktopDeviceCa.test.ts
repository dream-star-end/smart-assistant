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
  DESKTOP_ORIGIN_SAN_LOCAL,
  assertOriginCertCoversHost,
  desktopOriginSanString,
  ensureDeviceCa,
  ensureDesktopOriginCert,
  extractDeviceIdFromSpiffe,
  extractSanEntries,
  extractSpiffeUris,
  issueDeviceCertificate,
  loadDesktopOriginMaterialIfPresent,
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

  test("origin SAN string is byte-locked without public host", () => {
    assert.equal(desktopOriginSanString(null), DESKTOP_ORIGIN_SAN_LOCAL);
    assert.equal(desktopOriginSanString(""), DESKTOP_ORIGIN_SAN_LOCAL);
    assert.equal(DESKTOP_ORIGIN_SAN_LOCAL, "DNS:localhost,IP:127.0.0.1");
    assert.equal(
      desktopOriginSanString("desktop.example.test"),
      "DNS:desktop.example.test,DNS:localhost,IP:127.0.0.1",
    );
    assert.equal(
      desktopOriginSanString("203.0.113.9"),
      "IP:203.0.113.9,DNS:localhost,IP:127.0.0.1",
    );
  });

  test("no public host → origin cert SAN matches historical localhost/127.0.0.1", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-san-local-"));
    const prevDir = process.env.OPENCLAUDE_DEVICE_CA_DIR;
    const prevHost = process.env.OC_DESKTOP_PUBLIC_HOST;
    process.env.OPENCLAUDE_DEVICE_CA_DIR = dir;
    delete process.env.OC_DESKTOP_PUBLIC_HOST;
    try {
      const origin = await ensureDesktopOriginCert();
      const san = await extractSanEntries(origin.certPem);
      assert.deepEqual(san.dns.map((d) => d.toLowerCase()).sort(), ["localhost"]);
      assert.ok(san.ip.includes("127.0.0.1"));
      assert.equal(san.dns.length, 1);
      assert.equal(san.ip.length, 1);
    } finally {
      if (prevDir === undefined) delete process.env.OPENCLAUDE_DEVICE_CA_DIR;
      else process.env.OPENCLAUDE_DEVICE_CA_DIR = prevDir;
      if (prevHost === undefined) delete process.env.OC_DESKTOP_PUBLIC_HOST;
      else process.env.OC_DESKTOP_PUBLIC_HOST = prevHost;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("public host → origin cert SAN includes host plus localhost", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-san-host-"));
    const prevDir = process.env.OPENCLAUDE_DEVICE_CA_DIR;
    const prevHost = process.env.OC_DESKTOP_PUBLIC_HOST;
    process.env.OPENCLAUDE_DEVICE_CA_DIR = dir;
    process.env.OC_DESKTOP_PUBLIC_HOST = "desktop.example.test";
    try {
      const origin = await ensureDesktopOriginCert();
      const san = await extractSanEntries(origin.certPem);
      assert.ok(san.dns.some((d) => d.toLowerCase() === "desktop.example.test"));
      assert.ok(san.dns.some((d) => d.toLowerCase() === "localhost"));
      assert.ok(san.ip.includes("127.0.0.1"));
      assert.equal(await assertOriginCertCoversHost(origin.certPem, "desktop.example.test"), true);
    } finally {
      if (prevDir === undefined) delete process.env.OPENCLAUDE_DEVICE_CA_DIR;
      else process.env.OPENCLAUDE_DEVICE_CA_DIR = prevDir;
      if (prevHost === undefined) delete process.env.OC_DESKTOP_PUBLIC_HOST;
      else process.env.OC_DESKTOP_PUBLIC_HOST = prevHost;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("existing origin.crt is not reissued when public host is added later", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-san-noreissue-"));
    const prevDir = process.env.OPENCLAUDE_DEVICE_CA_DIR;
    const prevHost = process.env.OC_DESKTOP_PUBLIC_HOST;
    process.env.OPENCLAUDE_DEVICE_CA_DIR = dir;
    delete process.env.OC_DESKTOP_PUBLIC_HOST;
    try {
      const first = await ensureDesktopOriginCert();
      process.env.OC_DESKTOP_PUBLIC_HOST = "desktop.example.test";
      const second = await ensureDesktopOriginCert();
      assert.equal(first.certPem, second.certPem);
      const san = await extractSanEntries(second.certPem);
      assert.equal(san.dns.some((d) => d.toLowerCase() === "desktop.example.test"), false);
      assert.equal(await assertOriginCertCoversHost(second.certPem, "desktop.example.test"), false);
      assert.equal(await loadDesktopOriginMaterialIfPresent() !== null, true);
    } finally {
      if (prevDir === undefined) delete process.env.OPENCLAUDE_DEVICE_CA_DIR;
      else process.env.OPENCLAUDE_DEVICE_CA_DIR = prevDir;
      if (prevHost === undefined) delete process.env.OC_DESKTOP_PUBLIC_HOST;
      else process.env.OC_DESKTOP_PUBLIC_HOST = prevHost;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
