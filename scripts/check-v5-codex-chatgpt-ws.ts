#!/usr/bin/env tsx
/**
 * Deploy-gate for INC-20260915-CODEX-CHATGPT-WS.
 * Locks: official ChatGPT-auth provider disables Responses websockets;
 * chatgpt.com WS stderr is fatal for webchat; PATH_NOT_ALLOWED stays non-fatal;
 * interrupt recycles the hung app-server instead of reusing it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { buildUpstreamHeaders, CODEX_UPSTREAM_AUTH_HEADER } from '../packages/commercial/src/http/codexUpstreamHeaders.js'

const root = process.cwd()
const shared = readFileSync(join(root, 'packages/gateway/src/engine/codexShared.ts'), 'utf8')
const guard = readFileSync(join(root, 'packages/gateway/src/engine/codexRelayPathGuard.ts'), 'utf8')
const runner = readFileSync(join(root, 'packages/gateway/src/engine/codexAppServerRunner.ts'), 'utf8')
const classify = readFileSync(join(root, 'packages/gateway/src/errorClassify.ts'), 'utf8')

function must(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[codex-chatgpt-ws] ${msg}`)
}

must(
  shared.includes('model_providers.${providerId}.supports_websockets=false'),
  'official_oauth provider must disable supports_websockets',
)
must(
  /requiresOpenaiAuth[\s\S]{0,1200}supports_websockets=false/.test(shared),
  'supports_websockets=false must be gated on requiresOpenaiAuth (official_oauth only)',
)

must(guard.includes('export function isCodexChatgptWebsocketDirectLine'), 'missing WS-direct classifier')
must(guard.includes('wss://chatgpt.com') && guard.includes('codex/responses'), 'classifier must pin chatgpt.com Responses WS')
must(guard.includes('abortWebsocketDirect'), 'tracker must expose abortWebsocketDirect')

must(runner.includes('abortTurnForChatgptWebsocketDirect'), 'runner must abort on chatgpt.com WS')
must(runner.includes('CodexChatgptWebsocketDirectError'), 'missing CodexChatgptWebsocketDirectError')
must(runner.includes('staleProcGeneration'), 'interrupt fence flag missing')
must(runner.includes('recycleProcKeepQueue'), 'recycleProcKeepQueue missing')
must(runner.includes('recycleInflight'), 'recycle must be one-shot / join inflight')
must(runner.includes('keepQueuedTurns'), 'recycle shutdown must keep queued turns')
must(runner.includes("await this.recycleProcKeepQueue('user-cancelled')"), 'USER_CANCELLED must await recycle')
must(
  runner.includes('Intentional recycle/shutdown must not surface SIGTERM as SERVICE_RESTART'),
  'shutdown close must not emit exit for the next turn',
)
must(
  /if \(result\.abortWebsocketDirect\) this\.abortTurnForChatgptWebsocketDirect\(\)/.test(runner),
  'stderr path must abort websocket-direct before PATH_NOT_ALLOWED',
)

must(classify.includes('CODEX_CHATGPT_WS_DIRECT'), 'errorClassify must map CODEX_CHATGPT_WS_DIRECT')
must(classify.includes('Network unreachable'), 'errorClassify must map Network unreachable')

console.log(
  '[codex-chatgpt-ws] PASS — INC-20260915-CODEX-CHATGPT-WS: official provider disables ChatGPT Responses websocket, stderr fail-loud, interrupt recycles hung app-server',
)

// INC-20261019-CODEX-NATIVE-IDENTITY-HEADERS: exercise the relay builder itself.
// These are synthetic headers; no request, account lookup, or upstream call is made.
const nativeIdentityHeaders = buildUpstreamHeaders({
  headers: {
    'session-id': '11111111-1111-4111-8111-111111111111',
    'thread-id': '22222222-2222-4222-8222-222222222222',
    session_id: 'legacy-session',
    conversation_id: 'legacy-conversation',
    'x-codex-turn-state': 'synthetic-turn-state',
    'x-openai-internal-codex-responses-lite': 'true',
    'chatgpt-account-id': 'synthetic-workspace',
    originator: 'codex_cli_rs',
    authorization: 'Bearer synthetic-container-token',
    [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer synthetic-upstream-token',
    'x-openclaude-private-test': 'must-not-leave-relay',
    'x-codex-installation-id': 'must-not-leave-relay',
    'x-unknown-client-header': 'must-not-leave-relay',
    connection: 'keep-alive',
    'proxy-authorization': 'must-not-leave-relay',
    host: 'internal-relay',
    'content-length': '2',
  },
} as IncomingMessage)
assert.equal(nativeIdentityHeaders.get('session-id'), '11111111-1111-4111-8111-111111111111')
assert.equal(nativeIdentityHeaders.get('thread-id'), '22222222-2222-4222-8222-222222222222')
assert.equal(nativeIdentityHeaders.get('session_id'), 'legacy-session')
assert.equal(nativeIdentityHeaders.get('conversation_id'), 'legacy-conversation')
assert.equal(nativeIdentityHeaders.get('x-codex-turn-state'), 'synthetic-turn-state')
assert.equal(nativeIdentityHeaders.get('x-openai-internal-codex-responses-lite'), 'true')
assert.equal(nativeIdentityHeaders.get('chatgpt-account-id'), 'synthetic-workspace')
assert.equal(nativeIdentityHeaders.get('originator'), 'codex_cli_rs')
assert.equal(nativeIdentityHeaders.get('authorization'), 'Bearer synthetic-upstream-token')
assert.equal(nativeIdentityHeaders.get('accept-encoding'), 'identity')
for (const blocked of [
  CODEX_UPSTREAM_AUTH_HEADER, 'x-openclaude-private-test', 'x-codex-installation-id',
  'x-unknown-client-header', 'connection', 'proxy-authorization', 'host', 'content-length',
]) {
  assert.equal(nativeIdentityHeaders.has(blocked), false, `${blocked} must not leave the relay`)
}
console.log(
  '[codex-native-identity-headers] PASS — native session and thread headers survive the relay without changing authentication or private header filtering',
)
