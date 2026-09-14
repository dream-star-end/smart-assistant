import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePool, holdCommercialMutex } from './receiptMasterPgTransport.fixture.js';
import { createPgSessionsBackend } from '../../db/pgSessionsBackend.js';
import { setPoolOverride, resetPool } from '../../db/index.js';
const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
export async function withPrivatePg(action: any) {
    const schema = 'oc_receipt_d13_' + randomBytes(8).toString('hex');
    const evidence: any = { schema, migrations: [], checks: [], writesStarted: false, cleaned: false };
    let release: any, admin: any, pool: any, created = false;
    async function migration(name: string) {
        const sql = readFileSync(join(root, 'packages/commercial/src/db/migrations', name + '.sql'), 'utf8');
        assert.ok(!/CREATE\s+EXTENSION|DROP\s+SCHEMA|CREATE\s+SCHEMA|SET\s+(?:LOCAL\s+)?search_path|ALTER\s+ROLE|GRANT\s/i.test(sql), 'migration escapes isolated closure: ' + name);
        // Existing triggers call the preinstalled pgcrypto hash function. This is a
        // read-only exact function exception, NOT a public-qualified DDL exception.
        const qualifiers = sql.match(/public\.[A-Za-z_]+/gi) || [];
        assert.ok(qualifiers.every(x => x === 'public.digest'));
        evidence.migrations.push({ name, sha256: createHash('sha256').update(sql).digest('hex'), publicFunctions: qualifiers });
        await pool.query(sql);
    }
    try {
        release = await holdCommercialMutex();
        evidence.checks.push('original commercial kernel mutex verified');
        admin = makePool();
        const ext = (await admin.query("SELECT e.extname,p.prosecdef,p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_depend d ON d.objid=p.oid AND d.deptype='e' JOIN pg_extension e ON e.oid=d.refobjid WHERE n.nspname='public' AND p.proname='digest' AND p.proargtypes='17 25'::oidvector")).rows;
        assert.equal(ext.length, 1);
        assert.equal(ext[0].extname, 'pgcrypto');
        assert.equal(ext[0].prosecdef, false);
        assert.equal(ext[0].provolatile, 'i');
        evidence.checks.push('preinstalled public.digest(bytea,text) is immutable non-security-definer pgcrypto function');
        await admin.query('CREATE SCHEMA ' + schema);
        created = true;
        evidence.writesStarted = true;
        pool = makePool(schema);
        setPoolOverride(pool);
        evidence.checks.push('all original global getPool consumers pinned to same verified real scoped PG pool');
        for (const m of ['0066_wechat_pointer_outbox_audit', '0078_wechat_outbox_backoff_hol', '0134_sessions_master_pg', '0147_lossless_turn_tapes', '0159_goal_state', '0157_lossless_runtime_batches'])
            await migration(m);
        // Same unrelated billing placeholders as the established sessions integ.
        await pool.query('CREATE TABLE request_finalize_journal(request_id TEXT PRIMARY KEY);CREATE TABLE usage_records(id BIGSERIAL PRIMARY KEY,user_id BIGINT,request_id TEXT);CREATE TABLE turn_traces(trace_id TEXT PRIMARY KEY)');
        for (const m of ['0170_durable_turn_dispatch', '0173_client_session_model', '0175_client_session_history_revision', '0176_direct_turn_timeline', '0177_unified_client_timeline'])
            await migration(m);
        await pool.query('CREATE TABLE users(id BIGINT PRIMARY KEY);INSERT INTO users VALUES(987654321)');
        for (const m of ['0046_inbox_messages', '0167_turn_waiver_receipts', '0111_init_orgs', '0181_turn_tape_recovery_links', '0185_authority_turn_dispatches', '0196_client_session_workspace_mode', '0201_durable_live_turn_frames', '0202_turn_recovery_control', '0228_turn_visible_finalize', '0229_turn_finalize_integrity', '0230_chat_projects', '0231_turn_tape_materialization_resilience', '0233_client_session_list_archived_at', '0239_turn_dispatch_shutdown_ctx', '0240_client_session_last_read_at', '0241_raise_last_read_watermark', '0243_live_unit_checkpoints', '0246_chat_project_board_bind'])
            await migration(m);
        // Established sessions fixture's unrelated container/workspace compatibility scaffolding;
        // no production migration is rewritten and no billing behavior is claimed.
        await pool.query("CREATE TABLE agent_containers(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL,state TEXT NOT NULL,runtime_kind TEXT NOT NULL DEFAULT 'docker');ALTER TABLE turn_dispatches ADD COLUMN agent_container_id BIGINT REFERENCES agent_containers(id) ON DELETE RESTRICT;ALTER TABLE turn_dispatches ADD COLUMN runtime_kind TEXT;ALTER TABLE chat_projects ADD COLUMN is_research_default BOOLEAN NOT NULL DEFAULT FALSE");
        await pool.query("INSERT INTO sessions_store_migration_state(singleton,authority,generation,cutover_id,source_digest,completed_at)VALUES(true,'pg_authoritative',1,'test-cutover','test-digest',$1)", [Date.now()]);
        await pool.query("INSERT INTO client_sessions(id,user_id,agent_id,title,pinned,created_at,last_at,messages,message_count,updated_at)VALUES('d13-probe','c:987654321','main','private receipt probe',0,1,1,'[]',0,1)");
        await pool.query("INSERT INTO agent_containers(id,user_id,state,runtime_kind)VALUES(7,987654321,'running','docker')");
        const backend = createPgSessionsBackend(pool, { expectedGeneration: 1 });
        await pool.query("UPDATE client_sessions SET model_id='glm-5.3-zai'");
        await action({ pool, backend, evidence, schema });
    }
    catch (e) {
        evidence.failure = String(e);
        process.exitCode = 1;
        console.error(e);
        throw e;
    }
    finally {
        const errors: unknown[] = [];
        const cleanup = async (work: () => Promise<unknown>) => { try {
            await work();
        }
        catch (e) {
            errors.push(e);
        } };
        await cleanup(async () => { if (pool)
            await resetPool(); });
        await cleanup(async () => { if (created) {
            await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
            evidence.cleaned = true;
        } });
        await cleanup(async () => { if (admin)
            await admin.end(); });
        await cleanup(async () => { if (release)
            await release(); });
        if (errors.length) {
            evidence.cleanupFailure = errors.map(String).join('; ');
            process.exitCode = 1;
        }
        writeFileSync(join(process.env.OC_RECEIPT_MASTER_PROBE_BASE!, 'pg-full-evidence.json'), JSON.stringify(evidence, null, 2));
        if (errors.length)
            throw new AggregateError(errors, 'private PG cleanup failed');
    }
}
