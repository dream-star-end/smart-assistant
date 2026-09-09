/** Run only as the exclusive operator of this host authDir, after verifying the
 * account's Box. No bearer is accepted on argv or written to the policy. */
import { constants, openSync, closeSync, fsyncSync, fchmodSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, copyFileSync, realpathSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseCursorSandBoxPolicy } from '../../packages/gateway/src/engine/cursorSandBox.js'

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const HEX = /^[0-9a-f]{64}$/
function read(path: string, limit: number): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('UNSAFE_INPUT_FILE')
  return readFileSync(path)
}
function syncFile(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
export function configurePolicy(opts: {
  authDir: string; accountId: string; expectedTokenSha256: string; expectedMachineSha256: string; apply?: boolean;
}): Record<string, unknown> {
  if (!/^[1-9][0-9]{0,19}$/.test(opts.accountId) || !HEX.test(opts.expectedTokenSha256) || !HEX.test(opts.expectedMachineSha256)) throw new Error('INVALID_ARGUMENT')
  const root = realpathSync(opts.authDir)
  const activePath = join(root, '.pool-active')
  const generation = read(activePath, 128).toString().trim()
  if (!/^gen-[0-9a-f]{24}$/.test(generation)) throw new Error('INVALID_GENERATION')
  const dir = join(root, '.pool-generations', generation)
  if (realpathSync(dir) !== dir) throw new Error('UNSAFE_GENERATION_PATH')
  const rows = read(join(dir, '.slot-identities'), 16384).toString().split('\n').filter(l => l && !l.startsWith('#')).map(l => l.trim().split(/\s+/))
  const matches = rows.filter(r => r[1] === opts.accountId)
  if (matches.length !== 1) throw new Error('ACCOUNT_NOT_UNIQUE_IN_ACTIVE_GENERATION')
  const [slot, , fingerprint, sand] = matches[0]
  if (!/^api-key(?:\.(?:[2-9]|[1-9][0-9]+))?$/.test(slot) || sand !== '1') throw new Error('NOT_SAND_SLOT')
  const kinds = read(join(dir, '.credential-kind'), 16384).toString().split('\n').filter(l => l && !l.startsWith('#')).map(l => l.trim().split(/\s+/)).filter(r => r[0] === slot)
  if (kinds.length !== 1 || kinds[0][1] !== 'session') throw new Error('NOT_SESSION_SLOT')
  const machine = kinds[0][2]
  if (!machine || hash(machine) !== opts.expectedMachineSha256) throw new Error('MACHINE_BINDING_CHANGED')
  const raw = read(join(dir, slot), 4096)
  let token = ''
  try {
    token = raw.toString('utf8').replace(/[\r\n]+$/, '')
    if (/\s/.test(token) || hash(token) !== opts.expectedTokenSha256 || hash(token + '\n').slice(0, 16) !== fingerprint) throw new Error('TOKEN_BINDING_CHANGED')
    let claims: Record<string, unknown>
    try { claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) }
    catch { throw new Error('INVALID_SESSION_CLAIMS') }
    if (!claims || claims.type !== 'session' || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512 || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error('INVALID_SESSION_CLAIMS')
    const target = join(root, '.sand-box-policy.json')
    let previous: Buffer | null = null
    try { previous = read(target, 16384) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    const policy = previous ? parseCursorSandBoxPolicy(JSON.parse(previous.toString())) : { version: 1 as const, accounts: [] }
    const entry = { accountId: opts.accountId, subjectHash: hash(claims.sub), machineHash: hash(machine) }
    const existing = policy.accounts.find(e => e.accountId === opts.accountId)
    if (existing?.subjectHash === entry.subjectHash && existing.machineHash === entry.machineHash) return { accountId: opts.accountId, changed: false, generation }
    policy.accounts = [...policy.accounts.filter(e => e.accountId !== opts.accountId), entry]
    const payload = JSON.stringify(policy, null, 2) + '\n'
    if (Buffer.byteLength(payload) > 16384) throw new Error('POLICY_TOO_LARGE')
    if (!opts.apply) return { accountId: opts.accountId, changed: false, wouldChange: true, generation }
    if (read(activePath, 128).toString().trim() !== generation) throw new Error('ACTIVE_GENERATION_CHANGED')
    const stage = join(root, `.sand-box-policy.stage-${process.pid}-${randomBytes(6).toString('hex')}`)
    const fd = openSync(stage, 'wx', 0o600)
    try {
      try { writeFileSync(fd, payload); fchmodSync(fd, 0o600); fsyncSync(fd) } finally { closeSync(fd) }
      if (previous) {
        const backup = `${target}.backup-${hash(previous).slice(0, 16)}`
        try { copyFileSync(target, backup, constants.COPYFILE_EXCL) }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
        if (!read(backup, 16384).equals(previous)) throw new Error('BACKUP_MISMATCH')
        const backupFd = openSync(backup, 'r'); try { fchmodSync(backupFd, 0o600); fsyncSync(backupFd) } finally { closeSync(backupFd) }
        syncFile(root)
      }
      if (read(activePath, 128).toString().trim() !== generation) throw new Error('ACTIVE_GENERATION_CHANGED')
      const current = (() => { try { return read(target, 16384) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e } })()
      if (current?.toString() !== previous?.toString()) throw new Error('POLICY_CHANGED_BY_ANOTHER_WRITER')
      renameSync(stage, target)
      syncFile(root)
    } finally { try { unlinkSync(stage) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e } }
    return { accountId: opts.accountId, changed: true, generation, policySha256: hash(payload) }
  } finally { raw.fill(0); token = '' }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  try {
    const a = process.argv.slice(2); const map = new Map<string, string>(); let apply = false
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '--apply') { apply = true; continue }
      if (!['--auth-dir', '--account-id', '--expected-token-sha256', '--expected-machine-sha256'].includes(a[i]) || !a[i + 1] || map.has(a[i])) throw new Error('INVALID_ARGUMENT')
      map.set(a[i], a[++i])
    }
    console.log(JSON.stringify(configurePolicy({ authDir: map.get('--auth-dir') ?? '', accountId: map.get('--account-id') ?? '', expectedTokenSha256: map.get('--expected-token-sha256') ?? '', expectedMachineSha256: map.get('--expected-machine-sha256') ?? '', apply })))
  } catch (e) {
    // Do not print input paths, claims, token contents or a native exception stack.
    const code = e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'POLICY_CONFIGURATION_FAILED'
    console.error(code); process.exitCode = 1
  }
}
