import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { deadline, terminateOwnedTree, trackOwnedTree } from './receiptMasterProcess.fixture.js';
import { withPrivatePg } from './receiptMasterPg.fixture.js';
import { createUserChatBridge, BRIDGE_WS_PATH } from '../../ws/userChatBridge.js';
import { makeCronOriginInjectHandler, CRON_ORIGIN_INJECT_PATH } from '../../http/internalCronOriginInject.js';
import { makeServerAuthoredHandler } from '../../http/internalServerAuthored.js';
import { hashSecret } from '../../auth/containerIdentity.js';
import { signAccess } from '../../auth/jwt.js';
import { AuthoritySigner } from '../../ws/authoritySigner.js';
import { AuthorityKeyCensus } from '../../ws/authorityKeyCensus.js';
import { ModelCatalogSnapshot } from '../../billing/modelCatalog.js';
import { SERVER_AUTHORED_PATH, MODEL_CATALOG_PATH, MODEL_CATALOG_EPOCH_PATH } from '../../../../protocol/src/index.js';
const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
const base = process.env.OC_RECEIPT_MASTER_PROBE_BASE!;
assert.ok(base, 'private artifact base required');
const fixtureBase = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(root + '/package.json');
const { WebSocket } = require('ws');
const dir = mkdtempSync(base + '/full-private-');
mkdirSync(dir + '/container');
mkdirSync(dir + '/home');
writeFileSync(base + '/full-private.path', dir);
const mode = process.argv[2] || 'normal';
let lostResponse = false;
const evidence: any = { mode, dir, frames: [], http: [], childEvents: [], success: false };
async function until(check: any, label: string, ms = 90000) { const end = Date.now() + ms; while (!await check()) {
    if (failure)
        throw failure;
    assert.ok(Date.now() < end, label);
    await new Promise(r => setTimeout(r, 30));
} }
function entry(over: any): any {
    return {
        engine: "ccb",
        providerId: "zhipu",
        upstreamModelId: null,
        contextWindow: 200000,
        capabilityProfile: {
            supportsVision: false,
            reasoning: { supported: ["low", "medium", "high"], codexModelDefault: null },
            ccb: { capabilityZero: true, supportsThinking: true },
        },
        capabilitySchemaVersion: 1,
        state: "active",
        lockVersion: 1,
        ...over,
    } as any;
}
function price(modelId: string): any {
    return {
        modelId,
        displayName: modelId,
        inputPerMtok: 1n,
        outputPerMtok: 2n,
        cacheReadPerMtok: 1n,
        cacheWritePerMtok: 1n,
        multiplier: "1.0",
        visibility: "public",
        sortOrder: 1,
        defaultEffort: null,
    };
}
/**
 * @param auxState 平台次级模型(= 容器 ANTHROPIC_SMALL_FAST_MODEL 的实际取值)在 catalog 里的状态。
 *   'active'   生产形态;'disabled'/'absent' 用来验签发期 fail-closed。
 */
function makeSnapshot(auxState: "active" | "disabled" | "absent" = "active"): ModelCatalogSnapshot {
    const entries: any[] = [
        entry({ entryId: 1, modelId: "glm-5.2" }),
        entry({
            entryId: 2,
            modelId: "gpt-5.6-sol",
            engine: "codex",
            providerId: "codex",
            contextWindow: 400000,
            capabilityProfile: {
                supportsVision: true,
                reasoning: { supported: ["medium", "xhigh"], codexModelDefault: "xhigh" },
                ccb: { capabilityZero: false, supportsThinking: false },
            },
        }),
    ];
    // kimi-k3:角色分档窗口投影(modelRolePolicy)的靶模型 —— 机制窗口 1M,
    // 签发时 admin 原样 / user 收窄 500k(见「角色分档窗口投影」describe)。
    entries.push(entry({
        entryId: 9,
        modelId: "kimi-k3",
        providerId: "moonshot",
        contextWindow: 1048576,
        capabilityProfile: {
            supportsVision: true,
            reasoning: { supported: [], codexModelDefault: null },
            ccb: { capabilityZero: true, supportsThinking: true },
        },
    }));
    // CCB 子 agent 默认钉(glm-5.3-zai)是平台 aux 集第二成员;platformAuxModels 对所有声明
    // 成员 fail-closed,所以夹具必须常驻它 —— 用 auxState 只演练首位成员(deepseek)的缺失/禁用。
    entries.push(entry({
        entryId: 4,
        modelId: 'glm-5.3-zai',
        providerId: "zai",
        contextWindow: 200000,
    }));
    const pricing = new Map([
        ["glm-5.2", price("glm-5.2")],
        ["gpt-5.6-sol", price("gpt-5.6-sol")],
        ["kimi-k3", price("kimi-k3")],
        ['glm-5.3-zai', price('glm-5.3-zai')],
    ]);
    if (auxState !== "absent") {
        entries.push(entry({
            entryId: 3,
            modelId: 'deepseek-v4-flash',
            providerId: "deepseek",
            contextWindow: 1000000,
            ...(auxState === "disabled" ? { state: "disabled" as const } : {}),
        }));
        pricing.set('deepseek-v4-flash', price('deepseek-v4-flash'));
    }
    return new ModelCatalogSnapshot({
        entries,
        // alias:'gpt-latest' → entryId 2(gpt-5.6-sol)。签发必须归一到 canonical。
        aliases: new Map([["gpt-latest", 2]]),
        pricing,
        securityEpoch: 12n,
    });
}
let failure: unknown;
process.once('SIGTERM', () => { failure = new Error('test controller interrupted'); });
await withPrivatePg(async ({ pool, backend, schema }: any) => {
    const uid = 987654321, containerId = 7, secret = 'a'.repeat(64), token = `oc-v3.${containerId}.${secret}`, jwt = 'x'.repeat(32);
    const signer = AuthoritySigner.createEphemeral(), census = new AuthorityKeyCensus(), snapshot = makeSnapshot();
    const identityRepo = { async findActiveByHostAndBoundIp(hostUuid: string, boundIp: string) { if (hostUuid !== 'd13-private-host' || boundIp !== '127.0.0.1')
            return null; return { id: containerId, user_id: uid, host_uuid: hostUuid, bound_ip: boundIp, secret_hash: hashSecret(secret) }; } };
    let bridge: any, child: any, ws: any, containerPort = 0, held: any = null;
    let tracked: ReturnType<typeof trackOwnedTree> | undefined;
    const childLog = createWriteStream(dir + '/container.log');
    const originalQuery = pool.query.bind(pool);
    if (mode === 'accept-blocked') {
        pool.query = async (...args: any[]) => { const [sql, values] = args; if (typeof sql === 'string' && sql.includes("SET status = 'accepted'") && values?.[0] === evidence.heldDispatch && !evidence.lockInstalled) {
            evidence.lockInstalled = true;
            held = await pool.connect();
            await held.query('BEGIN');
            await held.query('SELECT dispatch_id FROM turn_dispatches WHERE dispatch_id=$1 FOR UPDATE', [evidence.heldDispatch]);
        } return originalQuery(...args); };
    }
    const sink = makeServerAuthoredHandler({ identityRepo, storage: backend, losslessTurnTapeStorage: backend } as any);
    const cron = makeCronOriginInjectHandler({ identityRepo, inject: async (input: any) => { const result = await bridge.injectCronOriginTurn(input); const rows = (await pool.query('SELECT status,outcome,client_message_id FROM turn_dispatches WHERE client_message_id=$1', [input.clientMessageId])).rows; evidence.injectResults ??= []; evidence.injectResults.push({ cmid: input.clientMessageId, result, rows }); if (result.kind === 'injected') {
            try {
                assert.equal(rows.length, 1);
                assert.ok(['accepted', 'terminal'].includes(rows[0].status), 'HTTP success needs original durable accept commit');
            }
            catch (e) {
                failure = e;
                throw e;
            }
        } ; return result; } });
    const master = createServer(async (req, res) => {
        const path = req.url;
        res.on('finish', () => evidence.http.push({ path, status: res.statusCode }));
        try {
            const ctx = { hostUuid: 'd13-private-host', boundIp: req.socket.remoteAddress! };
            assert.equal(ctx.boundIp, '127.0.0.1');
            if (path === CRON_ORIGIN_INJECT_PATH) {
                if (mode === 'ack-loss' && !lostResponse) {
                    const end = res.end.bind(res);
                    (res as any).end = (...args: any[]) => { if (res.statusCode === 200) {
                        lostResponse = true;
                        evidence.lostAck = true;
                        res.socket?.destroy();
                        return res;
                    } ; return (end as any)(...args); };
                }
                await cron(req, res, ctx);
                return;
            }
            if (path === SERVER_AUTHORED_PATH) {
                await sink(req, res, ctx);
                return;
            }
            if (mode === 'retry' && (path === MODEL_CATALOG_PATH || path === MODEL_CATALOG_EPOCH_PATH)) {
                assert.equal(req.headers.authorization, 'Bearer ' + token);
                const state = { security_epoch: '12', availability_revision: 'private-d14' };
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(path === MODEL_CATALOG_EPOCH_PATH ? { epoch: state.security_epoch, availability_revision: state.availability_revision } : { ...state,
                  projection_revision: 'private-d14-retry', agent_cost_overrides: {}, models: [
                    { model_id: 'glm-5.3-zai', engine: 'ccb', provider_id: 'zai', context_window: 200000,
                      supported_efforts: ['low','medium','high'], supports_vision: false, capability_zero: true, supports_thinking: true },
                    { model_id: 'gpt-5.6-sol', engine: 'codex', provider_id: 'codex', context_window: 400000,
                      supported_efforts: ['medium','xhigh'], supports_vision: true, capability_zero: false, supports_thinking: false },
                  ] })); return;
            }
            if (path === '/internal/v3/marketplace/sync') {
                assert.equal(req.headers.authorization, 'Bearer ' + token);
                res.end(JSON.stringify({ identityCompat: { schema: 1, userId: String(uid), profiles: [] } }));
                return;
            }
            res.statusCode = 404;
            res.end('{}');
        }
        catch (e) {
            console.error('MASTER_HANDLER', e);
            failure = e;
            res.statusCode = 500;
            res.end('{}');
        }
    });
    try {
        await new Promise<void>(r => master.listen(0, '127.0.0.1', r));
        const masterPort = (master.address() as any).port;
        const childEnv = { PATH: process.env.PATH, HOME: dir + '/home', NODE_ENV: 'test', TEST_ENABLE_SESSION_PERSISTENCE: '1', OPENCLAUDE_HOME: dir + '/container', OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${masterPort}`, OPENCLAUDE_V3_CONTAINER_TOKEN: token, OC_USER_ID: String(uid), OC_CONTAINER_ID: String(containerId), OC_MODEL_AUTHORITY: '1', OC_MODEL_AUTHORITY_KEYRING: signer.publicKeyringEnv(), OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1' };
        child = spawn(process.execPath, ['--import', root + '/node_modules/tsx/dist/loader.mjs', fixtureBase + 'receiptMasterContainer.fixture.ts', dir + '/container', mode], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true });
        tracked = trackOwnedTree(child);
        writeFileSync(base + '/container.pid', String(child.pid));
        child.stdout.pipe(childLog, { end: false });
        child.stderr.pipe(childLog, { end: false });
        let exited = false;
        child.on('exit', (code: any, signal: any) => { exited = true; evidence.childExit = { code, signal }; });
        child.on('error', (e: Error) => { failure = e; });
        child.on('message', (m: any) => { evidence.childEvents.push(m); if (m.type === 'failure')
            failure = new Error(m.failure); if (m.type === 'ready')
            containerPort = m.port; });
        await until(() => { assert.ok(!exited, 'container exited before ready'); return containerPort > 0; }, 'actual Gateway.start readiness', 30000);
        bridge = createUserChatBridge({ jwtSecret: jwt, resolveContainerEndpoint: async () => ({ host: '127.0.0.1', port: containerPort, containerId }), modelAuthority: { signer, catalog: { peek: () => snapshot, current: () => snapshot, assertFresh: async () => snapshot }, readSecurityEpoch: async () => 12n, census, recycleContainer: (_id: any, reason: any) => { throw Error('unexpected recycle: ' + reason); } }, pgPool: pool, preCheckRedis: { atomicReserve: async () => { throw Error('CCB must not call Codex reservation'); }, release: async () => { throw Error('no Codex release'); } }, pricing: { get: () => undefined }, admitUserTurn: async (input: any) => { try {
                const result = await backend.admitUserTurn(input);
                if (mode === 'accept-blocked' && input.clientMessageId.startsWith('dlgcb-') && result.kind === 'admitted' && !held) {
                    evidence.heldDispatch = result.dispatch.dispatchId;
                }
                return result;
            }
            catch (e) {
                console.error('REAL_ADMIT_ERROR', e);
                throw e;
            } }, loadMasterSessionMessages: async (_uid: any, id: string) => { const row = await backend.getClientSession(id, 'c:' + uid); return row?.messages ?? null; }, hasCompletedClientTurn: backend.hasCompletedClientTurn?.bind(backend) } as any);
        master.on('upgrade', (req, socket, head) => { if (!bridge.handleUpgrade(req, socket, head))
            socket.destroy(); });
        const access = await signAccess({ sub: String(uid), role: 'admin' }, jwt);
        ws = new WebSocket(`ws://127.0.0.1:${masterPort}${BRIDGE_WS_PATH}`, ['bearer', access.token]);
        ws.on('message', (raw: any) => { try {
            const f = JSON.parse(String(raw));
            evidence.frames.push(f);
            console.log('BROWSER', JSON.stringify(f).slice(0, 300));
        }
        catch { } });
        await once(ws, 'open');
        ws.send(JSON.stringify({ type: 'inbound.message', channel: 'webchat', peer: { id: 'd13-probe', kind: 'dm' }, agentId: 'main', clientMessageId: 'd13-parent-cmid', content: { text: 'Run the one synthetic child command and finish the parent.' }, model: 'glm-5.3-zai', ts: Date.now() }));
        await until(() => { assert.ok(!exited, 'container exited before parent settled'); assert.ok(!evidence.frames.some((f: any) => f.type === 'error'), JSON.stringify(evidence.frames)); return evidence.childEvents.some((m: any) => m.type === 'parent-settled'); }, 'actual parent dispatch settled');
        const first = (await pool.query('SELECT dispatch_id,status,outcome,client_message_id FROM turn_dispatches ORDER BY admitted_at')).rows;
        evidence.parentDispatches = first;
        console.log('PARENT_SETTLED', JSON.stringify(first));
        child.send({ type: 'release-child' });
        if (mode === 'accept-blocked') {
            await until(() => evidence.childEvents.some((m: any) => m.type === 'notify-finished' && m.rows.some((r: any) => r.state !== 'notified')), 'no success ACK while original accepted CAS blocked', 90000);
            const rows = (await pool.query('SELECT status FROM turn_dispatches WHERE dispatch_id=$1', [evidence.heldDispatch])).rows;
            assert.equal(rows[0].status, 'admitted');
            evidence.beforeAck = { status: rows[0].status, notified: false, events: evidence.childEvents.filter((m: any) => m.type === 'notify-finished') };
            await held.query('ROLLBACK');
            held.release();
            held = null;
        }
        await until(async () => { const rows = (await pool.query('SELECT dispatch_id,status,outcome,client_message_id FROM turn_dispatches ORDER BY admitted_at')).rows; evidence.dispatches = rows; return rows.length === (mode === 'ingested' ? 1 : 2) && rows.every((r: any) => r.status === 'terminal'); }, 'two actual PG terminal dispatches', 90000);
        if (mode === 'ack-loss' || mode === 'accept-blocked') {
            await until(() => evidence.injectResults?.length >= 2, 'original notify retry response', 90000);
            child.send({ type: 'watch-notified' });
            await until(() => evidence.childEvents.some((m: any) => m.type === 'notified-proof'), 'original receipt marked notified after actual ACK', 90000);
        }
        if (mode === 'retry') await until(() => evidence.childEvents.some((m: any) => m.type === 'retry-notified'), 'new retry target actual ACK and replay proof');
        const session = await backend.getClientSession('d13-probe', 'c:' + uid);
        evidence.persistedSession = session;
        assert.ok(JSON.stringify(session).includes(mode === 'ingested' ? 'D13_PARENT_INGESTED_FINAL' : 'D13_CALLBACK_MODEL_FINAL'), 'actual model final persisted');
        if (mode === 'ingested')
            assert.equal(evidence.injectResults?.length || 0, 0, 'ingested source must never callback');
        if (failure)
            throw failure;
        evidence.success = true;
        process.stdout.write('D13_FULL_PASS\n');
    }
    finally {
        const cleanupErrors: unknown[] = [];
        const clean = async (work: () => Promise<unknown>) => { try {
            await work();
        }
        catch (e) {
            cleanupErrors.push(e);
        } };
        await clean(async () => { if (held) {
            try {
                await held.query('ROLLBACK');
            }
            finally {
                held.release();
                held = null;
            }
        } });
        await clean(async () => { ws?.terminate(); await deadline(Promise.resolve(bridge?.shutdown()), 10000, 'bridge cleanup deadline'); });
        await clean(async () => {
            if (child && child.exitCode === null && child.signalCode === null) {
                const closed = once(child, 'close');
                if (child.connected)
                    child.send({ type: 'stop' });
                try {
                    await deadline(closed, 10000, 'container cleanup deadline');
                }
                finally {
                    await terminateOwnedTree(child, tracked?.known);
                }
            }
            if (child) {
                assert.equal(child.exitCode, 0, 'container cleanup must finish without failure');
                assert.equal(child.signalCode, null);
            }
        });
        await clean(async () => { if(child) await terminateOwnedTree(child, tracked?.known); tracked?.stop(); });
        await clean(async () => { master.closeAllConnections(); await new Promise<void>((resolve, reject) => master.close(e => e ? reject(e) : resolve())); });
        await clean(async () => { childLog.end(); await once(childLog, 'finish'); });
        if (cleanupErrors.length)
            failure = new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'D13 cleanup failed');
        if (failure) {
            evidence.success = false;
            evidence.failure = String(failure);
        }
        writeFileSync(dir + '/master-evidence.json', JSON.stringify(evidence, null, 2));
        if (failure)
            throw failure;
    }
}).catch(e => { console.error(e); process.exitCode = 1; });
