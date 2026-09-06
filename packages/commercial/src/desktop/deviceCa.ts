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
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DESKTOP_SPIFFE_PREFIX } from "./flags.js";
import { readDesktopPublicHost } from "./publicHost.js";
import { rootLogger } from "../logging/logger.js";

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

/** Frozen local SAN used when OC_DESKTOP_PUBLIC_HOST is unset. Byte-lock vs historical origin.crt. */
export const DESKTOP_ORIGIN_SAN_LOCAL = "DNS:localhost,IP:127.0.0.1";

export function desktopOriginSanString(publicHost?: string | null): string {
  const host = typeof publicHost === "string" ? publicHost.trim() : "";
  if (!host) return DESKTOP_ORIGIN_SAN_LOCAL;
  if (net.isIP(host)) return `IP:${host},${DESKTOP_ORIGIN_SAN_LOCAL}`;
  if (/[\s,/=]/.test(host)) return DESKTOP_ORIGIN_SAN_LOCAL;
  return `DNS:${host},${DESKTOP_ORIGIN_SAN_LOCAL}`;
}

export async function extractSanEntries(certPem: string): Promise<{ dns: string[]; ip: string[]; uri: string[] }> {
  const out = await opensslRun(["x509", "-noout", "-ext", "subjectAltName"], certPem, "verify");
  const dns: string[] = [];
  const ip: string[] = [];
  const uri: string[] = [];
  for (const m of out.matchAll(/DNS:([^,\s]+)/gi)) {
    dns.push(m[1]!.replace(/,+$/, ""));
  }
  for (const m of out.matchAll(/IP Address:([^,\s]+)/gi)) {
    ip.push(m[1]!.replace(/,+$/, ""));
  }
  for (const m of out.matchAll(/URI:(\S+)/g)) {
    uri.push(m[1]!.replace(/,+$/, ""));
  }
  return { dns, ip, uri };
}

export async function originCertCoversHost(certPem: string, host: string): Promise<boolean> {
  const h = host.trim();
  if (!h) return true;
  const { dns, ip } = await extractSanEntries(certPem);
  if (net.isIP(h)) {
    return ip.some((x) => x.toLowerCase() === h.toLowerCase());
  }
  return dns.some((x) => x.toLowerCase() === h.toLowerCase());
}

/** Warn (do not delete/reissue) when existing origin.crt SAN lacks OC_DESKTOP_PUBLIC_HOST. */
export async function assertOriginCertCoversHost(certPem: string, host: string | null): Promise<boolean> {
  if (!host) return true;
  const ok = await originCertCoversHost(certPem, host);
  if (!ok) {
    rootLogger.warn("desktop_origin_san_mismatch", {
      host,
      hint: "delete origin.crt and origin.key under OPENCLAUDE_DEVICE_CA_DIR to reissue with OC_DESKTOP_PUBLIC_HOST in SAN",
    });
  }
  return ok;
}

/** SPKI pin: openssl x509 -pubkey → DER → sha256 → base64. */
export async function originSpkiPinBase64(certPem: string): Promise<string> {
  const pubPem = await opensslRun(["x509", "-noout", "-pubkey"], certPem, "verify");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc-spki-"));
  try {
    const pubFile = path.join(tmp, "pub.pem");
    const derFile = path.join(tmp, "pub.der");
    await fs.writeFile(pubFile, pubPem, { mode: 0o600 });
    await opensslRun(["pkey", "-pubin", "-in", pubFile, "-outform", "DER", "-out", derFile], undefined, "verify");
    const der = await fs.readFile(derFile);
    if (der.length < 16) throw new DeviceCaError("verify", "SPKI DER too short");
    return createHash("sha256").update(der).digest("base64");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let localLockDepth = 0;

async function withDeviceCaLock<T>(fn: () => Promise<T>): Promise<T> {
  if (localLockDepth > 0) return fn();
  const dir = deviceCaDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, ".init.lock");
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const fh = await fs.open(lockPath, "wx", 0o600);
      try {
        await fh.writeFile(String(process.pid));
        localLockDepth += 1;
        try {
          return await fn();
        } finally {
          localLockDepth -= 1;
        }
      } finally {
        await fh.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        throw new DeviceCaError("init", "timeout waiting for device CA init lock");
      }
      try {
        const raw = (await fs.readFile(lockPath, "utf8")).trim();
        const pid = Number(raw);
        if (Number.isInteger(pid) && pid > 0 && !(await pidAlive(pid))) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // lock disappeared or unreadable; retry create
      }
      await sleep(50);
    }
  }
}

function normalizePem(pem: string): string {
  return pem.replace(/\r/g, "").trim();
}

async function assertKeyMatchesCert(keyPem: string, certPem: string, stage: DeviceCaError["stage"]): Promise<void> {
  const pubFromCert = normalizePem(await opensslRun(["x509", "-noout", "-pubkey"], certPem, stage));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc-dca-pair-"));
  try {
    const keyFile = path.join(tmp, "k.pem");
    await fs.writeFile(keyFile, keyPem, { mode: 0o600 });
    const pubFromKey = normalizePem(await opensslRun(["pkey", "-pubout", "-in", keyFile], undefined, stage));
    if (pubFromCert !== pubFromKey) {
      throw new DeviceCaError(stage, "device CA key/cert public key mismatch");
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function assertCertIssuedByCa(certPem: string, caCertPem: string, stage: DeviceCaError["stage"]): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc-dca-ver-"));
  try {
    const caFile = path.join(tmp, "ca.crt");
    const leafFile = path.join(tmp, "leaf.crt");
    await fs.writeFile(caFile, caCertPem, { mode: 0o644 });
    await fs.writeFile(leafFile, certPem, { mode: 0o644 });
    await opensslRun(["verify", "-CAfile", caFile, leafFile], undefined, stage);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function atomicPublish(finalPath: string, contents: string, mode: number): Promise<void> {
  const tmpPath = `${finalPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  await fs.writeFile(tmpPath, contents, { mode });
  await fs.rename(tmpPath, finalPath);
}

async function loadOrRejectHalfSet(keyPath: string, crtPath: string, stage: DeviceCaError["stage"]): Promise<{ key: string; cert: string } | "missing"> {
  const keyOk = await exists(keyPath);
  const crtOk = await exists(crtPath);
  if (!keyOk && !crtOk) return "missing";
  if (keyOk !== crtOk) {
    throw new DeviceCaError(stage, `device CA half-set at ${keyOk ? keyPath : crtPath} (refusing to overwrite)`);
  }
  const key = await fs.readFile(keyPath, "utf8");
  const cert = await fs.readFile(crtPath, "utf8");
  await assertKeyMatchesCert(key, cert, stage);
  return { key, cert };
}

export async function ensureDeviceCa(): Promise<DeviceCaMaterial> {
  return withDeviceCaLock(async () => {
    const dir = deviceCaDir();
    const keyPath = path.join(dir, "ca.key");
    const crtPath = path.join(dir, "ca.crt");
    const existing = await loadOrRejectHalfSet(keyPath, crtPath, "init");
    if (existing !== "missing") {
      return { caCertPem: existing.cert, caKeyPath: keyPath, caCertPath: crtPath };
    }
    const key = await opensslRun(
      ["ecparam", "-name", "prime256v1", "-genkey", "-noout"],
      undefined,
      "init",
    );
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc-dca-"));
    try {
      const extPath = path.join(tmp, "ca.cnf");
      const tmpCrt = path.join(tmp, "ca.crt");
      const tmpKey = path.join(tmp, "ca.key");
      await fs.writeFile(tmpKey, key, { mode: 0o600 });
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
          "-key", tmpKey,
          "-sha256",
          "-days", "3650",
          "-config", extPath,
          "-out", tmpCrt,
        ],
        undefined,
        "init",
      );
      const certPem = await fs.readFile(tmpCrt, "utf8");
      await assertKeyMatchesCert(key, certPem, "init");
      await atomicPublish(keyPath, key, 0o600);
      await atomicPublish(crtPath, certPem, 0o644);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
    const caCertPem = await fs.readFile(crtPath, "utf8");
    return { caCertPem, caKeyPath: keyPath, caCertPath: crtPath };
  });
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

/**
 * Read origin material if already on disk. Never mkdir, never issue, never lock.
 * Anonymous bootstrap must not create a CA.
 */
export async function loadDesktopOriginMaterialIfPresent(): Promise<DesktopOriginMaterial | null> {
  const dir = deviceCaDir();
  const caCrt = path.join(dir, "ca.crt");
  const originKey = path.join(dir, "origin.key");
  const originCrt = path.join(dir, "origin.crt");
  if (!(await exists(dir))) return null;
  if (!(await exists(caCrt)) || !(await exists(originKey)) || !(await exists(originCrt))) return null;
  try {
    const caCertPem = await fs.readFile(caCrt, "utf8");
    const certPem = await fs.readFile(originCrt, "utf8");
    const keyPem = await fs.readFile(originKey, "utf8");
    if (!caCertPem.trim() || !certPem.trim() || !keyPem.trim()) return null;
    await assertKeyMatchesCert(keyPem, certPem, "verify");
    await assertCertIssuedByCa(certPem, caCertPem, "verify");
    return { certPem, keyPem, caCertPem };
  } catch {
    return null;
  }
}

/** Server leaf for 18445 (serverAuth). Isolated from 18443 host CA. */
export async function ensureDesktopOriginCert(): Promise<DesktopOriginMaterial> {
  return withDeviceCaLock(async () => {
    const ca = await ensureDeviceCa();
    const dir = deviceCaDir();
    const keyPath = path.join(dir, "origin.key");
    const crtPath = path.join(dir, "origin.crt");
    const existing = await loadOrRejectHalfSet(keyPath, crtPath, "sign");
    if (existing !== "missing") {
      await assertCertIssuedByCa(existing.cert, ca.caCertPem, "verify");
      return { certPem: existing.cert, keyPem: existing.key, caCertPem: ca.caCertPem };
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc-dorigin-"));
    try {
      const keyPem = await opensslRun(["ecparam", "-name", "prime256v1", "-genkey", "-noout"], undefined, "sign");
      const tmpKey = path.join(tmp, "origin.key");
      const csrPath = path.join(tmp, "origin.csr");
      const extPath = path.join(tmp, "ext.cnf");
      const tmpCrt = path.join(tmp, "origin.crt");
      await fs.writeFile(tmpKey, keyPem, { mode: 0o600 });
      await opensslRun(["req", "-new", "-key", tmpKey, "-subj", "/CN=openclaude-desktop-origin", "-out", csrPath], undefined, "sign");
      await fs.writeFile(
        extPath,
        [
          `subjectAltName = ${desktopOriginSanString(readDesktopPublicHost())}`,
          "basicConstraints = critical, CA:FALSE",
          "keyUsage = critical, digitalSignature",
          "extendedKeyUsage = serverAuth",
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
      await opensslRun([
        "x509", "-req", "-in", csrPath, "-CA", ca.caCertPath, "-CAkey", ca.caKeyPath,
        "-set_serial", `0x${randomBytes(8).toString("hex")}`,
        "-days", "365", "-extfile", extPath, "-sha256", "-out", tmpCrt,
      ]);
      const certPem = await fs.readFile(tmpCrt, "utf8");
      await assertKeyMatchesCert(keyPem, certPem, "sign");
      await assertCertIssuedByCa(certPem, ca.caCertPem, "verify");
      await atomicPublish(keyPath, keyPem, 0o600);
      await atomicPublish(crtPath, certPem, 0o644);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
    return {
      certPem: await fs.readFile(crtPath, "utf8"),
      keyPem: await fs.readFile(keyPath, "utf8"),
      caCertPem: ca.caCertPem,
    };
  });
}
