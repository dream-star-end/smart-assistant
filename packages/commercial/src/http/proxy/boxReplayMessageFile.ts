/** Private, selfhost-injected storage for one completed Anthropic Message.
 * The journal stores only this content hash/pointer; raw model output, tool
 * input and thinking never enter PostgreSQL. No directory is auto-created by
 * the model path: the selfhost composition must provide an owner-only dir. */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { BOX_TOOL_MAX_ROUNDS, BOX_TOOL_MESSAGE_STREAM_MAX_BYTES } from "./boxToolCapacity.js";

/** OCV5-368: whatever the decoder accepted as one message must persist (was 2 MiB). */
const MAX_MESSAGE_BYTES = BOX_TOOL_MESSAGE_STREAM_MAX_BYTES;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX24 = /^[a-f0-9]{24}$/;
const HEX32 = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;

export class BoxReplayMessageFileError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxReplayMessageFileError"; }
}
export interface BoxReplayMessagePointer {
  readonly version: 1;
  readonly uid: string;
  readonly requestId: string;
  readonly runNonce: string;
  readonly leaseEpoch: string;
  readonly roundNo: number;
  readonly bytes: number;
  readonly sha256: string;
}
export function parseBoxReplayMessagePointer(raw: unknown): BoxReplayMessagePointer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const x = raw as Record<string, unknown>;
  if (Object.keys(x).sort().join(",")
    !== "bytes,leaseEpoch,requestId,roundNo,runNonce,sha256,uid,version"
    || x.version !== 1 || typeof x.uid !== "string"
    || typeof x.requestId !== "string" || typeof x.runNonce !== "string"
    || typeof x.leaseEpoch !== "string" || typeof x.roundNo !== "number"
    || !validIdentity(x as unknown as Identity)
    || !Number.isSafeInteger(x.bytes) || Number(x.bytes) < 1
    || Number(x.bytes) > MAX_MESSAGE_BYTES
    || typeof x.sha256 !== "string" || !SHA.test(x.sha256)) return null;
  return x as unknown as BoxReplayMessagePointer;
}
type Identity = Pick<BoxReplayMessagePointer,
  "uid" | "requestId" | "runNonce" | "leaseEpoch" | "roundNo">;
export type BoxReplayMessageWriter = (identity: Identity,
  message: unknown) => Promise<BoxReplayMessagePointer>;
function ownerUid(): number {
  if (typeof process.getuid !== "function") {
    throw new BoxReplayMessageFileError("BOX_REPLAY_UNSUPPORTED_HOST");
  }
  return process.getuid();
}

function validIdentity(x: Identity): boolean {
  return /^[1-9][0-9]{0,19}$/.test(x.uid) && ID.test(x.requestId)
    && HEX24.test(x.runNonce) && HEX32.test(x.leaseEpoch)
    && Number.isSafeInteger(x.roundNo) && x.roundNo >= 1
    && x.roundNo <= BOX_TOOL_MAX_ROUNDS;
}
function filename(x: Identity): string {
  return `${x.uid}.${x.requestId}.${x.runNonce}.${x.leaseEpoch}.${x.roundNo}.json`;
}
function validMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  const u = m.usage;
  return m.type === "message" && m.role === "assistant"
    && typeof m.id === "string" && /^msg_[A-Za-z0-9_-]{1,120}$/.test(m.id)
    && typeof m.model === "string" && /^claude-[a-z0-9-]{3,64}$/.test(m.model)
    && Array.isArray(m.content)
    && ["tool_use", "end_turn", "max_tokens", "stop_sequence"].includes(String(m.stop_reason))
    && !!u && typeof u === "object" && !Array.isArray(u)
    && Number.isSafeInteger((u as Record<string, unknown>).input_tokens)
    && Number.isSafeInteger((u as Record<string, unknown>).output_tokens);
}
async function privateDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new BoxReplayMessageFileError("BOX_REPLAY_DIR_INVALID");
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY
    | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || info.uid !== ownerUid()
      || (info.mode & 0o777) !== 0o700) {
      throw new BoxReplayMessageFileError("BOX_REPLAY_DIR_INVALID");
    }
  } finally { await handle.close(); }
}
function pointer(identity: Identity, data: Buffer): BoxReplayMessagePointer {
  return { version: 1, uid: identity.uid, requestId: identity.requestId,
    runNonce: identity.runNonce, leaseEpoch: identity.leaseEpoch,
    roundNo: identity.roundNo, bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex") };
}
/** Repair only a crash-left temporary hardlink to this exact open inode. An
 * unrelated extra link (including one outside this private directory) still
 * fails the nlink fence. */
async function dropOwnTempLinks(directory: string, name: string,
  info: { dev: number; ino: number; uid: number }): Promise<void> {
  const prefix = `${name}.`;
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith(prefix)
      || !/^[a-f0-9]{16}\.part$/.test(entry.slice(prefix.length))) continue;
    const candidate = path.join(directory, entry);
    let other;
    try { other = await lstat(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!other.isFile() || other.dev !== info.dev || other.ino !== info.ino
      || other.uid !== info.uid || (other.mode & 0o777) !== 0o600) continue;
    try { await unlink(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
export async function writeBoxReplayMessage(directory: string, identity: Identity,
  message: unknown): Promise<BoxReplayMessagePointer> {
  if (!validIdentity(identity) || !validMessage(message)) {
    throw new BoxReplayMessageFileError("BOX_REPLAY_MESSAGE_INVALID");
  }
  const data = Buffer.from(JSON.stringify(message), "utf8");
  if (data.length < 1 || data.length > MAX_MESSAGE_BYTES) {
    throw new BoxReplayMessageFileError("BOX_REPLAY_MESSAGE_TOO_LARGE");
  }
  await privateDirectory(directory);
  const proof = pointer(identity, data);
  const finalPath = path.join(directory, filename(identity));
  const tempPath = `${finalPath}.${randomBytes(8).toString("hex")}.part`;
  let created = false;
  try {
    const file = await open(tempPath, constants.O_WRONLY | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    try { await link(tempPath, finalPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await unlink(tempPath).catch((unlinkError: unknown) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      });
      created = false;
      await readBoxReplayMessage(directory, proof);
      return proof;
    }
    // The final link is no-clobber. Drop our temporary second link before
    // syncing the directory; a successful return always has nlink=1.
    await unlink(tempPath).catch((unlinkError: unknown) => {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
    });
    created = false;
    const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY
      | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
    return proof;
  } finally {
    if (created) await unlink(tempPath).catch(() => {});
  }
}
export async function readBoxReplayMessage(directory: string,
  proof: BoxReplayMessagePointer): Promise<unknown> {
  if (!parseBoxReplayMessagePointer(proof)) {
    throw new BoxReplayMessageFileError("BOX_REPLAY_POINTER_INVALID");
  }
  await privateDirectory(directory);
  const name = filename(proof);
  const file = await open(path.join(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let info = await file.stat();
    if (info.nlink > 1) {
      await dropOwnTempLinks(directory, name, info);
      info = await file.stat();
    }
    if (!info.isFile() || info.uid !== ownerUid()
      || (info.mode & 0o777) !== 0o600 || info.nlink !== 1
      || info.size !== proof.bytes) {
      throw new BoxReplayMessageFileError("BOX_REPLAY_FILE_INVALID");
    }
    const data = await file.readFile();
    if (createHash("sha256").update(data).digest("hex") !== proof.sha256) {
      throw new BoxReplayMessageFileError("BOX_REPLAY_FILE_INVALID");
    }
    let message: unknown;
    try { message = JSON.parse(data.toString("utf8")); }
    catch { throw new BoxReplayMessageFileError("BOX_REPLAY_FILE_INVALID"); }
    if (!validMessage(message)) throw new BoxReplayMessageFileError("BOX_REPLAY_FILE_INVALID");
    return message;
  } finally { await file.close(); }
}
