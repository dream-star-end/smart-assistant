import { readFileSync } from 'node:fs';
// Private test transport: original pg protocol over the authorized host channel.
// No SQL/result RPC, listeners, install, service or production config changes.
import { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../../package.json', import.meta.url));
const { Pool, Client } = require('pg');
import assert from 'node:assert/strict';
const remote = `const net=require('node:net');const s=net.connect({host:'127.0.0.1',port:55432});s.on('connect',()=>{process.stdin.pipe(s);s.pipe(process.stdout)});s.on('error',(e)=>{process.stderr.write(e.code+'\\n');process.exitCode=1});process.stdin.on('end',()=>s.end());process.stdout.on('error',()=>s.destroy());`;
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
export class HostPgWire extends Duplex {
    child: any;
    stderr = '';
    connect(port: number, host: string) {
        if (port !== 55432 || host !== '127.0.0.1')
            throw Error('test PG endpoint rejected');
        this.child = spawn('host', ['node -e ' + quote(remote)], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.child.stdout.on('data', (b: Buffer) => { if (!this.push(b))
            this.child.stdout.pause(); });
        this.child.stdout.on('end', () => this.push(null));
        this.child.stderr.on('data', (b: Buffer) => { this.stderr += b.toString(); });
        this.child.on('error', (e: Error) => this.destroy(e));
        this.child.on('close', (code: number | null) => { if (code && !this.destroyed)
            this.destroy(Error('PG transport closed: ' + this.stderr));
        else if (!this.destroyed)
            this.destroy(); });
        process.nextTick(() => this.emit('connect'));
        return this;
    }
    _read() { this.child?.stdout.resume(); }
    _write(b: any, e: any, cb: any) { this.child.stdin.write(b, e, cb); }
    _final(cb: any) { this.child.stdin.end(cb); }
    _destroy(e: any, cb: any) { this.child?.stdin.destroy(); if (this.child?.exitCode === null)
        this.child.kill('SIGTERM'); cb(e); }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
    ref() { this.child?.ref(); return this; }
    unref() { this.child?.unref(); return this; }
}
export async function holdCommercialMutex() {
    if (process.env.OC_RECEIPT_TEST_HOST_PG !== '1') {
        // Do not trust a caller's boolean env flag: prove a live ancestor's actual FD lock.
        let pid = process.ppid, found = false;
        while (pid > 1) {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
            if (command.some(v => v.endsWith('/test-mutex.sh')) && command.includes('commercial')) {
                const fd = readFileSync(`/proc/${pid}/fdinfo/9`, 'utf8');
                assert.match(fd, /lock:.*FLOCK\s+ADVISORY\s+WRITE/, 'commercial ancestor does not hold original kernel lock');
                found = true;
                break;
            }
            pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        }
        assert.ok(found, 'direct PG test must run under original test-mutex.sh commercial');
        return async () => { };
    }
    const child = spawn('host', ["cd /opt/openclaude/openclaude-v5-selfhost && OC_TEST_MUTEX_TIMEOUT=300 bash scripts/test-mutex.sh commercial " + quote("node -e " + quote("process.stdout.write('MUTEX_READY\\n');process.stdin.resume();"))], { stdio: ['pipe', 'pipe', 'pipe'] });
    let log = '';
    child.stderr.on('data', (b: Buffer) => { log += b; });
    const closed = new Promise(r => child.once('close', (code: number | null) => r(code)));
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { child.stdin.end(); reject(Error('commercial mutex not obtained: ' + log)); }, 30000); child.stdout.on('data', (b: Buffer) => { log += b; if (log.includes('MUTEX_READY')) {
        clearTimeout(timer);
        resolve();
    } }); child.once('error', (e: Error) => { clearTimeout(timer); reject(e); }); child.once('close', (code: number | null) => { clearTimeout(timer); reject(Error('mutex keeper closed ' + code + ': ' + log)); }); });
    let released = false;
    return async () => { if (released)
        return; released = true; child.stdin.end(); assert.equal(await closed, 0, 'original test-mutex keeper exit'); };
}
export function makePool(schema?: string) {
    if (schema !== undefined && !/^oc_receipt_d13_[a-f0-9]{16}$/.test(schema))
        throw Error('test schema rejected');
    class ScopedClient extends (Client as any) {
        connect(cb?: any) {
            const ready = super.connect().then(async () => {
                const { rows: [r] } = await super.query("SELECT current_database() db,current_user usr,host(inet_server_addr()) addr,inet_server_port() port,current_schemas(false)::text[] schemas");
                assert.equal(r.db, 'openclaude_test');
                assert.equal(r.usr, 'test');
                assert.equal(r.addr, '127.0.0.1');
                assert.equal(r.port, 55432);
                assert.deepEqual(r.schemas, schema ? [schema] : ['public']);
            });
            if (cb) {
                ready.then(() => cb(), (e: any) => { this.end().catch(() => { }); cb(e); });
            }
            else
                return ready;
        }
    }
    return new Pool({ Client: ScopedClient, host: '127.0.0.1', port: 55432, user: 'test', password: 'test', database: 'openclaude_test', max: 4, ssl: false, ...(process.env.OC_RECEIPT_TEST_HOST_PG === '1' ? { stream: () => new HostPgWire() } : {}), connectionTimeoutMillis: 10000, statement_timeout: 30000, ...(schema ? { options: '-c search_path=' + schema } : {}) });
}
