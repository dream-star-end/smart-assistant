/** Deterministic executor-result seam; real query, SQLite coordinator and native
 * writer/recovery. The actual Bash/CLI/HTTP mixed-tool proof is a separate fixture. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, rename, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { query } from '../query.js'
import { getEmptyToolPermissionContext } from '../Tool.js'
import { StreamingToolExecutor } from '../services/tools/StreamingToolExecutor.js'
import { createUserMessage } from '../utils/messages.js'
import { bindReceiptInput, createDeferredReceiptInput } from '../utils/receiptInputAdmission.js'
import { openReceiptDelivery } from '../utils/receiptSqlite.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { getSessionId, resetStateForTests, setCwdState, setOriginalCwd, setProjectRoot } from '../bootstrap/state.js'
import { clearSessionMessagesCache, flushSessionStorage, getProjectDir, getTranscriptPath,
  recordTranscript, resetProjectForTesting, observeStrictReceiptInput } from '../utils/sessionStorage.js'
import { resetCommandQueue } from '../utils/messageQueueManager.js'
import type { Message } from '../types/message.js'
import type { TrustedReceiptBinding } from '../../../packages/storage/src/receiptDeliveryCoordinator.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const keys = ['CLAUDE_CONFIG_DIR', 'TEST_ENABLE_SESSION_PERSISTENCE', 'CLAUDE_CODE_DISABLE_ATTACHMENTS']
let dir: string, old: (string | undefined)[], restoreSpy: (() => void) | undefined
beforeEach(async () => {
  old = keys.map(k => process.env[k]); dir = await mkdtemp(join(tmpdir(), 'receipt-batch-'))
  process.env.CLAUDE_CONFIG_DIR = dir; process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'; process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS = '1'
  resetStateForTests(); resetCommandQueue(); setOriginalCwd(dir); setCwdState(dir); setProjectRoot(dir)
  getProjectDir.cache.clear?.(); clearSessionMessagesCache(); resetProjectForTesting()
})
afterEach(async () => {
  restoreSpy?.(); restoreSpy = undefined; await flushSessionStorage(); resetProjectForTesting(); resetCommandQueue()
  keys.forEach((k, i) => { if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i] })
  await rm(dir, { recursive: true, force: true })
})

for (const mode of ['normal', 'abort', 'notify-loser', 'bad-candidate', 'copied-canonical', 'write-failure', 'oracle-normal', 'oracle-abort'] as const) {
  test(`receipt batch ${mode}: late ordinary tool cannot cut acknowledged native inputs off recovery`, async () => {
    const oracleFault = mode === 'oracle-normal' || mode === 'oracle-abort'
    const dbPath = join(dir, 'jobs.db')
    const bindings: TrustedReceiptBinding[] = JSON.parse(execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', `
      import {createHash} from 'node:crypto';
      import {DelegateDurableDb} from './packages/gateway/src/delegateDurable.ts';
      import {DelegateJobStore} from './packages/gateway/src/delegateJobs.ts';
      const db=new DelegateDurableDb(${JSON.stringify(dbPath)});
      const jobs=new DelegateJobStore({durable:db,sm:true,deliveryReceipts:true});const rows=[];
      for(let i=0;i<2;i++) {
        const made=jobs.create('worker',{callback:'stdout-wait',callbackOriginUserId:'3',parentSessionKey:'parent',
          deliveryReceipt:{parentTurnKey:'turn',nativeToolUseId:'bash-batch',receiptNonceHash:createHash('sha256').update('nonce-'+i).digest('hex')}});
        if(!('jobId' in made))throw Error('fixture admission');const snap=jobs.snapshotOf(made.jobId);
        if(!jobs.complete(made.jobId,{httpStatus:200,body:{output:'BATCH_RESULT_'+i}},
          {claimToken:snap.claimToken,fencingEpoch:snap.fencingEpoch}))throw Error('fixture complete');
        rows.push(db.getDeliveryReceipt(made.jobId,0));
      }
      process.stdout.write(JSON.stringify(rows));jobs.close();
    `], { cwd: root, env: { PATH: process.env.PATH!, HOME: dir, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30000 }))
    const delivery = await openReceiptDelivery(dbPath)
    const db = new Database(dbPath, { readwrite: true, create: false })
    try {
      if (mode === 'notify-loser') expect(await delivery.recover(bindings[0]!, async () => ({ kind: 'absent' }), async () => 'inactive')).toBe('notify_ready')
      if (mode === 'write-failure') db.exec("CREATE TRIGGER fail_ack BEFORE UPDATE OF state ON delegate_delivery_receipt WHEN NEW.state='ingested' BEGIN SELECT RAISE(ABORT,'batch ACK fault'); END")
      let state: any = { toolPermissionContext: getEmptyToolPermissionContext(), fastMode: false, mcp: { tools: [], clients: [] }, sessionHooks: new Map() }
      let inProgress = new Set<string>()
      const abort = new AbortController()
      const ctx: any = {
        options: { commands: [], debug: false, mainLoopModel: 'claude-sonnet-4-5-20250929', tools: [], verbose: false,
          thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
          agentDefinitions: { activeAgents: [], allowedAgentTypes: [] } },
        abortController: abort, readFileState: new Map(), getAppState: () => state, setAppState: (fn: any) => { state = fn(state) },
        setInProgressToolUseIDs: (fn: any) => { inProgress = fn(inProgress) }, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {}, messages: [],
      }
      const assistant: any = { type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: {
        id: 'one-assistant-batch', type: 'message', role: 'assistant', model: 'synthetic',
        content: [{ type: 'tool_use', id: 'bash-batch', name: 'Bash', input: {} }, { type: 'tool_use', id: 'late-read', name: 'Read', input: {} }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }
      const realAdd = StreamingToolExecutor.prototype.addTool
      const spy = spyOn(StreamingToolExecutor.prototype, 'addTool').mockImplementation(function (this: StreamingToolExecutor, block, message) {
        realAdd.call(this, block, message)
        const tool = (this as any).tools.find((t: any) => t.id === block.id)
        tool.results = [createUserMessage({ content: [{ type: 'tool_result', tool_use_id: block.id, content: block.id === 'late-read' ? 'ORDINARY_READ_RESULT' : 'ORDINARY_BASH_RESULT' }], sourceToolAssistantUUID: assistant.uuid })]
        if (block.id === 'bash-batch') for (const [i, binding] of bindings.entries()) {
          tool.results.push(createDeferredReceiptInput(async () => {
            if (i === 0 && mode === 'bad-candidate') throw Error('candidate HTTP unavailable')
            const canonical = createUserMessage({ content: [{ type: 'text', text: `BATCH_RESULT_${i}` }] })
            bindReceiptInput(canonical, { marker: { jobId: binding.jobId, generation: binding.generation, resultDigest: binding.resultDigest },
              ingest: (proof, write, oracle) => delivery.ingest(binding, { proof, parentOwnerEpoch: 'fixture-active-epoch', isCurrentParentOwner: async () => true }, write, async () => {
                if (!oracleFault || i !== 0) return oracle()
                // Actual one-shot native open failure: the strict bytes have
                // already been written and synced. O_NOFOLLOW must reject this
                // temporary symlink; restore the SAME file before releasing the
                // receipt barrier. No mock oracle/state/ACK or production I/O.
                const file = getTranscriptPath(), held = file + '.oracle-held'
                await rename(file, held)
                try {
                  await symlink(held, file)
                  try {
                    const observation = await oracle()
                    expect(observation.kind).toBe('unknown')
                    return observation
                  } finally { await unlink(file) }
                } finally { await rename(held, file) }
              }) })
            return i === 0 && mode === 'copied-canonical' ? { ...canonical } : canonical
          }))
        }
        if (block.id === 'late-read' && (mode === 'abort' || mode === 'oracle-abort')) abort.abort('test-completed-before-drain')
      })
      restoreSpy = () => spy.mockRestore()
      const first = createUserMessage({ content: 'batch recovery proof' })
      const history: Message[] = [first]; let calls = 0, failure: unknown
      try {
        for await (const message of query({ messages: [first], systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
          canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }), toolUseContext: ctx, querySource: 'sdk', maxTurns: 1,
          deps: { uuid: randomUUID, microcompact: async (messages: Message[]) => ({ messages }), autocompact: async () => ({ compactionResult: undefined, consecutiveFailures: 0 }),
            callModel: async function* () { calls++; yield assistant } } as any })) {
          if (['user', 'assistant', 'system'].includes(message.type)) { history.push(message as Message); await recordTranscript(history) }
        }
      } catch (error) { failure = error }
      await flushSessionStorage()
      expect(calls).toBe(1) // no next model request/assistant to repair a broken chain
      const rows: any[] = db.query('SELECT job_id,state,native_tool_use_id,receipt_nonce_hash FROM delegate_delivery_receipt ORDER BY rowid').all()
      const child = Bun.spawn([process.execPath, '-e', `
        import {loadFullLog} from ${JSON.stringify(new URL('../utils/sessionStorage.ts', import.meta.url).pathname)};
        const log=await loadFullLog({isLite:true,sessionId:${JSON.stringify(getSessionId())},fullPath:${JSON.stringify(getTranscriptPath())},messages:[],date:'',value:0,created:new Date(),modified:new Date(),firstPrompt:'',messageCount:6,isSidechain:false});
        process.stdout.write(JSON.stringify(log.messages));
      `], { env: { PATH: process.env.PATH!, HOME: dir, CLAUDE_CONFIG_DIR: dir, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' })
      const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect({ exit, err }).toEqual({ exit: 0, err: '' })
      const restored: any[] = JSON.parse(out)
      for (let i = 0; i < 2; i++) {
        const expected = mode === 'write-failure' || oracleFault ? Number(i === 0) : (i === 0 && ['notify-loser', 'bad-candidate', 'copied-canonical'].includes(mode)) ? 0 : 1
        expect(restored.filter(m => m.type === 'user' && JSON.stringify(m.message).includes(`BATCH_RESULT_${i}`))).toHaveLength(expected)
      }
      expect(JSON.stringify(restored)).toContain('ORDINARY_READ_RESULT')
      expect(JSON.stringify(restored)).toContain('ORDINARY_BASH_RESULT')
      if (mode === 'write-failure') expect(String(failure)).toContain('batch ACK fault')
      else if (oracleFault) expect(String(failure)).toContain('receipt input outcome uncertain: unknown')
      else expect(failure).toBeUndefined()
      expect(rows.map(r => r.state)).toEqual(mode === 'notify-loser' ? ['notify_pending', 'ingested'] :
        mode === 'bad-candidate' || mode === 'copied-canonical' ? ['offered', 'ingested'] : mode === 'write-failure' || oracleFault ? ['ingest_claimed', 'offered'] : ['ingested', 'ingested'])
      rows.forEach((row, i) => { expect(row.native_tool_use_id).toBe('bash-batch'); expect(row.receipt_nonce_hash).toBe(bindings[i]!.receiptNonceHash) })
      if (oracleFault) {
        expect(await delivery.recover(bindings[0]!, claim => observeStrictReceiptInput(claim.proof), async () => 'active')).toBe('ingested')
        expect(db.query('SELECT state FROM delegate_delivery_receipt ORDER BY rowid').all()).toEqual([{ state: 'ingested' }, { state: 'offered' }])
      }
      const callback: any[] = db.query('SELECT callback_state FROM delegate_jobs ORDER BY rowid').all()
      expect(callback.map(r => r.callback_state)).toEqual(mode === 'notify-loser' ? ['pending', 'none'] : ['none', 'none'])
    } finally { delivery.close(); db.close() }
  }, 90000)
}
