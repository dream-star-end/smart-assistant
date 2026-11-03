/** Authenticated admission and attempt-before-effect around the existing UID-local tools. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type AuthorityKeyring, assertLeaseMatchesAuthority, verifyAuthority, verifyTurnLease } from '@openclaude/protocol'
import { assertCc5BindingScope, cc5AuthorityMatchesBinding, type Cc5BridgeBinding } from './cc5BridgePort.js'
import { exclusiveRecord, privateDir, readRecord, syncDir, type Cc5ObservedTool, type Cc5ToolRequest } from './cc5FixedTool.js'
import { CC5_TOOL_RECEIPT_MAX_BYTES, assertCc5ToolResult, boundCc5ToolResult, cc5ToolInputSha256,
  cc5ToolScopeHash, validateCc5NativeToolInput,
  type Cc5ToolAdmission, type Cc5ToolReceipt, type Cc5ToolResult } from './cc5NativeTool.js'

export class Cc5NativeToolExecutor {
  constructor(private readonly binding: Readonly<Cc5BridgeBinding>, private readonly keyring: AuthorityKeyring,
    private readonly executeTool: (request: Cc5ToolRequest) => Promise<Cc5ToolResult>, private readonly root: string) {
    assertCc5BindingScope(binding)
  }
  async execute(raw: Cc5ToolRequest, observed: Cc5ObservedTool, admission: Cc5ToolAdmission): Promise<Cc5ToolReceipt> {
    const request = structuredClone(raw)
    const actual = structuredClone(observed)
    const expected = structuredClone(admission)
    const now = Date.now()
    const authority = verifyAuthority(request.authority, this.keyring, now, { allowExpired: true })
    assertLeaseMatchesAuthority(verifyTurnLease(request.lease, this.keyring, now), authority)
    const reject = () => { throw new Error('CC5_NATIVE_TOOL_SCOPE_REJECTED') }
    if (this.binding.expiresAt <= now || !cc5AuthorityMatchesBinding(this.binding, authority) ||
      request.uid !== this.binding.uid || request.containerDbId !== this.binding.containerDbId ||
      request.dockerId !== this.binding.dockerId || request.operationId !== this.binding.operationId ||
      request.sessionKey !== this.binding.sessionKey || request.turnKey !== expected.turnKey ||
      authority.authorityTurnId !== expected.authorityTurnId || authority.connectionChallenge !== expected.connectionChallenge ||
      authority.securityEpoch !== expected.securityEpoch || !/^[a-f0-9-]{36}$/i.test(request.nativeSessionId) ||
      typeof request.toolUseId !== 'string' || !request.toolUseId || request.toolUseId.length > 65536 ||
      !((typeof request.rpcId === 'string' && request.rpcId.length > 0 && request.rpcId.length <= 256) ||
        (typeof request.rpcId === 'number' && Number.isSafeInteger(request.rpcId))) || request.rpcId === request.toolUseId ||
      actual.nativeSessionId !== request.nativeSessionId || actual.toolUseId !== request.toolUseId || actual.name !== request.name) reject()
    validateCc5NativeToolInput(request.name, request.arguments)
    validateCc5NativeToolInput(actual.name, actual.input)
    if (cc5ToolInputSha256(actual.input) !== cc5ToolInputSha256(request.arguments)) reject()
    const scopeHash = cc5ToolScopeHash(request, expected)
    privateDir(this.root)
    syncDir(dirname(this.root))
    const op = join(this.root, this.binding.operationId)
    privateDir(op)
    const path = join(op, createHash('sha256').update(request.toolUseId).digest('hex'))
    privateDir(path)
    const completed = join(path, 'receipt.json')
    if (existsSync(completed)) {
      const receipt = readRecord(completed, CC5_TOOL_RECEIPT_MAX_BYTES) as Cc5ToolReceipt
      if (receipt.version !== 2 || receipt.scopeHash !== scopeHash) reject()
      assertCc5ToolResult(receipt.result)
      return receipt
    }
    const commandId = randomUUID()
    try {
      exclusiveRecord(join(path, 'attempt.json'), { version: 2, scopeHash, commandId, attemptedAt: now })
      syncDir(path)
      syncDir(op)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('CC5_NATIVE_TOOL_EXECUTION_UNKNOWN')
      throw error
    }
    const result = boundCc5ToolResult(await this.executeTool(request))
    assertCc5ToolResult(result)
    const receipt: Cc5ToolReceipt = {
      version: 2, scopeHash, commandId, dockerId: request.dockerId, containerDbId: request.containerDbId,
      operationId: request.operationId, nativeSessionId: request.nativeSessionId, toolUseId: request.toolUseId,
      rpcId: request.rpcId, name: request.name, inputSha256: cc5ToolInputSha256(request.arguments),
      result: structuredClone(result), completedAt: Date.now(),
    }
    const staged = join(path, `complete-${commandId}.json`)
    exclusiveRecord(staged, receipt)
    try { linkSync(staged, completed) } finally { unlinkSync(staged) }
    syncDir(path)
    return receipt
  }
}
