/**
 * Independent device CA for desktop virtual containers.
 * Isolated from 18443 host CA files (compute-pool/certAuthority.ts).
 *
 * Default dir: $OPENCLAUDE_DEVICE_CA_DIR or <OPENCLAUDE_CA_DIR>/device-ca
 * Files: ca.key (0600), ca.crt (0644). ECDSA P-256, openssl CLI, same as host CA.
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DESKTOP_SPIFFE_PREFIX } from "./flags.js";

export function deviceCaDir(): string {
  if (process.env.OPENCLAUDE_DEVICE_CA_DIR?.trim()) {
    return process.env.OPENCLAUDE_DEVICE_CA_DIR.trim();
  }
  const parent = process.env.OPENCLAUDE_CA_DIR ?? "/etc/openclaude";
  return path.join(parent, "device-ca");
}

export function desktopDeviceSpiffeUri(deviceId: string): string {
  return `${DESKTOP_SPIFFE_PREFIX}${deviceId.toLowerCase()}`;
}

export function extractDeviceIdFromSpiffe(uri: string): string | null {
  if (!uri.startsWith(DESKTOP_SPIFFE_PREFIX)) return null;
  const id = uri.slice(DESKTOP_SPIFFE_PREFIX.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  return id.toLowerCase();
}

export class DeviceCaError extends Error {
  constructor(
    readonly stage: "init" | "sign" | "verify" | "fs",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DeviceCaError";
  }
}

async function opensslRun(args: string[], stdin?: string, stage: DeviceCaError["stage"] = "sign"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("openssl", args, { stdio: ["pipe", "pipe", "pipe"] });
    const outBufs: Buffer[] = [];
    const errBufs: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new DeviceCaError(stage, `openssl ${args[0]} timeout`));
    }, 30_000);
    child.stdout.on("data", (c: Buffer) => outBufs.push(c));
    child.stderr.on("data", (c: Buffer) => errBufs.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new DeviceCaError(stage, `openssl spawn failed: ${err.message}`, { cause: err }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(errBufs).toString("utf8").trim();
        reject(new DeviceCaError(stage, `openssl ${args[0]} exit ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(Buffer.concat(outBufs).toString("utf8"));
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeMode(file: string, data: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data, { mode });
}

export async function certFingerprintSha256Bytes(certPem: string): Promise<Buffer> {
  const out = await opensslRun(["x509", "-noout", "-fingerprint", "-sha256"], certPem, "verify");
  const m = /Fingerprint=([0-9A-F:]+)/i.exec(out);
  if (!m) throw new DeviceCaError("verify", "cannot parse openssl fingerprint output");
  const hex = m[1]!.replace(/:/g, "").toLowerCase();
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) throw new DeviceCaError("verify", "fingerprint is not 32 bytes");
  return buf;
}

export function fingerprintFromDer(der: Buffer): Buffer {
  return createHash("sha256").update(der).digest();
}

export async function extractSpiffeUris(certPem: string): Promise<string[]> {
  const out = await opensslRun(["x509", "-noout", "-ext", "subjectAltName"], certPem, "verify");
  const uris: string[] = [];
  for (const m of out.matchAll(/URI:(\S+)/g)) {
    uris.push(m[1]!.replace(/,+$/, ""));
  }
  return uris;
}

export async function certValidity(certPem: string): Promise<{ notBefore: Date; notAfter: Date }> {
  const out = await opensslRun(["x509", "-noout", "-startdate", "-enddate"], certPem, "verify");
  const mb = /notBefore=(.+)/.exec(out);
  const ma = /notAfter=(.+)/.exec(out);
  if (!mb || !ma) throw new DeviceCaError("verify", "cannot parse cert dates");
  const nb = new Date(mb[1]!.trim());
  const na = new Date(ma[1]!.trim());
  if (Number.isNaN(nb.getTime()) || Number.isNaN(na.getTime())) {
    throw new DeviceCaError("verify", "cert dates unparseable");
  }
  return { notBefore: nb, notAfter: na };
}

export async function extractSerial(certPem: string): Promise<string> {
  const out = await opensslRun(["x509", "-noout", "-serial"], certPem, "verify");
  const m = /serial=([0-9A-F]+)/i.exec(out);
  if (!m) throw new DeviceCaError("verify", "cannot parse serial");
  return m[1]!.toLowerCase();
}

export interface DeviceCaMaterial {
  caCertPem: string;
  caKeyPath: string;
  caCertPath: string;
}

export async function ensureDeviceCa(): Promise<DeviceCaMaterial> {
  const dir = deviceCaDir();
  const keyPath = path.join(dir, "ca.key");
  const crtPath = path.join(dir, "ca.crt");
  if (!(await exists(keyPath)) || !(await exists(crtPath))) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const key = await opensslRun(
      ["ecparam", "-name", "prime256v1", "-genkey", "-noout"],
      undefined,
      "init",
    );
    await writeMode(keyPath, key, 0o600);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc-dca-"));
    try {
      const extPath = path.join(tmp, "ca.cnf");
      await fs.writeFile(
        extPath,
        [
          "[req]",
          "distinguished_name = dn",
          "x509_extensions = ext",
          "prompt = no",
          "[dn]",
          "CN = openclaude-device-ca",
          "[ext]",
          "basicConstraints = critical, CA:TRUE, pathlen:0",
          "keyUsage = critical, keyCertSign, cRLSign",
          "subjectKeyIdentifier = hash",
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
      await opensslRun(
        [
          "req", "-new", "-x509",
          "-key", keyPath,
          "-sha256",
          "-days", "3650",
          "-config", extPath,
          "-out", crtPath,
        ],
        undefined,
        "init",
      );
      await fs.chmod(crtPath, 0o644);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
  const caCertPem = await fs.readFile(crtPath, "utf8");
  return { caCertPem, caKeyPath: keyPath, caCertPath: crtPath };
}

export interface IssuedDeviceCert {
  deviceId: string;
  certPem: string;
  keyPem: string;
  tlsClientFp: Buffer;
  serial: string;
  certExpiresAt: Date;
  spiffeUri: string;
}

export async function issueDeviceCertificate(deviceId: string, days = 365): Promise<IssuedDeviceCert> {
  const id = deviceId.toLowerCase();
  const ca = await ensureDeviceCa();
  const spiffeUri = desktopDeviceSpiffeUri(id);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc-dleaf-"));
  try {
    const keyPath = path.join(tmp, "dev.key");
    const csrPath = path.join(tmp, "dev.csr");
    const crtPath = path.join(tmp, "dev.crt");
    const extPath = path.join(tmp, "ext.cnf");
    const keyPem = await opensslRun(
      ["ecparam", "-name", "prime256v1", "-genkey", "-noout"],
      undefined,
      "sign",
    );
    await fs.writeFile(keyPath, keyPem, { mode: 0o600 });
    await opensslRun(
      ["req", "-new", "-key", keyPath, "-subj", `/CN=${id}`, "-out", csrPath],
      undefined,
      "sign",
    );
    await fs.writeFile(
      extPath,
      [
        `subjectAltName = URI:${spiffeUri}`,
        "basicConstraints = critical, CA:FALSE",
        "keyUsage = critical, digitalSignature",
        "extendedKeyUsage = clientAuth",
      ].join("\n") + "\n",
      { mode: 0o600 },
    );
    const serialBuf = randomBytes(8);
    serialBuf[0]! &= 0x7f;
    await opensslRun([
      "x509", "-req",
      "-in", csrPath,
      "-CA", ca.caCertPath,
      "-CAkey", ca.caKeyPath,
      "-set_serial", `0x${serialBuf.toString("hex")}`,
      "-days", String(days),
      "-extfile", extPath,
      "-sha256",
      "-out", crtPath,
    ]);
    const certPem = await fs.readFile(crtPath, "utf8");
    const tlsClientFp = await certFingerprintSha256Bytes(certPem);
    const serial = await extractSerial(certPem);
    const { notAfter } = await certValidity(certPem);
    return {
      deviceId: id,
      certPem,
      keyPem,
      tlsClientFp,
      serial,
      certExpiresAt: notAfter,
      spiffeUri,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export interface DesktopOriginMaterial {
  certPem: string;
  keyPem: string;
  caCertPem: string;
}

/** Server leaf for 18445 (serverAuth). Isolated from 18443 host CA. */
export async function ensureDesktopOriginCert(): Promise<DesktopOriginMaterial> {
  const ca = await ensureDeviceCa();
  const dir = deviceCaDir();
  const keyPath = path.join(dir, "origin.key");
  const crtPath = path.join(dir, "origin.crt");
  if (!(await exists(keyPath)) || !(await exists(crtPath))) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc-dorigin-"));
    try {
      const keyPem = await opensslRun(["ecparam", "-name", "prime256v1", "-genkey", "-noout"], undefined, "sign");
      await writeMode(keyPath, keyPem, 0o600);
      const csrPath = path.join(tmp, "origin.csr");
      const extPath = path.join(tmp, "ext.cnf");
      await opensslRun(["req", "-new", "-key", keyPath, "-subj", "/CN=openclaude-desktop-origin", "-out", csrPath], undefined, "sign");
      await fs.writeFile(
        extPath,
        [
          "subjectAltName = DNS:localhost,IP:127.0.0.1",
          "basicConstraints = critical, CA:FALSE",
          "keyUsage = critical, digitalSignature",
          "extendedKeyUsage = serverAuth",
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
      await opensslRun([
        "x509", "-req", "-in", csrPath, "-CA", ca.caCertPath, "-CAkey", ca.caKeyPath,
        "-set_serial", `0x${randomBytes(8).toString("hex")}`,
        "-days", "365", "-extfile", extPath, "-sha256", "-out", crtPath,
      ]);
      await fs.chmod(crtPath, 0o644);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
  return {
    certPem: await fs.readFile(crtPath, "utf8"),
    keyPem: await fs.readFile(keyPath, "utf8"),
    caCertPem: ca.caCertPem,
  };
}
