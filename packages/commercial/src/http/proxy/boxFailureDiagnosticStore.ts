/** Private best-effort cache: 2048 fixed 8 KiB records + one 8 KiB crash
 * temporary + one empty permanent flock inode (<16.01 MiB payload).
 * Collisions may evict early. TTL reads are strict; idle physical GC retries.
 * All mutations use the same kernel lock, including crash-temp recovery. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { DIAGNOSTIC_MAX_BYTES, parseDiagnosticSnapshot, type DiagnosticSnapshot } from "./boxFailureDiagnosticSchema.js";

export const DIAGNOSTIC_SLOTS = 2048;
const owner = (): number => process.getuid!();
export function diagnosticSlot(id: string): string {
  if (!/^bdiag_[a-f0-9]{24}$/.test(id)) throw new Error("BOX_DIAGNOSTIC_ID_INVALID");
  return "s" + (parseInt(id.slice(6, 9), 16) % DIAGNOSTIC_SLOTS).toString(16).padStart(3, "0");
}

/** No shell, no dependencies. Nonblocking flock retries for <=250ms; the Node
 * caller also enforces a 2s deadline and SIGKILLs/reaps on abort. The lock inode
 * is never unlinked (even by GC): a paused writer cannot lose its lock domain.
 * Exported so tests can inject a crash in the exact production mutation code. */
export const DIAGNOSTIC_MUTATION_SCRIPT = String.raw`import fcntl,hashlib,json,os,re,stat,sys,time
directory,operation,slot,now=sys.argv[1:]
now=int(now)
if operation not in ('write','sweep') or not re.fullmatch(r's[0-7][0-9a-f]{2}',slot):raise SystemExit(126)
if operation=='write':
 try:os.mkdir(directory,0o700)
 except FileExistsError:pass
d=os.open(directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
lock=None
def private(info):
 return stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o600 and info.st_nlink==1
def inspect(name):
 f=os.open(name,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW,dir_fd=d)
 try:
  st=os.fstat(f)
  if not private(st) or st.st_size>8192:raise ValueError()
  raw=os.read(f,8193)
  if len(raw)!=st.st_size:raise ValueError()
  return st,raw
 finally:os.close(f)
def clear_temp():
 try:st,_=inspect('write.tmp')
 except FileNotFoundError:return
 os.unlink('write.tmp',dir_fd=d)
try:
 st=os.fstat(d)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:raise ValueError()
 lock=os.open('.mutation.lock',os.O_RDWR|os.O_CREAT|os.O_NONBLOCK|os.O_NOFOLLOW,0o600,dir_fd=d)
 st=os.fstat(lock)
 if not private(st) or st.st_size!=0:raise ValueError()
 until=time.monotonic()+.25
 while True:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
  except BlockingIOError:
   if time.monotonic()>=until:raise SystemExit(75)
   time.sleep(.01)
 # A temporary now can only be from a dead/finished writer: never reclaim by age.
 clear_temp()
 if operation=='write':
  raw=sys.stdin.buffer.read(8193)
  if not 1<=len(raw)<=8192:raise ValueError()
  value=json.loads(raw)
  if not isinstance(value,dict) or not re.fullmatch(r'bdiag_[a-f0-9]{24}',value.get('id','')):raise ValueError()
  if 's'+format(int(value['id'][6:9],16)%2048,'03x')!=slot:raise ValueError()
  old=None
  try:_,old_raw=inspect(slot+'.json');old=json.loads(old_raw)
  except FileNotFoundError:pass
  except (ValueError,UnicodeError):pass
  # This store writes only TS-validated records. Check under the lock so a
  # concurrent missing-evidence write cannot downgrade captured evidence.
  if isinstance(old,dict) and old.get('id')==value['id'] and old.get('status')=='ok' and type(old.get('expiresAtMs')) is int and old['expiresAtMs']>now:
   print('kept')
  else:
   f=os.open('write.tmp',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d)
   try:
    offset=0
    while offset<len(raw):
     n=os.write(f,raw[offset:])
     if n<=0:raise OSError()
     offset+=n
    os.fsync(f)
   finally:os.close(f)
   os.rename('write.tmp',slot+'.json',src_dir_fd=d,dst_dir_fd=d)
   os.fsync(d)
   print('written')
 else:
  candidates=json.loads(sys.stdin.buffer.read(16385))
  if not isinstance(candidates,list) or len(candidates)>64:raise ValueError()
  removed=0
  for item in candidates:
   if not isinstance(item,dict) or not re.fullmatch(r's[0-7][0-9a-f]{2}\.json',item.get('name','')):raise ValueError()
   try:
    st,raw=inspect(item['name'])
    # Compare+unlink both happen under flock, preventing replacement races.
    if str(st.st_dev)==item.get('dev') and str(st.st_ino)==item.get('ino') and hashlib.sha256(raw).hexdigest()==item.get('sha256'):
     os.unlink(item['name'],dir_fd=d);removed+=1
   except FileNotFoundError:pass
  if removed:os.fsync(d)
  print(removed)
finally:
 if lock is not None:os.close(lock)
 os.close(d)`;

interface Inspected { value: DiagnosticSnapshot | null; dev: string; ino: string; mtimeMs: number; sha256: string; }
export class BoxFailureDiagnosticStore {
  private cursor = 0;
  constructor(readonly directory: string, private readonly now: () => number = Date.now) {
    if (!isAbsolute(directory)) throw new Error("BOX_DIAGNOSTIC_DIR_INVALID");
  }
  private async directoryCheck(): Promise<void> {
    const fd = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const st = await fd.stat();
      if (!st.isDirectory() || st.uid !== owner() || (st.mode & 0o777) !== 0o700) throw new Error("BOX_DIAGNOSTIC_DIR_INVALID");
    } finally { await fd.close(); }
  }
  private async inspect(name: string): Promise<Inspected | null> {
    let fd;
    try {
      fd = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = await fd.stat();
      if (!st.isFile() || st.uid !== owner() || (st.mode & 0o777) !== 0o600
        || st.nlink !== 1 || st.size > DIAGNOSTIC_MAX_BYTES) return null;
      let value: DiagnosticSnapshot | null = null;
      const bytes = Buffer.alloc(DIAGNOSTIC_MAX_BYTES + 1);
      const read = await fd.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead === st.size && read.bytesRead > 0 && read.bytesRead <= DIAGNOSTIC_MAX_BYTES) {
        try { value = parseDiagnosticSnapshot(JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8"))); }
        catch { /* Corrupt records are unservable and become GC candidates. */ }
      }
      return { value, dev: String(st.dev), ino: String(st.ino), mtimeMs: st.mtimeMs,
        sha256: createHash("sha256").update(bytes.subarray(0, read.bytesRead)).digest("hex") };
    } catch { return null; }
    finally { await fd?.close(); }
  }
  async read(id: string): Promise<DiagnosticSnapshot | null> {
    try {
      await this.directoryCheck();
      const value = (await this.inspect(diagnosticSlot(id) + ".json"))?.value;
      return value?.id === id && value.expiresAtMs > this.now() ? value : null;
    } catch { return null; }
  }
  /** Read-only bounded lookup: no creation, lock acquisition or GC. */
  async findByRequest(uid: bigint, requestId: string): Promise<DiagnosticSnapshot[]> {
    if (!/^[1-9][0-9]{0,18}$/.test(String(uid)) || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) return [];
    try { await this.directoryCheck(); } catch { return []; }
    const found: DiagnosticSnapshot[] = [];
    for (let i = 0; i < DIAGNOSTIC_SLOTS; i++) {
      const slot = "s" + i.toString(16).padStart(3, "0");
      const value = (await this.inspect(slot + ".json"))?.value;
      if (value && value.expiresAtMs > this.now() && value.identity.uid === String(uid)
        && value.identity.requestId === requestId && diagnosticSlot(value.id) === slot) found.push(value);
    }
    return found;
  }
  private mutate(operation: "write" | "sweep", slot: string, input: string,
    signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/python3", ["-I", "-c", DIAGNOSTIC_MUTATION_SCRIPT,
        this.directory, operation, slot, String(this.now())],
      { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", failed = false;
      const stop = () => { failed = true; child.kill("SIGKILL"); };
      const timer = setTimeout(stop, 2000);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      child.stdout.on("data", (part: Buffer) => {
        output += part.toString("utf8");
        if (output.length > 64) stop();
      });
      // Never stringify/log stderr or native errors: they may mention paths.
      child.stderr.resume();
      child.stdin.on("error", () => { /* Child may exit before reading input. */ });
      child.on("error", () => { failed = true; });
      child.on("close", (code) => {
        clearTimeout(timer); signal?.removeEventListener("abort", stop);
        if (failed || code !== 0) reject(new Error("BOX_DIAGNOSTIC_MUTATION_FAILED"));
        else resolve(output.trim());
      });
      child.stdin.end(input);
    });
  }
  async write(snapshot: DiagnosticSnapshot, signal?: AbortSignal): Promise<void> {
    const safe = parseDiagnosticSnapshot(snapshot);
    if (!safe) throw new Error("BOX_DIAGNOSTIC_SNAPSHOT_INVALID");
    const raw = JSON.stringify(safe) + "\n";
    if (Buffer.byteLength(raw) > DIAGNOSTIC_MAX_BYTES) throw new Error("BOX_DIAGNOSTIC_TOO_LARGE");
    await this.mutate("write", diagnosticSlot(safe.id), raw, signal);
  }
  /** Idle callers scan <=64 fixed names per tick. Busy/failed lock is best
   * effort: reads enforce TTL and a later rotation reclaims disk. */
  async sweep(limit = 64): Promise<number> {
    try { await this.directoryCheck(); } catch { return 0; }
    const candidates: { name: string; dev: string; ino: string; sha256: string }[] = [];
    const count = Math.min(64, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 64));
    for (let i = 0; i < count; i++) {
      const name = "s" + (this.cursor++ % DIAGNOSTIC_SLOTS).toString(16).padStart(3, "0") + ".json";
      const item = await this.inspect(name);
      if (item && (item.value ? item.value.expiresAtMs <= this.now() : item.mtimeMs + 60_000 < this.now())) {
        candidates.push({ name, dev: item.dev, ino: item.ino, sha256: item.sha256 });
      }
    }
    try {
      const result = await this.mutate("sweep", "s000", JSON.stringify(candidates));
      return /^[0-9]+$/.test(result) ? Number(result) : 0;
    } catch { return 0; }
  }
}
