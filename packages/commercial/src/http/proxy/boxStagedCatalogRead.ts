/** Read only the catalog staged for one already admitted nonce.
 * The caller cannot choose a path. This does not execute tools or launch a CLI.
 * One Exec response cannot carry a legal near-1MiB catalog: Connect frames
 * JSON-escape the stdout, so the file is read in fixed windows and checked
 * again after the bytes are joined. */
import type { BoxCcExecRequest } from "@openclaude/gateway";
import type { BoxExecTransport } from "./boxExecTransport.js";

const CHUNK_BYTES = 262_144;
const FILE_MAX_BYTES = 1_048_576;

const READ_CATALOG = String.raw`import os,re,stat,sys,json,base64
nonce,off_s,lim_s=sys.argv[1],sys.argv[2],sys.argv[3]
if not re.fullmatch(r'[0-9a-f]{24}',nonce):raise SystemExit(1)
if not re.fullmatch(r'0|[1-9][0-9]{0,6}',off_s) or not re.fullmatch(r'[1-9][0-9]{0,6}',lim_s):raise SystemExit(1)
offset,limit=int(off_s),int(lim_s)
if offset>1048576 or not 1<=limit<=262144:raise SystemExit(1)
path='/tmp/ocv5-289-run-'+nonce
directory=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 st=os.fstat(directory)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise SystemExit(1)
 fd=os.open('tool-catalog.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
 try:
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1 or not 1<=st.st_size<=1048576:raise SystemExit(1)
  if offset>=st.st_size:raise SystemExit(1)
  want=min(limit,st.st_size-offset)
  os.lseek(fd,offset,os.SEEK_SET)
  raw=os.read(fd,want)
  again=os.fstat(fd)
  if len(raw)!=want or again.st_dev!=st.st_dev or again.st_ino!=st.st_ino or again.st_size!=st.st_size or again.st_nlink!=1 or stat.S_IMODE(again.st_mode)!=0o600:raise SystemExit(1)
  payload=json.dumps({"data":base64.b64encode(raw).decode("ascii"),"dev":str(st.st_dev),"ino":str(st.st_ino),"offset":offset,"size":st.st_size},separators=(",",":")).encode()
  os.write(1,payload)
 finally:os.close(fd)
finally:os.close(directory)`;

export class BoxStagedCatalogReadError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxStagedCatalogReadError"; }
}

export function makeBoxStagedCatalogRead(runNonce: string, offset: number,
  limit = CHUNK_BYTES): BoxCcExecRequest {
  if (!/^[0-9a-f]{24}$/.test(runNonce)
    || !Number.isSafeInteger(offset) || offset < 0 || offset > FILE_MAX_BYTES
    || !Number.isSafeInteger(limit) || limit < 1 || limit > CHUNK_BYTES) {
    throw new BoxStagedCatalogReadError("BOX_CATALOG_NONCE_INVALID");
  }
  return { command: "/usr/bin/python3", args: ["-I", "-c", READ_CATALOG, runNonce,
    String(offset), String(limit)],
    cwd: "/tmp", environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
}

export function parseBoxStagedCatalogChunk(raw: string, offset: number, limit: number): {
  bytes: Buffer; dev: string; ino: string; size: number; nextOffset: number;
} {
  if (Buffer.byteLength(raw) > FILE_MAX_BYTES || !Number.isSafeInteger(offset)
    || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > CHUNK_BYTES) {
    throw new BoxStagedCatalogReadError("BOX_CATALOG_READ_INVALID");
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new BoxStagedCatalogReadError("BOX_CATALOG_READ_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoxStagedCatalogReadError("BOX_CATALOG_READ_INVALID");
  }
  const row = value as Record<string, unknown>;
  const data = row.data;
  const dev = row.dev;
  const ino = row.ino;
  const reportedOffset = row.offset;
  const size = row.size;
  if (Object.keys(row).sort().join(",") !== "data,dev,ino,offset,size"
    || typeof data !== "string" || typeof dev !== "string" || typeof ino !== "string"
    || !/^[0-9]{1,20}$/.test(dev) || !/^[0-9]{1,20}$/.test(ino)
    || typeof reportedOffset !== "number" || !Number.isSafeInteger(reportedOffset)
    || typeof size !== "number" || !Number.isSafeInteger(size)
    || reportedOffset !== offset || size < 1 || size > FILE_MAX_BYTES
    || offset >= size) {
    throw new BoxStagedCatalogReadError("BOX_CATALOG_READ_INVALID");
  }
  const bytes = Buffer.from(data, "base64");
  const expect = Math.min(limit, size - offset);
  if (bytes.toString("base64") !== data || bytes.length !== expect) {
    throw new BoxStagedCatalogReadError("BOX_CATALOG_READ_INVALID");
  }
  return { bytes, dev, ino, size, nextOffset: offset + bytes.length };
}

export async function readBoxStagedToolCatalog(input: {
  exec: Pick<BoxExecTransport, "run">;
  runNonce: string;
  signal?: AbortSignal;
}): Promise<{ json: string }> {
  const parts: Buffer[] = [];
  let offset = 0;
  let identity: { dev: string; ino: string; size: number } | null = null;
  for (let call = 0; call < 5; call += 1) {
    if (identity && offset >= identity.size) break;
    const request = makeBoxStagedCatalogRead(input.runNonce, offset, CHUNK_BYTES);
    const result = await input.exec.run(request, {
      timeoutMs: 5_000, maxResponseBytes: FILE_MAX_BYTES, signal: input.signal });
    const chunk = parseBoxStagedCatalogChunk(result.stdout, offset, CHUNK_BYTES);
    if (!identity) identity = { dev: chunk.dev, ino: chunk.ino, size: chunk.size };
    else if (identity.dev !== chunk.dev || identity.ino !== chunk.ino
      || identity.size !== chunk.size) {
      throw new BoxStagedCatalogReadError("BOX_CATALOG_READ_INVALID");
    }
    parts.push(chunk.bytes);
    offset = chunk.nextOffset;
  }
  if (!identity || offset !== identity.size) {
    throw new BoxStagedCatalogReadError("BOX_CATALOG_READ_INVALID");
  }
  const raw = Buffer.concat(parts);
  if (raw.length !== identity.size) {
    throw new BoxStagedCatalogReadError("BOX_CATALOG_READ_INVALID");
  }
  let json: string;
  try { json = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { throw new BoxStagedCatalogReadError("BOX_CATALOG_READ_INVALID"); }
  if (Buffer.byteLength(json) !== raw.length || json.length < 1) {
    throw new BoxStagedCatalogReadError("BOX_CATALOG_READ_INVALID");
  }
  return { json };
}
