/** Lossless transport cache. A reference contains data, never execution authority.
 * Every hydrated request still goes through the original Box v1 owner checks. */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, link, unlink, readdir, type FileHandle } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  extractSessionId, enforceTotalBodyBudget, proxyBodySchema,
  type ProxyBody, type ProxyByteBudget, PROXY_BYTE_BUDGET_BOX_NATIVE_V1, MAX_MESSAGES_COUNT,
} from "./shared.js";
import { jsonIdentityStamp, proxyBodyUtf8Bytes, stampsEqual, type JsonStamp } from "./boxPureMemo.js";

const MAX_BYTES = PROXY_BYTE_BUDGET_BOX_NATIVE_V1.totalBody;
const GLOBAL_BYTES = 768 * 1024 * 1024;
const USER_BYTES = 192 * 1024 * 1024;
const MAX_FILES = 128;
const TTL_MS = 60 * 60 * 1000;
const HEX = /^[a-f0-9]{64}$/;
const FILE = /^([a-f0-9]{64})\.([a-f0-9]{64})\.json$/;
const PART = /^[a-f0-9]{64}\.[a-f0-9]{64}\.json\.[a-f0-9]{24}\.part$/;
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export class BoxContextTransportError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxContextTransportError"; }
}
export interface BoxContextBinding {
  uid: string;
  containerId: string;
  model: string;
  sessionId: string;
}
export interface BoxContextReference {
  version: 1;
  reference: string;
  message_count: number;
  messages_sha256: string;
  expires_at: number;
}
export interface BoxContextTransport {
  put(binding: BoxContextBinding, messages: readonly unknown[]): Promise<BoxContextReference>;
  get(binding: BoxContextBinding, reference: string): Promise<readonly unknown[]>;
}
interface Header {
  version: 1;
  owner: string;
  binding: string;
  sha256: string;
  bytes: number;
  count: number;
  expires: number;
  created: number;
}
function bindingHash(binding: BoxContextBinding): string {
  if (!/^[1-9][0-9]{0,19}$/.test(binding.uid)
    || !/^[1-9][0-9]{0,19}$/.test(binding.containerId)
    || !binding.model || binding.model.length > 128
    || !binding.sessionId || binding.sessionId.length > 256) {
    throw new BoxContextTransportError("BOX_CONTEXT_IDENTITY_INVALID");
  }
  return hash(JSON.stringify([binding.uid, binding.containerId, binding.model, binding.sessionId]));
}
function validHeader(raw: unknown): raw is Header {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const h = raw as Header;
  return h.version === 1 && HEX.test(h.owner) && HEX.test(h.binding) && HEX.test(h.sha256)
    && Number.isSafeInteger(h.bytes) && h.bytes > 0 && h.bytes <= MAX_BYTES
    && Number.isSafeInteger(h.count) && h.count > 0 && h.count <= MAX_MESSAGES_COUNT
    && Number.isSafeInteger(h.created) && Number.isSafeInteger(h.expires)
    && h.expires - h.created === TTL_MS;
}

/** The root is a private child of the already configured Box replay directory.
 * A kernel flock serializes quotas across old/new egress processes at cutover.
 * It uses a no-follow parent-opened FD, never a shell-interpolated path. */
type HotPrefix = {
  key: string;
  reference: string;
  sha256: string;
  count: number;
  messages: readonly unknown[];
  json: string;
  stamp: JsonStamp | null;
};

function jsonElement(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

export class FileBoxContextTransport implements BoxContextTransport {
  constructor(private readonly directory: string, private readonly now = Date.now) {}
  /** Last successful put in this process. get() still reads and hashes the
   * file. A matching hash skips JSON.parse. put() rewrites only the new tail
   * when the stored prefix still has the same JSON identity. */
  private hot: HotPrefix | null = null;

  private extendedJson(key: string, messages: readonly unknown[]): string {
    const hot = this.hot;
    if (!hot || hot.key !== key || !hot.stamp || hot.count > messages.length) {
      return JSON.stringify(messages);
    }
    const stamp = jsonIdentityStamp(messages.slice(0, hot.count));
    if (!stamp || !stampsEqual(stamp, hot.stamp)) return JSON.stringify(messages);
    if (hot.count === messages.length) return hot.json;
    const parts: string[] = [];
    for (let index = hot.count; index < messages.length; index += 1) {
      parts.push(jsonElement(messages[index]));
    }
    const joiner = hot.count === 0 ? "" : ",";
    return `${hot.json.slice(0, -1)}${joiner}${parts.join(",")}]`;
  }

  /** UTF-8 size of JSON.stringify(body), reusing a canonical messages prefix. */
  bodyUtf8Bytes(binding: BoxContextBinding, body: object): number {
    const messages = (body as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return Buffer.byteLength(JSON.stringify(body));
    return proxyBodyUtf8Bytes(body, this.extendedJson(bindingHash(binding), messages));
  }

  private async directoryHandle() {
    if (!path.isAbsolute(this.directory)) throw new BoxContextTransportError("BOX_CONTEXT_STORE_UNAVAILABLE");
    await mkdir(this.directory, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    const fd = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const st = await fd.stat();
    if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) {
      await fd.close();
      throw new BoxContextTransportError("BOX_CONTEXT_STORE_UNAVAILABLE");
    }
    return fd;
  }

  private async file(name: string) {
    const fd = await open(path.join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = await fd.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600
      || st.nlink !== 1 || st.size < 2 || st.size > MAX_BYTES + 1024) {
      await fd.close();
      throw new BoxContextTransportError("BOX_CONTEXT_REF_INVALID");
    }
    return fd;
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const dir = await this.directoryHandle();
    const lock = await open(path.join(this.directory, ".quota.lock"),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600).catch(async (e) => {
        await dir.close();
        throw e;
      });
    try {
      const st = await lock.stat();
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.nlink !== 1) {
        throw new BoxContextTransportError("BOX_CONTEXT_STORE_UNAVAILABLE");
      }
      // FD-only flock returns after acquiring the inherited open-file-
      // description lock. The parent keeps that same description open until
      // the callback finishes, exactly like shell's "flock 200".
      const child = spawn("/usr/bin/flock", ["-x", "-w", "5", "3"],
        { stdio: ["ignore", "ignore", "ignore", lock.fd] });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve()
          : reject(new BoxContextTransportError("BOX_CONTEXT_STORE_BUSY")));
      });
      return await fn();
    } finally { await lock.close(); await dir.close(); }
  }

  private async header(name: string): Promise<Header | null> {
    let fd: FileHandle | undefined;
    try {
      fd = await this.file(name);
      const bytes = Buffer.alloc(1024);
      const read = await fd.read(bytes, 0, bytes.length, 0);
      const end = bytes.subarray(0, read.bytesRead).indexOf(10);
      if (end < 0) return null;
      const h: unknown = JSON.parse(bytes.subarray(0, end).toString("utf8"));
      const info = await fd.stat();
      return validHeader(h) && h.bytes + end + 1 === info.size
        && name.startsWith(`${h.binding}.`) ? h : null;
    } catch { return null; }
    finally { await fd?.close(); }
  }

  private async quota(owner: string, incomingBytes: number): Promise<void> {
    const entries: Array<{ name: string; header: Header; size: number }> = [];
    for (const name of await readdir(this.directory)) {
      // The kernel lock excludes every active writer. Matching temporary files
      // here can only be remnants of a previous crashed writer.
      if (PART.test(name)) {
        await unlink(path.join(this.directory, name)).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
        });
        continue;
      }
      if (!FILE.test(name)) continue;
      const h = await this.header(name);
      if (!h || h.expires <= this.now()) {
        await unlink(path.join(this.directory, name)).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
        });
        continue;
      }
      entries.push({ name, header: h, size: h.bytes + 1024 });
    }
    entries.sort((a, b) => a.header.created - b.header.created);
    let total = entries.reduce((n, e) => n + e.size, 0);
    let own = entries.reduce((n, e) => n + (e.header.owner === owner ? e.size : 0), 0);
    let count = entries.length;
    while (total + incomingBytes > GLOBAL_BYTES || own + incomingBytes > USER_BYTES
      || count >= MAX_FILES) {
      const index = own + incomingBytes > USER_BYTES
        ? entries.findIndex((entry) => entry.header.owner === owner) : 0;
      if (index < 0 || !entries.length) break;
      const entry = entries.splice(index, 1)[0]!;
      await unlink(path.join(this.directory, entry.name)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
      total -= entry.size;
      if (entry.header.owner === owner) own -= entry.size;
      count--;
    }
    if (total + incomingBytes > GLOBAL_BYTES || own + incomingBytes > USER_BYTES || count >= MAX_FILES) {
      throw new BoxContextTransportError("BOX_CONTEXT_STORE_FULL");
    }
  }

  async put(binding: BoxContextBinding, messages: readonly unknown[]): Promise<BoxContextReference> {
    const key = bindingHash(binding);
    if (messages.length < 1 || messages.length > MAX_MESSAGES_COUNT) {
      throw new BoxContextTransportError("BOX_CONTEXT_TOO_LARGE");
    }
    const serialized = this.extendedJson(key, messages);
    const data = Buffer.from(serialized, "utf8");
    if (data.length > MAX_BYTES) throw new BoxContextTransportError("BOX_CONTEXT_TOO_LARGE");
    const created = this.now();
    const header: Header = { version: 1, owner: hash(binding.uid), binding: key,
      sha256: hash(data), bytes: data.length, count: messages.length,
      created, expires: created + TTL_MS };
    return this.locked(async () => {
      await this.quota(header.owner, data.length + 1024);
      const reference = randomBytes(32).toString("hex");
      const name = `${key}.${reference}.json`;
      const target = path.join(this.directory, name);
      const tmp = `${target}.${randomBytes(12).toString("hex")}.part`;
      try {
        const fd = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
          | constants.O_NOFOLLOW, 0o600);
        try {
          await fd.writeFile(Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), data]));
          await fd.sync();
        } finally { await fd.close(); }
        await link(tmp, target);
        await unlink(tmp);
        const dir = await this.directoryHandle();
        try { await dir.sync(); } finally { await dir.close(); }
      } catch (e) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      const stored = messages.slice();
      this.hot = { key, reference, sha256: header.sha256, count: stored.length,
        messages: stored, json: serialized, stamp: jsonIdentityStamp(stored) };
      return { version: 1, reference, message_count: messages.length,
        messages_sha256: header.sha256, expires_at: header.expires };
    });
  }

  async get(binding: BoxContextBinding, reference: string): Promise<readonly unknown[]> {
    const key = bindingHash(binding);
    if (!HEX.test(reference)) throw new BoxContextTransportError("BOX_CONTEXT_REF_INVALID");
    const dir = await this.directoryHandle();
    try {
      const fd = await this.file(`${key}.${reference}.json`);
      try {
        const all = await fd.readFile();
        const end = all.indexOf(10);
        if (end < 0 || end >= 1024) throw new BoxContextTransportError("BOX_CONTEXT_REF_INVALID");
        const header: unknown = JSON.parse(all.subarray(0, end).toString("utf8"));
        const data = all.subarray(end + 1);
        if (!validHeader(header) || header.binding !== key || header.owner !== hash(binding.uid)
          || header.bytes !== data.length || hash(data) !== header.sha256) {
          throw new BoxContextTransportError("BOX_CONTEXT_REF_INVALID");
        }
        if (header.expires <= this.now()) throw new BoxContextTransportError("BOX_CONTEXT_REF_EXPIRED");
        const hot = this.hot;
        if (hot && hot.key === key && hot.reference === reference
          && hot.sha256 === header.sha256 && hot.count === header.count
          && hot.messages.length === header.count && hot.stamp) {
          const stamp = jsonIdentityStamp(hot.messages);
          if (stamp && stampsEqual(stamp, hot.stamp)) return hot.messages.slice();
        }
        const messages: unknown = JSON.parse(data.toString("utf8"));
        if (!Array.isArray(messages) || messages.length !== header.count) {
          throw new BoxContextTransportError("BOX_CONTEXT_REF_INVALID");
        }
        return messages;
      } finally { await fd.close(); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BoxContextTransportError("BOX_CONTEXT_REF_EXPIRED");
      }
      if (e instanceof BoxContextTransportError) throw e;
      throw new BoxContextTransportError("BOX_CONTEXT_REF_INVALID");
    } finally { await dir.close(); }
  }
}


/** Called only after the ordinary identity/catalog/route/budget gates.
 * Reconstruct the complete original body; no native owner check is replaced. */
export async function restoreBoxContextRequest(input: {
  store: BoxContextTransport;
  uid: bigint;
  containerId: bigint | null | undefined;
  body: ProxyBody;
  budget: ProxyByteBudget;
  stage: boolean;
}): Promise<{ body: ProxyBody; bytes: number; reference?: BoxContextReference }> {
  if (input.budget.id !== "box-native-v1"
    || (!input.stage && !input.body.oc_context_transport?.reference)) {
    throw new BoxContextTransportError("BOX_CONTEXT_TRANSPORT_UNAVAILABLE");
  }
  const binding = { uid: input.uid.toString(), containerId: input.containerId?.toString() ?? "",
    model: input.body.model, sessionId: extractSessionId(input.body.metadata) ?? "" };
  const transport = input.body.oc_context_transport;
  const prefix = transport?.reference
    ? await input.store.get(binding, transport.reference) : [];
  const { oc_context_transport: _transport, ...logicalBody } = input.body;
  const parsed = proxyBodySchema.safeParse({
    ...logicalBody, messages: [...prefix, ...logicalBody.messages],
  });
  if (!parsed.success) throw new BoxContextTransportError("BOX_CONTEXT_REF_INVALID");
  const body = parsed.data;
  const bytes = input.store instanceof FileBoxContextTransport
    ? input.store.bodyUtf8Bytes(binding, body)
    : Buffer.byteLength(JSON.stringify(body));
  enforceTotalBodyBudget(bytes, input.budget);
  return { body, bytes, ...(input.stage ? {
    reference: await input.store.put(binding, body.messages),
  } : {}) };
}
