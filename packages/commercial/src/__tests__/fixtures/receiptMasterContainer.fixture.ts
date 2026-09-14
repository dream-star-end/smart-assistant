import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
const mode = process.argv[3] || 'normal';
const dir = process.argv[2];
assert.ok(dir && dir === process.env.OPENCLAUDE_HOME, 'private container root must equal explicit runtime root');
const sentinel = 'D13_REAL_CHILD_RESULT', final = 'D13_CALLBACK_MODEL_FINAL';
let releaseChild!: () => void;
const gate = new Promise<void>(r => releaseChild = r);
let executions = 0, mainRequests = 0, callbackModels = 0;
let retryEvidence: any;
let retrySourceJobId: string | undefined;
const requestLog: any[] = [];
let failure: string | undefined;
const send = (message: any) => process.send?.(message);
async function until(check: any, label: string, ms = 90000) { const end = Date.now() + ms; while (!check()) {
    assert.ok(Date.now() < end, label);
    await new Promise(r => setTimeout(r, 25));
} }
function reply(res: any, body: any, content: any[]) {
    const message = { id: 'msg_' + randomBytes(8).toString('hex'), type: 'message', role: 'assistant', model: body.model, content, stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
    if (!body.stream) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(message));
        return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const emit = (event: string, data: any) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
    for (const [index, c] of content.entries()) {
        emit('content_block_start', { type: 'content_block_start', index, content_block: c.type === 'tool_use' ? { ...c, input: {} } : { type: 'text', text: '' } });
        emit('content_block_delta', { type: 'content_block_delta', index, delta: c.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } : { type: 'text_delta', text: c.text } });
        emit('content_block_stop', { type: 'content_block_stop', index });
    }
    emit('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
    emit('message_stop', { type: 'message_stop' });
    res.end();
}
const upstream = createServer(async (req, res) => {
    try {
        let raw = '';
        for await (const c of req)
            raw += c;
        const body = JSON.parse(raw || '{}');
        assert.ok(req.headers['x-api-key'] === 'synthetic-local-only' || req.headers.authorization === 'Bearer synthetic-local-only');
        if (req.url?.includes('count_tokens')) {
            res.end(JSON.stringify({ input_tokens: 100 }));
            return;
        }
        assert.ok(req.url?.startsWith('/v1/messages'));
        const main = body.tools?.some((t: any) => t.name === 'Bash');
        requestLog.push({ url: req.url, model: body.model, main, hasResult: raw.includes(sentinel) });
        if (!main) {
            reply(res, body, [{ type: 'text', text: 'aux' }]);
            return;
        }
        mainRequests++;
        if (raw.includes(sentinel)) {
            if (mode === 'ingested') {
                assert.equal(mainRequests, 2);
                writeFileSync(join(dir, 'ingested-messages.json'), JSON.stringify(body.messages, null, 2));
                reply(res, body, [{ type: 'text', text: 'D13_PARENT_INGESTED_FINAL' }]);
                return;
            }
            callbackModels++;
            assert.equal(callbackModels, 1, 'one actual callback model request');
            writeFileSync(join(dir, 'callback-messages.json'), JSON.stringify(body.messages, null, 2));
            reply(res, body, [{ type: 'text', text: final }]);
            return;
        }
        if (mode === 'retry' && mainRequests === 1) {
            reply(res, body, [{ type: 'tool_use', id: 'd14_retry_source_creator', name: 'Bash', input: { command: `node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate --agent-id retry-worker --model gpt-5.6-sol --goal synthetic-d14-initial-failure`, timeout: 20000 } }]);
            return;
        }
        if (mainRequests === 1) {
            reply(res, body, [{ type: 'tool_use', id: 'd13_real_creator', name: 'Bash', input: { command: `node --import ${root}/node_modules/tsx/dist/loader.mjs ${root}/packages/mcp-memory/src/ocMemoryCli.ts delegate --agent-id coding-assistant --goal synthetic-d13-child`, timeout: 20000, run_in_background: mode !== 'ingested' } }]);
            return;
        }
        await until(() => executions === 1, 'real create before parent ends', 25000);
        reply(res, body, [{ type: 'text', text: 'D13_PARENT_DONE' }]);
    }
    catch (e) {
        failure = String(e);
        console.error('UPSTREAM_FAILURE', e);
        res.statusCode = 500;
        res.end('{}');
    }
});
await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
const upstreamAddress = upstream.address();
assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
const upstreamPort = upstreamAddress.port;
Object.assign(process.env, { OPENCLAUDE_HOME: dir, OPENCLAUDE_DELEGATE_JOBS_DB: join(dir, 'delegate-jobs.db'), OC_DELEGATE_SM: '1', OC_DELEGATE_DURABLE: '1', OC_DELEGATE_NOTIFIER: '1', CLAUDE_CONFIG_DIR: join(dir, 'native'), OPENCLAUDE_RECEIPT_CALLER_V2: mode === 'retry' ? '0' : '1', ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`, ANTHROPIC_API_KEY: 'synthetic-local-only', ANTHROPIC_AUTH_TOKEN: 'synthetic-local-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_ATTACHMENTS: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_UNATTENDED_RETRY: '0', CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1', NPM_CONFIG_OFFLINE: 'true' });
mkdirSync(join(dir, 'native'), { recursive: true });
if (mode === 'retry') {
  process.env.CODEX_HOME = join(dir, 'codex-native');
  // Explicit private selfhost fixture, not a change to commercial local-turn policy.
  process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1';
}
const { Gateway } = await import(root + '/packages/gateway/src/server.ts');
const { upsertClientSession } = await import(root + '/packages/storage/src/sessionsDb.ts');
await upsertClientSession({ id: 'd13-probe', userId: 'default', agentId: 'main', ...(mode === 'retry' ? { modelId: 'glm-5.3-zai' } : {}), title: 'synthetic d13', pinned: false, createdAt: 1000, lastAt: 1000, updatedAt: 1000, messages: [] });
const token = randomBytes(32).toString('hex');
writeFileSync(join(dir, 'token'), token, { mode: 0o600 });
process.env.OPENCLAUDE_GATEWAY_TOKEN_FILE = join(dir, 'token');
const config: any = { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: token }, auth: { mode: 'subscription', claudeCodePath: join(root, 'claude-code-best'), claudeCodeEntry: 'scripts/dev.ts' }, sessions: { dbPath: join(dir, 'sessions.db') }, defaults: { model: 'glm-5.3-zai', permissionMode: 'bypassPermissions' }, channels: { webchat: { enabled: true } }, terminal: { type: 'local' } };
const testAgents: any[] = [{ id: 'main', model: 'glm-5.3-zai', cwd: dir, permissionMode: 'bypassPermissions' }];
if (mode === 'retry') testAgents.push({ id: 'retry-worker', model: 'gpt-5.6-sol', provider: 'codex-native', cwd: dir });
const gw: any = new Gateway({ config, agentsConfig: { agents: testAgents, routes: [], default: 'main' } } as any);
if (mode === 'retry') writeFileSync(join(dir, 'agents.yaml'), JSON.stringify({ agents: testAgents, routes: [], default: 'main' }));
gw._delegateDurablePath = join(dir, 'delegate-jobs.db');
const jobs = gw._ensureDelegateJobStore();
assert.equal(jobs.acceptsDeliveryReceipts, false);
Object.defineProperty(jobs, 'acceptsDeliveryReceipts', { get: () => true });
const terminalWork: Promise<any>[] = [];
const dispatch = gw._dispatchDelegateNotify.bind(gw);
gw._dispatchDelegateNotify = (job: any) => { const work = dispatch(job); terminalWork.push(work); work.then(() => send({ type: 'notify-finished', rows: jobs.durable.db.prepare('SELECT job_id,state FROM delegate_delivery_receipt').all() }), () => { }); return work; };
gw._readDelegateMemoryPressure = () => null;
const originalRetry = gw._retryUserDelegate.bind(gw);
gw._retryUserDelegate = async (...args: any[]) => { try { return await originalRetry(...args); } catch (e) { writeFileSync(join(dir, 'retry-error.json'), JSON.stringify({error:String(e),stack:(e as Error).stack},null,2)); throw e; } };
gw._runDelegateTask = async (input: any) => { executions++; const claim = jobs.claimQueued(input.backgroundJobId); assert.ok(claim.ok); input.claimToken = claim.claimToken; input.fencingEpoch = claim.fencingEpoch;
    if (mode === 'retry' && !input.retrySource) { retrySourceJobId = input.backgroundJobId; gw._delegateResume.release(input.sessionKey); gw._releasePreadmittedDelegateCapacity(input); return { kind: 'rejected', status: 503, failureClass: 'internal', message: 'PRIVATE_INITIAL_CHILD_FAILURE' }; }
    if (mode === 'ingested')
    releaseChild(); await gate; if (mode === 'retry') { assert.ok(input.retrySource); assert.equal(input.requireNativeResume?.engine, 'codex'); gw._delegateResume.release(input.sessionKey); } gw._releasePreadmittedDelegateCapacity(input); return { kind: 'completed', ok: true, output: sentinel, sessionKey: input.sessionKey }; };
let stopped = false;
async function stop() { if (stopped)
    return; stopped = true; releaseChild(); const settled = await Promise.allSettled(terminalWork); for (const result of settled)
    if (result.status === 'rejected')
        failure = String(result.reason); const rows = jobs.durable.db.prepare('SELECT * FROM delegate_delivery_receipt').all(); const sessions = gw.sessions.list(); try {
    await gw.shutdown(false);
}
catch (e) {
    failure = String(e);
} ; upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); writeFileSync(join(dir, 'container-evidence.json'), JSON.stringify({ executions, mainRequests, callbackModels, requestLog, failure, rows, sessions, retryEvidence }, null, 2)); if (failure)
    process.exitCode = 1; process.disconnect?.(); }
/** Real model CLI captures source; native enrollment is private fixture. User POST, acceptance, claim, terminal and all
 * notifications are real. Child execution remains D13's explicit gated fixture,
 * NOT actual Codex CLI/model/billing (covered separately by retry HTTP tests). */
async function startRetry() {
    assert.equal(mode, 'retry'); assert.equal(retryEvidence, undefined);
    const parentKey = 'agent:main:webchat:dm:d13-probe';
    await until(() => retrySourceJobId && jobs.snapshotOf(retrySourceJobId)?.callbackState === 'skipped_silent' &&
      gw.sessions.getByKey(parentKey)?._currentTurnKey === undefined && gw.sessions.getByKey(parentKey)?._activeTurnCount === 0, 'initial failure actual CLI consumption and parent settlement');
    const parent = gw.sessions.getByKey(parentKey);
    const identity = { sessionKey: parent?.sessionKey, localUserId: parent?.userId,
      expectedApiUserId: 'c:' + process.env.OC_USER_ID, expectedSource: 'authenticated master user fixture',
      actualSource: 'original Gateway.dispatchInbound -> SessionManager', modelRequests: mainRequests };
    writeFileSync(join(dir, 'retry-identity.json'), JSON.stringify(identity, null, 2));
    assert.ok(parent && typeof parent.userId === 'string', JSON.stringify(identity));
    assert.equal(parent._currentTurnKey, undefined); assert.equal(parent._activeTurnCount, 0);
    assert.ok(retrySourceJobId, 'source was created through actual model CLI and original HTTP capture');
    const created = { jobId: retrySourceJobId };
    const source = jobs.getRetrySource(identity.expectedApiUserId, created.jobId, 0);
    assert.equal(source?.userId, identity.expectedApiUserId); assert.equal(source?.storageUserId, parent.userId);
    assert.equal(source?.parentSessionKey, parentKey);
    const childKey = source.childSessionKey;
    const nativeId = '11111111-2222-4333-8444-555555555555';
    const artifactDir = join(process.env.CODEX_HOME!, 'sessions/2026/01/01');
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, `rollout-private-${nativeId}.jsonl`), '{"private":true}\n');
    gw.sessions._resumeMap.set(childKey, nativeId); gw.sessions._resumeMapProvider.set(childKey, 'codex');
    const child = await gw.sessions.getOrCreate({ sessionKey: childKey, agent: testAgents[1], model: 'gpt-5.6-sol',
      executionAuthority: { canonicalModel: 'gpt-5.6-sol', engine: 'codex', source: 'local_catalog' },
      channel: 'delegate', peerId: 'main', parentSessionKey: parentKey, userId: parent.userId,
      workspaceMode: parent.workspaceMode, requireNativeResume: { engine: 'codex', nativeSessionId: nativeId } });
    let unexpectedSpawns = 0;
    child.runner.kernel.constructor.prototype.ensureSpawned = async () => { unexpectedSpawns++; throw Error('PRIVATE_RETRY_MASTER_NATIVE_SPAWN_FORBIDDEN'); };
    const { signJwt } = await import(root + '/packages/gateway/src/auth.ts');
    const auth = 'Bearer ' + signJwt({ userId: identity.expectedApiUserId, exp: Math.floor(Date.now()/1000) + 90 }, token);
    const url = `http://127.0.0.1:${config.gateway.port}/api/delegates/inbox/${created.jobId}/retry`;
    const key = { userId: identity.expectedApiUserId, sourceJobId: created.jobId, generation: 0, actionId: 'private-master-retry-action-0001' };
    const post = async () => { const r = await fetch(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ generation: 0, actionId: key.actionId }) }); return { status: r.status, body: await r.json() as any }; };
    const beforeRetryRequests = mainRequests;
    const accepted = await post(), replay = await post();
    writeFileSync(join(dir, 'retry-http-identity.json'), JSON.stringify({ identity, accepted, replay }, null, 2));
    assert.equal(accepted.status, 202, JSON.stringify(accepted)); assert.equal(replay.status, 200, JSON.stringify(replay));
    assert.equal(accepted.body.jobId, replay.body.jobId); assert.notEqual(accepted.body.jobId, created.jobId);
    assert.equal(jobs.hasDeliveryReceiptEnrollment(accepted.body.jobId), false);
    assert.equal(executions, 2); assert.equal(unexpectedSpawns, 0);
    retryEvidence = { beforeRetryRequests, sourceJobId: created.jobId, target: accepted.body.jobId, key, accepted, replay, unexpectedSpawns,
      source, boundary: 'original signed parent model CLI creates source; native enrollment and two child executions fixture; actual user HTTP/action/claim/terminal/master ACK/callback model' };
    releaseChild();
    await until(() => jobs.snapshotOf(accepted.body.jobId)?.callbackState === 'delivered', 'new retry original durable notification ACK');
    retryEvidence.action = jobs.getRetryAction(key); retryEvidence.terminal = jobs.snapshotOf(accepted.body.jobId);
    assert.equal(retryEvidence.action.state, 'terminal'); assert.equal(retryEvidence.terminal.callbackState, 'delivered');
    assert.equal(jobs.userFailureInbox(identity.expectedApiUserId).items.some((r: any) => r.jobId === created.jobId), true, 'retry never ACKs old failure');
    const late = await post(); assert.equal(late.status, 200); assert.equal(late.body.jobId, accepted.body.jobId);
    assert.equal(executions, 2); send({ type: 'retry-notified', retryEvidence });
}
process.on('message', (m: any) => { if (m.type === 'watch-notified')
    void until(() => jobs.durable.db.prepare('SELECT state FROM delegate_delivery_receipt').all().some((r: any) => r.state === 'notified'), 'receipt final ACK').then(() => send({ type: 'notified-proof', rows: jobs.durable.db.prepare('SELECT job_id,state FROM delegate_delivery_receipt').all() })).catch(e => { failure = String(e); send({ type: 'failure', failure }); }); if (m.type === 'release-child')
    mode === 'retry' ? void startRetry().catch(e => { failure = String(e); send({ type: 'failure', failure }); }) : releaseChild(); if (m.type === 'stop')
    void stop().catch(e => { console.error(e); process.exitCode = 1; process.disconnect?.(); }); if (m.type === 'snapshot')
    send({ type: 'snapshot', executions, mainRequests, callbackModels, sessions: gw.sessions.list() }); });
process.once('SIGTERM', () => void stop());
await gw.start();
assert.equal(gw._durableTurnDispatchReady, true, 'only original boot recovery may enable durable capability');
const port = gw.httpServer.address().port;
config.gateway.port = port;
process.env.OPENCLAUDE_GATEWAY_PORT = String(port);
send({ type: 'ready', port });
void (async () => { try {
    await until(() => gw.sessions.list().some((s: any) => { const live = gw.sessions.getByKey(s.sessionKey); return s.turns >= 1 && live?._currentTurnKey === undefined && live?._activeTurnCount === 0; }), 'parent actual settlement');
    const parent = gw.sessions.list()[0];
    send({ type: 'parent-settled', parent, executions });
}
catch (e) {
    failure = String(e);
    send({ type: 'failure', failure });
} })();
