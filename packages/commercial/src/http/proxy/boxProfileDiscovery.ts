/** Lists the Claude Code logins on a Box and makes a login usable by the model
 * route. Runs two fixed python scripts through Box Exec. Output is a strict
 * allowlist: a masked email hint, a one-way account fingerprint and states.
 * The scripts never read a credentials file (they only stat it) and never print
 * a path other than the profile name. */
import type { BoxCcExecRequest } from "@openclaude/gateway";
import { BOX_DEFAULT_PROFILE, boxProfileNameFromDirName } from "./boxClaudeProfile.js";
import type { BoxDiscoveredProfile } from "./boxClaudeProfileStore.js";

const PYTHON = "/usr/bin/python3";
const ENV = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };

/** Every path step below is relative to a directory fd opened with O_NOFOLLOW, and the shared
 * projects link is judged by its exact target text, so a directory swapped for a symlink between
 * steps cannot redirect a read or the link we create. (Same-UID code is still not a security
 * boundary; this closes accidental and low-effort swaps.) */
const COMMON = String.raw`import hashlib,json,os,re,stat,sys
H='/home/box';ROOT=H+'/.claude';SHARED=ROOT+'/projects';ME=os.getuid()
O=os.O_RDONLY|os.O_NOFOLLOW
def odir(name,fd=None):return os.open(name,O|os.O_DIRECTORY,dir_fd=fd)
def mine(fd):
 st=os.fstat(fd)
 if not stat.S_ISDIR(st.st_mode) or st.st_uid!=ME:raise SystemExit(3)
def shared_root(hfd):
 r=odir('.claude',hfd)
 try:
  mine(r)
  p=odir('projects',r)
  try:mine(p)
  finally:os.close(p)
 finally:os.close(r)
def projects_mode(dfd):
 try:st=os.lstat('projects',dir_fd=dfd)
 except FileNotFoundError:return 'absent'
 if stat.S_ISLNK(st.st_mode):return 'shared' if os.readlink('projects',dir_fd=dfd)==SHARED else 'own'
 return 'own'
def credential(dfd):
 try:st=os.stat('.credentials.json',dir_fd=dfd,follow_symlinks=False)
 except OSError:return False
 return stat.S_ISREG(st.st_mode) and st.st_uid==ME and st.st_size>0`;

const DISCOVER = COMMON + String.raw`
def small(fd,name,cap):
 try:f=os.open(name,O|os.O_NONBLOCK,dir_fd=fd)
 except OSError:return None
 try:
  st=os.fstat(f)
  if not stat.S_ISREG(st.st_mode) or st.st_uid!=ME or st.st_size>cap:return None
  return os.read(f,cap+1) if st.st_size else b''
 finally:os.close(f)
def mask(mail):
 u,sep,d=mail.partition('@')
 if not sep or not u or '.' not in d:return None
 return u[:1]+'***@'+d[:1]+'***'+d[d.rfind('.'):][:8]
def account(raw):
 if not raw:return None
 try:o=json.loads(raw).get('oauthAccount')
 except Exception:return None
 if not isinstance(o,dict):return None
 mail=o.get('emailAddress');uuid=o.get('accountUuid');org=o.get('organizationType')
 if not isinstance(mail,str) or not isinstance(uuid,str):return None
 return mask(mail),hashlib.sha256(uuid.encode()).hexdigest()[:12],org if isinstance(org,str) and re.fullmatch(r'[a-z_]{1,24}',org) else None
out=[]
hfd=odir(H)
try:
 for entry in sorted(os.listdir(hfd)):
  if entry=='.claude-default' or (entry!='.claude' and not re.fullmatch(r'\.claude-[a-z0-9][a-z0-9-]{0,31}',entry)):continue
  try:dfd=odir(entry,hfd)
  except OSError:continue
  try:
   if os.fstat(dfd).st_uid!=ME:continue
   default=entry=='.claude'
   acct=account(small(hfd,'.claude.json',4*1024*1024) if default else small(dfd,'.claude.json',4*1024*1024))
   out.append({'dir':entry,'login':bool(acct) and credential(dfd),'projects':'root' if default else projects_mode(dfd),
    'email':acct[0] if acct else None,'fp':acct[1] if acct else None,'org':acct[2] if acct else None})
  finally:os.close(dfd)
finally:os.close(hfd)
print(json.dumps(out,separators=(',',':')))`;

/** Only a profile whose projects entry is absent can be prepared; an existing real directory
 * belongs to someone's own sessions and is never touched. */
const PREPARE = COMMON + String.raw`
entry=sys.argv[1] if len(sys.argv)==2 else ''
if not re.fullmatch(r'\.claude-[a-z0-9][a-z0-9-]{0,31}',entry) or entry=='.claude-default':raise SystemExit(2)
hfd=odir(H)
try:
 shared_root(hfd)
 dfd=odir(entry,hfd)
 try:
  mine(dfd)
  try:os.symlink(SHARED,'projects',dir_fd=dfd)
  except FileExistsError:
   if projects_mode(dfd)!='shared':raise SystemExit(5)
 finally:os.close(dfd)
finally:os.close(hfd)
print('ready')`;

/** Run right before a launch is handed back for a non-default login: the login must still be
 * logged in and still share the product's projects directory. Exit 7 = refused. */
const GUARD = COMMON + String.raw`
entry=sys.argv[1] if len(sys.argv)==2 else ''
if not re.fullmatch(r'\.claude-[a-z0-9][a-z0-9-]{0,31}',entry) or entry=='.claude-default':raise SystemExit(2)
hfd=odir(H)
try:
 try:
  shared_root(hfd)
  dfd=odir(entry,hfd)
 except (OSError,SystemExit):raise SystemExit(7)
 try:
  mine(dfd)
  if projects_mode(dfd)!='shared' or not credential(dfd):raise SystemExit(7)
 finally:os.close(dfd)
finally:os.close(hfd)
print('ok')`;

export class BoxProfileDiscoveryError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxProfileDiscoveryError"; }
}

export function makeBoxProfileDiscover(): BoxCcExecRequest {
  return { command: PYTHON, args: ["-I", "-c", DISCOVER], cwd: "/tmp", environment: ENV };
}

export function makeBoxProfilePrepare(profile: string): BoxCcExecRequest {
  if (profile === BOX_DEFAULT_PROFILE || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(profile)) {
    throw new BoxProfileDiscoveryError("BOX_PROFILE_PREPARE_INVALID");
  }
  return { command: PYTHON, args: ["-I", "-c", PREPARE, `.claude-${profile}`],
    cwd: "/tmp", environment: ENV };
}

export function makeBoxProfileGuard(profile: string): BoxCcExecRequest {
  if (profile === BOX_DEFAULT_PROFILE || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(profile)) {
    throw new BoxProfileDiscoveryError("BOX_PROFILE_GUARD_INVALID");
  }
  return { command: PYTHON, args: ["-I", "-c", GUARD, `.claude-${profile}`], cwd: "/tmp", environment: ENV };
}
/** Exit status of the guard script when it refuses a login. */
export const BOX_PROFILE_GUARD_REFUSED = 7;

/** The Box masks emails before they leave it; anything else is refused here too. */
const MASKED_EMAIL = /^[^@\s]\*\*\*@[^@\s]\*\*\*\.[A-Za-z0-9-]{1,7}$/;
export function isMaskedEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && MASKED_EMAIL.test(value);
}

export function parseBoxProfileDiscovery(stdout: string): BoxDiscoveredProfile[] {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { throw new BoxProfileDiscoveryError("BOX_PROFILE_DISCOVERY_INVALID"); }
  if (!Array.isArray(raw) || raw.length > 64) throw new BoxProfileDiscoveryError("BOX_PROFILE_DISCOVERY_INVALID");
  const seen = new Set<string>();
  const out: BoxDiscoveredProfile[] = [];
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== "object") throw new BoxProfileDiscoveryError("BOX_PROFILE_DISCOVERY_INVALID");
    const row = item as Record<string, unknown>;
    const profile = typeof row.dir === "string" ? boxProfileNameFromDirName(row.dir) : null;
    const mode = row.projects;
    const email = row.email, fp = row.fp, org = row.org;
    if (!profile || seen.has(profile) || typeof row.login !== "boolean"
      || (mode !== "root" && mode !== "shared" && mode !== "absent" && mode !== "own")
      || (email !== null && !isMaskedEmail(email))
      || (fp !== null && (typeof fp !== "string" || !/^[0-9a-f]{12}$/.test(fp)))
      || (org !== null && (typeof org !== "string" || !/^[a-z_]{1,24}$/.test(org)))) {
      throw new BoxProfileDiscoveryError("BOX_PROFILE_DISCOVERY_INVALID");
    }
    seen.add(profile);
    out.push({ profile, loginState: row.login ? "logged_in" : "logged_out", projectsMode: mode,
      emailHint: email as string | null, accountFingerprint: fp as string | null,
      orgType: org as string | null });
  }
  return out;
}

export function boxProfileUsable(item: Pick<BoxDiscoveredProfile, "loginState" | "projectsMode">): boolean {
  return item.loginState === "logged_in"
    && (item.projectsMode === "root" || item.projectsMode === "shared");
}
