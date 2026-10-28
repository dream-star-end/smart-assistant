/** OCV5-488: read-only probe of whether anything of one Box run is still
 * alive on the Box, as the cleanup worker's evidence for releasing a run
 * whose keeper never wrote a terminal proof (10-17 commercial account 79:
 * three handoff leaves held the account for 78 min after their CLIs were
 * gone, until an operator closed them).
 *
 * `alive`: a process of this uid still names the run nonce on its command
 * line (keeper, supervisor), works in the run's directory (the CLI), or is in
 * the CLI's session or process group: the supervisor starts the CLI in a new
 * session, so a child that outlived it there, in any cwd, is still the run
 * (#833 Codex r1). A descendant that calls setsid itself and leaves the cwd
 * escapes this, as it escapes the supervisor's own group kill; a route A CLI
 * runs no local tools (they run in the user's container), so the model cannot
 * start one.
 * `absent`: no such process. A stop.ready that is missing or not the
 * keeper's exact handshake proves nothing and does not skip the scan. A
 * terminal.json that can only be stat'd is not a proof; worker_complete stays
 * with the proof reader. Anything unreadable, including the boot id, exits
 * non-zero and proves nothing. The boot id lets the caller tell "gone since
 * the last look" from "the Box rebooted". Nothing is signalled or removed. */
import type { BoxCcExecRequest } from "@openclaude/gateway";

const PROBE = String.raw`import json,os,re,sys
if len(sys.argv) not in (2,3):raise SystemExit(126)
nonce=sys.argv[1]
if not re.fullmatch(r'[a-f0-9]{24}',nonce):raise SystemExit(126)
run='/tmp/ocv5-289-run-'+nonce
cli=sys.argv[2] if len(sys.argv)==3 else run
if not re.fullmatch(r'/tmp/ocv5-289-run-[a-f0-9]{24}',cli):raise SystemExit(126)
proof='/tmp/ocv5-289-proof-'+nonce
with open('/proc/sys/kernel/random/boot_id') as f:boot=f.read().strip()
if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',boot):
 raise SystemExit(125)
uid=os.getuid()
mine=set()
pid=os.getpid()
while pid>1 and pid not in mine:
 mine.add(pid)
 try:
  with open('/proc/%d/stat'%pid,'rb') as f:pid=int(f.read().rsplit(b')',1)[1].split()[1])
 except (OSError,ValueError,IndexError):break
dirs=set()
for d in (run,cli):
 try:st=os.stat(d,follow_symlinks=False)
 except FileNotFoundError:continue
 dirs.add((st.st_dev,st.st_ino))
sids=set()
try:
 with open(proof+'/stop.ready','rb') as f:raw=f.read(513)
except FileNotFoundError:pass
else:
 try:ready=json.loads(raw)
 except ValueError:ready=None
 if (isinstance(ready,dict) and ready.get('runNonce')==nonce
     and type(ready.get('cliPid')) is int and ready['cliPid']>=2):
  sids.add(ready['cliPid'])
mark=nonce.encode()
for name in os.listdir('/proc'):
 if not name.isdigit() or int(name) in mine:continue
 p='/proc/'+name
 try:
  if os.stat(p).st_uid!=uid:continue
  with open(p+'/cmdline','rb') as f:raw=f.read(65536)
  if mark in raw:
   print('alive '+boot);raise SystemExit(0)
  if sids:
   with open(p+'/stat','rb') as f:fields=f.read().rsplit(b')',1)[1].split()
   if int(fields[2]) in sids or int(fields[3]) in sids:
    print('alive '+boot);raise SystemExit(0)
  if dirs:
   c=os.stat(p+'/cwd')
   if (c.st_dev,c.st_ino) in dirs:
    print('alive '+boot);raise SystemExit(0)
 except (FileNotFoundError,ProcessLookupError):continue
print('absent '+boot)`;

/** `terminal` is accepted so an injected or older line still defers to the
 * proof reader. This probe no longer prints it from a stat of terminal.json. */
export type BoxRunLiveness = { state: "alive" | "absent" | "terminal"; boot: string };

/** `cliCwd` is the run's native CLI cwd when it differs from its own run
 * directory (journal boxNativeCliCwd), as for the keeper stop. */
export function makeBoxRunLiveness(runNonce: string, cliCwd?: string): BoxCcExecRequest {
  if (!/^[a-f0-9]{24}$/.test(runNonce)
    || (cliCwd !== undefined && !/^\/tmp\/ocv5-289-run-[a-f0-9]{24}$/.test(cliCwd))) {
    throw new Error("BOX_RUN_LIVENESS_ID_INVALID");
  }
  const native = cliCwd !== undefined && cliCwd !== `/tmp/ocv5-289-run-${runNonce}`;
  return { command: "/usr/bin/python3", args: ["-I", "-c", PROBE, runNonce,
    ...(native ? [cliCwd] : [])],
    cwd: "/tmp", environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
}

/** Exactly one line the probe prints; anything else is no evidence. */
export function parseBoxRunLiveness(stdout: string): BoxRunLiveness | null {
  const match = /^(alive|absent|terminal) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\n?$/
    .exec(stdout);
  return match ? { state: match[1] as BoxRunLiveness["state"], boot: match[2]! } : null;
}
