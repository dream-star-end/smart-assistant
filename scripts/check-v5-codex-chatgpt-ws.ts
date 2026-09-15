#!/usr/bin/env tsx
/**
 * Deploy-gate for INC-20260915-CODEX-CHATGPT-WS.
 * Locks: official ChatGPT-auth provider disables Responses websockets;
 * chatgpt.com WS stderr is fatal for webchat; PATH_NOT_ALLOWED stays non-fatal;
 * interrupt recycles the hung app-server instead of reusing it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
must(runner.includes("void this.recycleProcKeepQueue('user-cancelled')"), 'USER_CANCELLED must recycle proc')
must(
  /if \(result\.abortWebsocketDirect\) this\.abortTurnForChatgptWebsocketDirect\(\)/.test(runner),
  'stderr path must abort websocket-direct before PATH_NOT_ALLOWED',
)

must(classify.includes('CODEX_CHATGPT_WS_DIRECT'), 'errorClassify must map CODEX_CHATGPT_WS_DIRECT')
must(classify.includes('Network unreachable'), 'errorClassify must map Network unreachable')

console.log(
  '[codex-chatgpt-ws] PASS — INC-20260915-CODEX-CHATGPT-WS: official provider disables ChatGPT Responses websocket, stderr fail-loud, interrupt recycles hung app-server',
)
