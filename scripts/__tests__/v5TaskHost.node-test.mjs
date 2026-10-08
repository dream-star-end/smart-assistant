import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
// 2026-10-08 devflow-opt: host-side oc-task entry with a comment spool for when oc-v5-u3 is idle-swept.
const root=process.env.OC_SOURCE_PIN_TEST_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const script=join(root,'scripts/v5-task-host.sh');
// Fake docker: `inspect` answers from $STATE_DIR/running; `exec` appends its argv (NUL-joined, one record per call)
// to $STATE_DIR/calls, and fails when the comment body contains FAIL_ME.
function fixture(t,{running=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'v5-task-host-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const bin=join(dir,'bin');mkdirSync(bin);
 writeFileSync(join(bin,'docker'),`#!/usr/bin/env bash
if [[ "$1" == inspect ]]; then [[ -f "${dir}/running" ]] && echo true || echo false; exit 0; fi
if [[ "$1" == exec ]]; then
  shift; while [[ "$1" == -* ]]; do case "$1" in -u|-e) shift 2;; *) shift;; esac; done
  ctr="$1"; shift; shift   # container, /home/agent/.local/bin/oc-task
  for a in "$@"; do [[ "$a" == *FAIL_ME* ]] && { echo "api 500" >&2; exit 4; }; done
  { printf '%s' "$ctr"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >> "${dir}/calls"
  echo '{"ok":true}'; exit 0
fi
exit 1
`);chmodSync(join(bin,'docker'),0o755);
 if(running)writeFileSync(join(dir,'running'),'');
 const env={...process.env,PATH:bin+':'+process.env.PATH,OC_V5_TASK_SPOOL_DIR:join(dir,'spool')};
 const run=(...args)=>spawnSync('bash',[script,...args],{env,encoding:'utf8'});
 const calls=()=>existsSync(join(dir,'calls'))?readFileSync(join(dir,'calls'),'utf8').split('\x1e').filter(Boolean).map(r=>r.split('\x1f')):[];
 return{dir,run,calls,setRunning:(v)=>v?writeFileSync(join(dir,'running'),''):rmSync(join(dir,'running'),{force:true})};
}

test('container up: oc-task runs via docker exec as before',t=>{
 const f=fixture(t,{running:true});const r=f.run('ticket','get','OCV5-1');
 assert.equal(r.status,0,r.stderr);assert.deepEqual(f.calls(),[['oc-v5-u3','ticket','get','OCV5-1']]);
});

test('container down: a multi-line comment is spooled (0600, exit 75) and delivered verbatim once the container is back',t=>{
 const f=fixture(t);const body='line one\nline "two" with $(not-expanded) and `ticks`\n\n- item';
 const r=f.run('ticket','comment','OCV5-9','--body',body);
 assert.equal(r.status,75,r.stderr);assert.match(r.stderr,/已入队 tq-/);
 const spool=join(f.dir,'spool/pending.jsonl');assert.equal(statSync(spool).mode&0o777,0o600);
 assert.equal(f.calls().length,0);
 assert.match(f.run('pending').stdout,/uid=3 .*ticket comment OCV5-9/);
 f.setRunning(true);const fl=f.run('flush','--quiet');assert.equal(fl.status,0,fl.stderr);
 assert.deepEqual(f.calls(),[['oc-v5-u3','ticket','comment','OCV5-9','--body',body]]);
 assert.equal(readFileSync(spool,'utf8'),'');assert.match(readFileSync(join(f.dir,'spool/delivered.jsonl'),'utf8'),/deliveredAt/);
});

test('flush keeps order and stops at the first failure; later entries stay queued for the next tick',t=>{
 const f=fixture(t);
 for(const b of['first','FAIL_ME second','third'])assert.equal(f.run('ticket','comment','OCV5-2','--body',b).status,75);
 f.setRunning(true);f.run('flush');
 assert.deepEqual(f.calls().map(c=>c.at(-1)),['first']);
 const left=readFileSync(join(f.dir,'spool/pending.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l).args.at(-1));
 assert.deepEqual(left,['FAIL_ME second','third']);
});

test('container down: reads and create fail clearly (exit 3) and are never queued',t=>{
 const f=fixture(t);
 for(const args of[['ticket','get','OCV5-1'],['ticket','list'],['ticket','create','--project-id','OCV5','--type','chore','--title','x']]){
  const r=f.run(...args);assert.equal(r.status,3,args.join(' ')+r.stderr);assert.match(r.stderr,/未运行/);
 }
 assert.equal(existsSync(join(f.dir,'spool/pending.jsonl')),false);
});

test('container up: queued comments are flushed first so a new command never overtakes them',t=>{
 const f=fixture(t);f.run('ticket','comment','OCV5-3','--body','queued');
 f.setRunning(true);const r=f.run('ticket','comment','OCV5-3','--body','live');assert.equal(r.status,0,r.stderr);
 assert.deepEqual(f.calls().map(c=>c.at(-1)),['queued','live']);
});

test('flush with an empty or missing spool is a quiet no-op (lease worker calls it every tick)',t=>{
 const f=fixture(t);const r=f.run('flush','--quiet');assert.equal(r.status,0);assert.equal(r.stdout+r.stderr,'');
});

test('lease worker tick flushes the spool after its own outbox delivery',()=>{
 const w=readFileSync(join(root,'scripts/v5-lease-worker.sh'),'utf8');
 const main=w.slice(w.indexOf('\nmain() {'),w.indexOf('\n}',w.indexOf('\nmain() {')));
 assert.ok(main.indexOf('deliver_outbox')>=0&&main.indexOf('flush_task_spool')>main.indexOf('deliver_outbox'),main);
});
