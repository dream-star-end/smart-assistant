/**
 * Compute-pool mTLS CA.
 *
 * 职责:
 *   1. 自举 master CA(ECDSA P-256,self-signed,10y,存 /etc/openclaude/ca.{key,crt},0600/0644)
 *   2. 自举 master leaf cert(SAN URI spiffe://openclaude/master,90d,1d 续期窗口)
 *      — master 向 node-agent 建 mTLS 客户端连接时出示这张
 *   3. signHostLeafCsr(hostUuid, csrPem): 接 worker 本地生成的 CSR,签 90d leaf,
 *      SAN URI = spiffe://openclaude/host/<uuid>,返 {certPem, fingerprintSha256, notBefore, notAfter}
 *   4. verifyPeerLeaf(certPem): 验叶子证书 (a) 链到本地 CA (b) SAN URI 解出的 subject
 *      (host 或 master) (c) fingerprint 校验由调用方对照库完成
 *
 * 为什么 exec openssl 而不是 node-forge / @peculiar/x509:
 *   - 无新 npm 依赖(生产机必有 openssl,bootstrap 也靠它)
 *   - 签发路径每 host 每 90d 一次,低频,~20ms/次可接受
 *   - 私钥全程用临时文件传递(mode 0600,完工即 unlink)— 命令行参数不泄露 key
 *
 * 不做的:
 *   - OCSP/CRL 文件(M1:cert 撤销通过更新 compute_hosts.agent_cert_fingerprint_sha256 + 内存 cache 生效)
 *   - intermediate CA(直签 leaf;两人团队不需要多层)
 *   - key rotation(CA key 10y 不动;泄露走灾难流程重建)
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { isIP } from "node:net";

// ─── 配置 ───────────────────────────────────────────────────────────────

/** CA 文件目录。生产 = /etc/openclaude;测试可以 env 覆盖到 tmp。 */
export function caDir(): string {
  return process.env.OPENCLAUDE_CA_DIR ?? "/etc/openclaude";
}

/** Leaf cert 有效期(天)。renew 在剩余 < 30d 时触发。 */
export function leafDays(): number {
  const raw = process.env.OPENCLAUDE_LEAF_DAYS ?? "90";
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 7 || n > 365) return 90;
  return n;
}

const CA_KEY_FILE = "ca.key";
const CA_CRT_FILE = "ca.crt";
const MASTER_KEY_FILE = "master.key";
const MASTER_CRT_FILE = "master.crt";

const SPIFFE_NS = "spiffe://openclaude";
export const MASTER_SPIFFE_URI = `${SPIFFE_NS}/master`;
export function hostSpiffeUri(hostUuid: string): string {
  return `${SPIFFE_NS}/host/${hostUuid}`;
}

/** 从 SAN URI 解出 host uuid;master 或格式不符返 null。 */
export function extractHostUuidFromSpiffe(uri: string): string | null {
  const prefix = `${SPIFFE_NS}/host/`;
  if (!uri.startsWith(prefix)) return null;
  const id = uri.slice(prefix.length);
  // UUID v4 宽松匹配(8-4-4-4-12,hex)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  return id.toLowerCase();
}

// ─── 错误类型 ───────────────────────────────────────────────────────────

export class CaError extends Error {
  constructor(
    readonly stage: "init" | "sign" | "verify" | "fs",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CaError";
  }
}

// ─── openssl 包装 ───────────────────────────────────────────────────────

type OpensslStage = "init" | "sign" | "verify";

async function opensslRun(
  args: string[],
  stdin?: string,
  stage: OpensslStage = "sign",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("openssl", args, { stdio: ["pipe", "pipe", "pipe"] });
    const outBufs: Buffer[] = [];
    const errBufs: Buffer[] = [];
    let outBytes = 0;
    const MAX = 4 * 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CaError(stage, `openssl ${args[0]} timeout`));
    }, 30_000);

    child.stdout.on("data", (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > MAX) {
        child.kill("SIGKILL");
        return;
      }
      outBufs.push(c);
    });
    child.stderr.on("data", (c: Buffer) => errBufs.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new CaError(stage, `openssl spawn failed: ${err.message}`, { cause: err }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(errBufs).toString("utf8").trim();
        reject(new CaError(
          stage,
          `openssl ${args[0]} exit ${code}: ${stderr.slice(0, 500)}`,
        ));
        return;
      }
      resolve(Buffer.concat(outBufs).toString("utf8"));
    });

    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * 生成 ECDSA P-256 keypair。返 PEM 字符串。
 * 写文件以便 openssl 后续 CLI 读取;调用方用完需 unlink。
 */
async function genEcdsaKeyPem(): Promise<string> {
  return opensslRun(["ecparam", "-name", "prime256v1", "-genkey", "-noout"], undefined, "init");
}

async function writeMode(file: string, data: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data, { mode });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 计算 cert (DER) 的 sha256 指纹,lowercase hex。 */
export async function certFingerprintSha256(certPem: string): Promise<string> {
  // openssl x509 -noout -fingerprint -sha256 → "sha256 Fingerprint=AA:BB:..."
  const out = await opensslRun(
    ["x509", "-noout", "-fingerprint", "-sha256"],
    certPem,
    "verify",
  );
  const m = /Fingerprint=([0-9A-F:]+)/i.exec(out);
  if (!m) throw new CaError("verify", "cannot parse openssl fingerprint output");
  return m[1]!.replace(/:/g, "").toLowerCase();
}

/** Parse cert notBefore/notAfter → Date */
export async function certValidity(certPem: string): Promise<{ notBefore: Date; notAfter: Date }> {
  // openssl x509 -noout -startdate -enddate
  const out = await opensslRun(
    ["x509", "-noout", "-startdate", "-enddate"],
    certPem,
    "verify",
  );
  const mb = /notBefore=(.+)/.exec(out);
  const ma = /notAfter=(.+)/.exec(out);
  if (!mb || !ma) throw new CaError("verify", "cannot parse cert dates");
  const nb = new Date(mb[1]!.trim());
  const na = new Date(ma[1]!.trim());
  if (Number.isNaN(nb.getTime()) || Number.isNaN(na.getTime())) {
    throw new CaError("verify", "cert dates unparseable");
  }
  return { notBefore: nb, notAfter: na };
}

/** Extract SAN URIs from cert. 本 MVP 我们只放一个,返数组以防多个。 */
export async function extractSpiffeUris(certPem: string): Promise<string[]> {
  // openssl x509 -noout -ext subjectAltName
  //   prints: "X509v3 Subject Alternative Name: \n    URI:spiffe://.../host/<uuid>"
  const out = await opensslRun(
    ["x509", "-noout", "-ext", "subjectAltName"],
    certPem,
    "verify",
  );
  const uris: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    // 同一行可能是 "URI:foo, URI:bar"(openssl 用 ",\s*" 分隔 SAN 项)
    for (const part of line.split(/,\s*/)) {
      const m = /URI:(\S+)/.exec(part.trim());
      if (m) uris.push(m[1]!);
    }
  }
  return uris;
}

// ─── CA 自举 ────────────────────────────────────────────────────────────

export interface CaMaterial {
  caCertPem: string;
  /** 路径(不是内容),供 openssl 命令行传参。master key 不出内存就不可能。 */
  caKeyPath: string;
  caCertPath: string;
}

/**
 * 确保 CA 文件存在;没有就生成。幂等(多进程并发时,后来者看到已生成就复用)。
 * 返 CA material(key 内容 *不* 返,避免在 JS 堆里扩散)。
 */
export async function ensureCa(): Promise<CaMaterial> {
  const dir = caDir();
  const keyPath = path.join(dir, CA_KEY_FILE);
  const crtPath = path.join(dir, CA_CRT_FILE);

  if (!(await exists(keyPath)) || !(await exists(crtPath))) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // 生成 CA key
    const caKey = await genEcdsaKeyPem();
    await writeMode(keyPath, caKey, 0o600);
    // 生成 self-signed CA cert(10y)
    // subj: /CN=openclaude-compute-pool-ca
    const caCrt = await opensslRun(
      [
        "req", "-new", "-x509", "-nodes",
        "-key", keyPath,
        "-days", "3650",
        "-subj", "/CN=openclaude-compute-pool-ca",
        "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      ],
      undefined,
      "init",
    );
    await writeMode(crtPath, caCrt, 0o644);
  }

  const caCertPem = await fs.readFile(crtPath, "utf8");
  return { caCertPem, caKeyPath: keyPath, caCertPath: crtPath };
}

/**
 * 确保 master leaf(master.{key,crt})存在或已过 renew 阈值。
 * 返 master cert material 供 nodeAgentClient TLS client 用。
 */
export interface MasterLeafMaterial {
  certPem: string;
  keyPath: string;
  certPath: string;
  fingerprintSha256: string;
  notAfter: Date;
}

export async function ensureMasterLeaf(): Promise<MasterLeafMaterial> {
  const ca = await ensureCa();
  const dir = caDir();
  const keyPath = path.join(dir, MASTER_KEY_FILE);
  const crtPath = path.join(dir, MASTER_CRT_FILE);

  let needGen = false;
  if (!(await exists(keyPath)) || !(await exists(crtPath))) {
    needGen = true;
  } else {
    const cur = await fs.readFile(crtPath, "utf8");
    const { notAfter } = await certValidity(cur);
    const msLeft = notAfter.getTime() - Date.now();
    if (msLeft < 30 * 24 * 3600 * 1000) needGen = true; // 30d 续期窗口
  }

  if (needGen) {
    const masterKey = await genEcdsaKeyPem();
    await writeMode(keyPath, masterKey, 0o600);
    // 读 env OPENCLAUDE_MASTER_CERT_IP_SANS(逗号分隔 IP 列表),去重 + isIP 校验。
    // 未设 / 全部非法 → ipSans 为空 → 退化到纯 URI SAN(历史行为)。
    // 注:renew 触发仅看 notAfter < 30d,env 变更不自动触发重签;运维需手动删
    // master.{key,crt} + 重启 commercial 才能吸收新 IP SAN(一次性动作)。
    const ipRaw = process.env.OPENCLAUDE_MASTER_CERT_IP_SANS ?? "";
    const seen = new Set<string>();
    const ipSans: string[] = [];
    for (const part of ipRaw.split(",")) {
      const s = part.trim();
      if (!s) continue;
      if (isIP(s) === 0) {
        // eslint-disable-next-line no-console
        console.warn(
          "[certAuthority] ignoring non-IP value in OPENCLAUDE_MASTER_CERT_IP_SANS:",
          s,
        );
        continue;
      }
      if (seen.has(s)) continue;
      seen.add(s);
      ipSans.push(s);
    }
    if (ipRaw.trim().length > 0 && ipSans.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        "[certAuthority] OPENCLAUDE_MASTER_CERT_IP_SANS had entries but none valid; cert will have only URI SAN",
      );
    }
    const cert = await signLeafFromCaKey({
      ca,
      subjectKeyPath: keyPath,
      isHostCsr: false,
      csrPem: undefined,
      spiffeUri: MASTER_SPIFFE_URI,
      cn: "openclaude-master",
      days: leafDays(),
      ipSans,
    });
    await writeMode(crtPath, cert, 0o644);
  }

  const certPem = await fs.readFile(crtPath, "utf8");
  const fp = await certFingerprintSha256(certPem);
  const { notAfter } = await certValidity(certPem);
  return {
    certPem,
    keyPath,
    certPath: crtPath,
    fingerprintSha256: fp,
    notAfter,
  };
}

// ─── 签 leaf cert ───────────────────────────────────────────────────────

interface SignLeafArgs {
  ca: CaMaterial;
  /** 给 master 用:subjectKeyPath(我们自己生成私钥)。给 host 用:csrPem(worker 给的)。 */
  subjectKeyPath?: string;
  csrPem?: string;
  isHostCsr: boolean;
  spiffeUri: string;
  cn: string;
  days: number;
  /**
   * 可选 IP SAN 列表。master leaf 用 —— 远端 node-agent(Go 标准 TLS)走 IP 直连
   * master baseline server 需要 IP 匹配。host leaf 不用(SAN URI + fingerprint pin 已够)。
   * 每个元素应是合法 IPv4/IPv6;调用方负责校验。
   */
  ipSans?: readonly string[];
}

async function signLeafFromCaKey(args: SignLeafArgs): Promise<string> {
  // 写 ext conf 文件:SAN URI + keyUsage + extendedKeyUsage
  // serverAuth + clientAuth(双角色:既可作 node-agent 入站 server cert,
  // 也可作 proxy-agent 出站 client cert)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc-leaf-"));
  try {
    const extPath = path.join(tmp, "ext.cnf");
    // subjectAltName 支持内联多值列表:`URI:..., IP:..., IP:...`。openssl -extfile 可解析。
    const sanParts = [`URI:${args.spiffeUri}`];
    if (args.ipSans && args.ipSans.length > 0) {
      for (const ip of args.ipSans) sanParts.push(`IP:${ip}`);
    }
    const extBody = [
      `subjectAltName = ${sanParts.join(", ")}`,
      `basicConstraints = critical, CA:FALSE`,
      `keyUsage = critical, digitalSignature, keyEncipherment`,
      `extendedKeyUsage = serverAuth, clientAuth`,
    ].join("\n") + "\n";
    await fs.writeFile(extPath, extBody, { mode: 0o600 });

    if (args.isHostCsr) {
      if (!args.csrPem) throw new CaError("sign", "csrPem required for host leaf");
      const csrPath = path.join(tmp, "csr.pem");
      const outPath = path.join(tmp, "cert.pem");
      // openssl -set_serial 对 ASN.1 INTEGER 的正负性要求严格:
    // 高位 bit = 1 会被解释成负数导致签发失败。clear top bit 保证永远是正整数。
    const serialBuf = randomBytes(8);
    serialBuf[0]! &= 0x7f;
    const serialHex = serialBuf.toString("hex");
      await fs.writeFile(csrPath, args.csrPem, { mode: 0o600 });
      await opensslRun([
        "x509", "-req",
        "-in", csrPath,
        "-CA", args.ca.caCertPath,
        "-CAkey", args.ca.caKeyPath,
        "-set_serial", `0x${serialHex}`,
        "-days", String(args.days),
        "-extfile", extPath,
        "-sha256",
        "-out", outPath,
      ]);
      return await fs.readFile(outPath, "utf8");
    }

    // master leaf: 用 subjectKeyPath 自己造 CSR 再签
    if (!args.subjectKeyPath) throw new CaError("sign", "subjectKeyPath required for self leaf");
    const csrPath = path.join(tmp, "master.csr");
    const outPath = path.join(tmp, "master.crt");
    await opensslRun([
      "req", "-new", "-nodes",
      "-key", args.subjectKeyPath,
      "-subj", `/CN=${args.cn}`,
      "-out", csrPath,
    ]);
    // openssl -set_serial 对 ASN.1 INTEGER 的正负性要求严格:
    // 高位 bit = 1 会被解释成负数导致签发失败。clear top bit 保证永远是正整数。
    const serialBuf = randomBytes(8);
    serialBuf[0]! &= 0x7f;
    const serialHex = serialBuf.toString("hex");
    await opensslRun([
      "x509", "-req",
      "-in", csrPath,
      "-CA", args.ca.caCertPath,
      "-CAkey", args.ca.caKeyPath,
      "-set_serial", `0x${serialHex}`,
      "-days", String(args.days),
      "-extfile", extPath,
      "-sha256",
      "-out", outPath,
    ]);
    return await fs.readFile(outPath, "utf8");
  } finally {
    // 清临时文件(best-effort)
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 为某 host 的 CSR 签 leaf。
 *
 * worker 本地 `openssl req -new -newkey ec:... -keyout ... -out ...` 生成 CSR,
 * scp 到 master,master 调这个函数签,再 scp cert 回去。
 */
export interface SignHostLeafResult {
  certPem: string;
  fingerprintSha256: string;
  notBefore: Date;
  notAfter: Date;
}

export async function signHostLeafCsr(
  hostUuid: string,
  csrPem: string,
): Promise<SignHostLeafResult> {
  const ca = await ensureCa();
  const cert = await signLeafFromCaKey({
    ca,
    csrPem,
    isHostCsr: true,
    spiffeUri: hostSpiffeUri(hostUuid),
    cn: `host-${hostUuid}`,
    days: leafDays(),
  });
  const fp = await certFingerprintSha256(cert);
  const { notBefore, notAfter } = await certValidity(cert);
  return { certPem: cert, fingerprintSha256: fp, notBefore, notAfter };
}

// ─── 对端 cert 校验(识别 host_uuid) ──────────────────────────────────

export interface VerifiedPeer {
  /** 从 SAN URI 解出的 host uuid;master 对端则为 null。 */
  hostUuid: string | null;
  isMaster: boolean;
  fingerprintSha256: string;
  notAfter: Date;
}

/**
 * 把对端出示的 leaf(PEM)做完整验证:
 *   1. openssl verify 链到本地 CA
 *   2. 解 SAN URI,必须是 spiffe://openclaude/{master | host/<uuid>}
 *   3. 校验 notBefore ≤ now ≤ notAfter
 *   4. 算 sha256 指纹(caller 之后对照 compute_hosts.agent_cert_fingerprint_sha256)
 *
 * **不在这里查 DB**(避免 cert 验证被动触发 DB I/O);fingerprint 比对由调用方做。
 */
export async function verifyPeerLeaf(certPem: string): Promise<VerifiedPeer> {
  const ca = await ensureCa();
  // 1. chain 验证
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oc-verify-"));
  try {
    const certPath = path.join(tmp, "peer.crt");
    await fs.writeFile(certPath, certPem, { mode: 0o600 });
    try {
      await opensslRun(
        ["verify", "-CAfile", ca.caCertPath, certPath],
        undefined,
        "verify",
      );
    } catch (e) {
      throw new CaError("verify", "peer cert chain verification failed", { cause: e as Error });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  // 2. SAN URI
  const uris = await extractSpiffeUris(certPem);
  if (uris.length === 0) {
    throw new CaError("verify", "peer cert has no SAN URI");
  }
  const spiffe = uris.find((u) => u.startsWith(SPIFFE_NS + "/"));
  if (!spiffe) {
    throw new CaError("verify", `peer cert SAN URI not in namespace: ${uris.join(",")}`);
  }
  let hostUuid: string | null = null;
  let isMaster = false;
  if (spiffe === MASTER_SPIFFE_URI) {
    isMaster = true;
  } else {
    hostUuid = extractHostUuidFromSpiffe(spiffe);
    if (!hostUuid) {
      throw new CaError("verify", `peer cert SAN URI malformed: ${spiffe}`);
    }
  }

  // 3. 有效期
  const { notBefore, notAfter } = await certValidity(certPem);
  const now = Date.now();
  if (now < notBefore.getTime() || now > notAfter.getTime()) {
    throw new CaError(
      "verify",
      `peer cert outside validity window: ${notBefore.toISOString()} .. ${notAfter.toISOString()}`,
    );
  }

  // 4. 指纹
  const fp = await certFingerprintSha256(certPem);

  return { hostUuid, isMaster, fingerprintSha256: fp, notAfter };
}

/** 便捷:DER 的 sha256(不经 openssl,对已经 parse 过的 cert buffer)。 */
export function sha256DerHex(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}
