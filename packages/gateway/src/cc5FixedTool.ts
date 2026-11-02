/** Sole task tool for t1576u. Runs a fixed proof in the NEW execution container. */
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type AuthorityKeyring,
  assertLeaseMatchesAuthority,
  verifyAuthority,
  verifyTurnLease,
} from '@openclaude/protocol'
import { type Cc5BridgeBinding, assertCc5BindingScope, cc5AuthorityMatchesBinding } from './cc5BridgePort.js'

export const CC5_FIXED_TOOL_NAME = 'mcp__ocbridge__roundtrip'
export const CC5_FIXED_EXECUTION_ROOT = '/home/agent/.openclaude/.cc5-t1555u'
export interface Cc5ObservedTool {
  nativeSessionId: string
  toolUseId: string
  name: string
  input: unknown
}
export interface Cc5ToolRequest {
  uid: string
  containerDbId: string
  dockerId: string
  operationId: string
  sessionKey: string
  turnKey: string
  nativeSessionId: string
  toolUseId: string
  rpcId: string | number
  name: string
  arguments: unknown
  authority: string
  lease: string
}
export interface Cc5FixedToolReceipt {
  version: 1
  scopeHash: string
  commandId: string
  dockerId: string
  containerDbId: string
  operationId: string
  nativeSessionId: string
  toolUseId: string
  rpcId: string | number
  marker: string
  pid: number
  exitCode: 0
  stdout: string
  fileSha256: string
  completedAt: number
}
function requireTool(ok: unknown): asserts ok {
  if (!ok) throw new Error('CC5_FIXED_TOOL_REJECTED')
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function fixedInput(value: unknown, operationId: string): string {
  requireTool(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      (value as { operationId?: unknown }).operationId === operationId,
  )
  return hash(JSON.stringify({ operationId }))
}
function syncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function privateDir(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
  const st = lstatSync(path)
  requireTool(st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0)
}
function readRecord(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    requireTool(
      st.isFile() &&
        st.nlink === 1 &&
        st.uid === process.getuid?.() &&
        (st.mode & 0o077) === 0 &&
        st.size > 0 &&
        st.size <= 131072,
    )
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally {
    closeSync(fd)
  }
}
function exclusiveRecord(path: string, value: unknown): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const FIXED_SCRIPT = [
  'set -eu',
  'printf "%s\\n" "$1" >&3',
  'printf "CWD="; pwd',
  'printf "UID="; id -u',
  'printf "PIDNS="; readlink /proc/self/ns/pid',
  'printf "CONTENT="; cat cc5-proof.txt',
  'printf "SHA256="; sha256sum cc5-proof.txt',
].join('\n')

function fixedCommand(cwd: string, marker: string): Promise<{ pid: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const proofFd = openSync(
      join(cwd, 'cc5-proof.txt'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    const child = spawn('/bin/sh', ['-c', FIXED_SCRIPT, 'cc5-fixed-proof', marker], {
      cwd,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', proofFd],
    })
    closeSync(proofFd)
    let output = ''
    let size = 0
    let unknown = false
    let closed = false
    const kill = (): void => {
      unknown = true
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }
    }
    const timer = setTimeout(kill, 10000)
    const terminalTimer = setTimeout(() => {
      if (!closed) reject(new Error('CC5_FIXED_TOOL_EXIT_UNKNOWN'))
    }, 15000)
    child.stdout!.on('data', (b: Buffer) => {
      size += b.length
      if (size > 65536) kill()
      else output += b.toString('utf8')
    })
    child.stderr!.on('data', (b: Buffer) => {
      size += b.length
      if (size > 65536) kill()
    })
    child.once('error', () => {
      clearTimeout(timer)
      clearTimeout(terminalTimer)
      reject(new Error('CC5_FIXED_TOOL_SPAWN_UNKNOWN'))
    })
    child.once('close', (code, signal) => {
      closed = true
      clearTimeout(timer)
      clearTimeout(terminalTimer)
      if (unknown || signal || code !== 0 || !child.pid)
        return reject(new Error('CC5_FIXED_TOOL_EXIT_UNKNOWN'))
      resolve({ pid: child.pid, stdout: output })
    })
  })
}

export class Cc5FixedToolExecutor {
  constructor(
    private readonly binding: Readonly<Cc5BridgeBinding>,
    private readonly sessionKey: string,
    private readonly keyring: AuthorityKeyring,
    private readonly admission: Readonly<{
      turnKey: string
      authorityTurnId: string
      connectionChallenge: string
      securityEpoch: number
    }>,
    private readonly executionRoot = CC5_FIXED_EXECUTION_ROOT,
  ) {
    assertCc5BindingScope(binding)
    requireTool(sessionKey === binding.sessionKey)
    this.admission = Object.freeze({ ...admission })
  }
  async execute(raw: Cc5ToolRequest, observed: Cc5ObservedTool): Promise<Cc5FixedToolReceipt> {
    // All signed/input fields are captured before mkdir, polling or any await.
    const request = structuredClone(raw)
    const actual = structuredClone(observed)
    const now = Date.now()
    const a = verifyAuthority(request.authority, this.keyring, now, { allowExpired: true })
    const lease = verifyTurnLease(request.lease, this.keyring, now)
    assertLeaseMatchesAuthority(lease, a)
    requireTool(
      this.binding.expiresAt > now &&
        request.uid === this.binding.uid &&
        request.containerDbId === this.binding.containerDbId &&
        request.dockerId === this.binding.dockerId &&
        request.operationId === this.binding.operationId &&
        request.sessionKey === this.sessionKey &&
        cc5AuthorityMatchesBinding(this.binding, a) &&
        request.turnKey === this.admission.turnKey &&
        a.authorityTurnId === this.admission.authorityTurnId &&
        a.connectionChallenge === this.admission.connectionChallenge &&
        a.securityEpoch === this.admission.securityEpoch &&
        /^[a-f0-9-]{36}$/i.test(request.nativeSessionId) &&
        typeof request.toolUseId === 'string' &&
        request.toolUseId.length > 0 &&
        request.toolUseId.length < 65536 &&
        ((typeof request.rpcId === 'string' &&
          request.rpcId.length > 0 &&
          request.rpcId.length <= 256) ||
          (typeof request.rpcId === 'number' && Number.isSafeInteger(request.rpcId))) &&
        request.rpcId !== request.toolUseId &&
        request.name === CC5_FIXED_TOOL_NAME &&
        actual.nativeSessionId === request.nativeSessionId &&
        actual.toolUseId === request.toolUseId &&
        actual.name === request.name,
    )
    const inputHash = fixedInput(request.arguments, request.operationId)
    requireTool(fixedInput(actual.input, request.operationId) === inputHash)
    const scopeHash = hash(
      JSON.stringify({
        uid: request.uid,
        containerDbId: request.containerDbId,
        dockerId: request.dockerId,
        operationId: request.operationId,
        sessionKey: request.sessionKey,
        turnKey: request.turnKey,
        nativeSessionId: request.nativeSessionId,
        toolUseId: request.toolUseId,
        rpcId: request.rpcId,
        name: request.name,
        inputHash,
        authorityTurnId: a.authorityTurnId,
        connectionChallenge: a.connectionChallenge,
        securityEpoch: a.securityEpoch,
      }),
    )
    privateDir(this.executionRoot)
    // Persist the newly-created root entry before any journal or command effect.
    syncDir(dirname(this.executionRoot))
    const work = join(this.executionRoot, request.operationId)
    privateDir(work)
    const receiptPath = join(work, 'receipt.json')
    if (existsSync(receiptPath)) {
      const old = readRecord(receiptPath) as Cc5FixedToolReceipt
      requireTool(old.version === 1 && old.scopeHash === scopeHash && old.exitCode === 0)
      return old
    }
    const marker = `CC5_CONTAINER_${randomBytes(16).toString('hex')}`
    const commandId = randomUUID()
    try {
      exclusiveRecord(join(work, 'attempt.json'), {
        version: 1,
        scopeHash,
        commandId,
        marker,
        attemptedAt: now,
      })
      syncDir(work)
      syncDir(this.executionRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('CC5_FIXED_TOOL_DELIVERY_UNKNOWN')
      throw error
    }
    const result = await fixedCommand(work, marker)
    const expected = hash(`${marker}\n`)
    const fd = openSync(
      join(work, 'cc5-proof.txt'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const st = fstatSync(fd)
      requireTool(
        st.isFile() &&
          st.nlink === 1 &&
          st.size === Buffer.byteLength(`${marker}\n`) &&
          readFileSync(fd, 'utf8') === `${marker}\n`,
      )
    } finally {
      closeSync(fd)
    }
    requireTool(
      result.stdout.includes(`CONTENT=${marker}\n`) &&
        result.stdout.includes(`SHA256=${expected}  cc5-proof.txt\n`) &&
        result.stdout.includes(`CWD=${work}\n`) &&
        /UID=[0-9]+\n/.test(result.stdout) &&
        /PIDNS=pid:\[[0-9]+\]\n/.test(result.stdout),
    )
    const receipt: Cc5FixedToolReceipt = {
      version: 1,
      scopeHash,
      commandId,
      dockerId: request.dockerId,
      containerDbId: request.containerDbId,
      operationId: request.operationId,
      nativeSessionId: request.nativeSessionId,
      toolUseId: request.toolUseId,
      rpcId: request.rpcId,
      marker,
      pid: result.pid,
      exitCode: 0,
      stdout: result.stdout,
      fileSha256: expected,
      completedAt: Date.now(),
    }
    const staging = join(work, `complete-${randomUUID()}.json`)
    exclusiveRecord(staging, receipt)
    try {
      linkSync(staging, receiptPath)
    } finally {
      unlinkSync(staging)
    }
    syncDir(work)
    return receipt
  }
}
