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
Object.assign(process.env, { OPENCLAUDE_HOME: dir, OPENCLAUDE_DELEGATE_JOBS_DB: join(dir, 'delegate-jobs.db'), OC_DELEGATE_SM: '1', OC_DELEGATE_DURABLE: '1', OC_DELEGATE_NOTIFIER: '1', CLAUDE_CONFIG_DIR: join(dir, 'native'), OPENCLAUDE_RECEIPT_CALLER_V2: '1', ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`, ANTHROPIC_API_KEY: 'synthetic-local-only', ANTHROPIC_AUTH_TOKEN: 'synthetic-local-only', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_ATTACHMENTS: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_UNATTENDED_RETRY: '0', CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1', NPM_CONFIG_OFFLINE: 'true' });
mkdirSync(join(dir, 'native'), { recursive: true });
const { Gateway } = await import(root + '/packages/gateway/src/server.ts');
const { upsertClientSession } = await import(root + '/packages/storage/src/sessionsDb.ts');
await upsertClientSession({ id: 'd13-probe', userId: 'default', agentId: 'main', title: 'synthetic d13', pinned: false, createdAt: 1000, lastAt: 1000, updatedAt: 1000, messages: [] });
const token = randomBytes(32).toString('hex');
writeFileSync(join(dir, 'token'), token, { mode: 0o600 });
process.env.OPENCLAUDE_GATEWAY_TOKEN_FILE = join(dir, 'token');
const config: any = { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: token }, auth: { mode: 'subscription', claudeCodePath: join(root, 'claude-code-best'), claudeCodeEntry: 'scripts/dev.ts' }, sessions: { dbPath: join(dir, 'sessions.db') }, defaults: { model: 'glm-5.3-zai', permissionMode: 'bypassPermissions' }, channels: { webchat: { enabled: true } }, terminal: { type: 'local' } };
const gw: any = new Gateway({ config, agentsConfig: { agents: [{ id: 'main', model: 'glm-5.3-zai', cwd: dir, permissionMode: 'bypassPermissions' }], routes: [], default: 'main' } } as any);
gw._delegateDurablePath = join(dir, 'delegate-jobs.db');
const jobs = gw._ensureDelegateJobStore();
assert.equal(jobs.acceptsDeliveryReceipts, false);
Object.defineProperty(jobs, 'acceptsDeliveryReceipts', { get: () => true });
const terminalWork: Promise<any>[] = [];
const dispatch = gw._dispatchDelegateNotify.bind(gw);
gw._dispatchDelegateNotify = (job: any) => { const work = dispatch(job); terminalWork.push(work); work.then(() => send({ type: 'notify-finished', rows: jobs.durable.db.prepare('SELECT job_id,state FROM delegate_delivery_receipt').all() }), () => { }); return work; };
gw._readDelegateMemoryPressure = () => null;
gw._runDelegateTask = async (input: any) => { executions++; const claim = jobs.claimQueued(input.backgroundJobId); assert.ok(claim.ok); input.claimToken = claim.claimToken; input.fencingEpoch = claim.fencingEpoch; if (mode === 'ingested')
    releaseChild(); await gate; gw._releasePreadmittedDelegateCapacity(input); return { kind: 'completed', ok: true, output: sentinel, sessionKey: input.sessionKey }; };
let stopped = false;
async function stop() { if (stopped)
    return; stopped = true; releaseChild(); const settled = await Promise.allSettled(terminalWork); for (const result of settled)
    if (result.status === 'rejected')
        failure = String(result.reason); const rows = jobs.durable.db.prepare('SELECT * FROM delegate_delivery_receipt').all(); const sessions = gw.sessions.list(); try {
    await gw.shutdown(false);
}
catch (e) {
    failure = String(e);
} ; upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); writeFileSync(join(dir, 'container-evidence.json'), JSON.stringify({ executions, mainRequests, callbackModels, requestLog, failure, rows, sessions }, null, 2)); if (failure)
    process.exitCode = 1; process.disconnect?.(); }
process.on('message', (m: any) => { if (m.type === 'watch-notified')
    void until(() => jobs.durable.db.prepare('SELECT state FROM delegate_delivery_receipt').all().some((r: any) => r.state === 'notified'), 'receipt final ACK').then(() => send({ type: 'notified-proof', rows: jobs.durable.db.prepare('SELECT job_id,state FROM delegate_delivery_receipt').all() })).catch(e => { failure = String(e); send({ type: 'failure', failure }); }); if (m.type === 'release-child')
    releaseChild(); if (m.type === 'stop')
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
