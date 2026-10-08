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
  for a in "$@"; do [[ "$a" == *HANG_ME* ]] && { trap '' TERM; sleep 30; exit 0; }; done
  { printf '%s' "$ctr"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >> "${dir}/calls"
  echo '{"ok":true}'; exit 0
fi
exit 1
`);chmodSync(join(bin,'docker'),0o755);
 if(running)writeFileSync(join(dir,'running'),'');
 const env={...process.env,PATH:bin+':'+process.env.PATH,OC_V5_TASK_SPOOL_DIR:join(dir,'spool')};
 const run=(...args)=>spawnSync('bash',[script,...args],{env,encoding:'utf8',timeout:60000});
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

test('concurrent enqueues all land as valid JSON lines (queue lock)',t=>{
 const f=fixture(t);
 const procs=[];for(let i=0;i<12;i++)procs.push(spawnSync('bash',['-c',`for j in 1 2 3; do bash ${JSON.stringify(script)} ticket comment OCV5-7 --body "p${i}-$j" & done; wait`],{env:{...process.env,PATH:join(f.dir,'bin')+':'+process.env.PATH,OC_V5_TASK_SPOOL_DIR:join(f.dir,'spool')},encoding:'utf8',timeout:60000}));
 const lines=readFileSync(join(f.dir,'spool/pending.jsonl'),'utf8').trim().split('\n');
 assert.equal(lines.length,36);const bodies=new Set(lines.map(l=>JSON.parse(l).args.at(-1)));assert.equal(bodies.size,36);
});

test('argument fidelity: leading --, empty strings, quotes and unicode are delivered verbatim',t=>{
 const f=fixture(t);const odd=['ticket','comment','OCV5-8','--body','--looks-like-a-flag',"it's \"quoted\"",'','中文 ✓','a\\nb'];
 assert.equal(f.run(...odd).status,75);f.setRunning(true);f.run('flush');
 assert.deepEqual(f.calls(),[['oc-v5-u3',...odd]]);
});

test('at-most-once: an entry left in-flight by a crashed flush is never re-sent, only reported as uncertain',t=>{
 const f=fixture(t);
 f.run('ticket','comment','OCV5-4','--body','crashed-mid-delivery');f.run('ticket','comment','OCV5-4','--body','next');
 // Simulate a flush killed after taking the head (and possibly delivering it) but before recording the outcome.
 const spool=join(f.dir,'spool');const lines=readFileSync(join(spool,'pending.jsonl'),'utf8').trim().split('\n');
 writeFileSync(join(spool,'inflight.json'),lines[0]+'\n');writeFileSync(join(spool,'pending.jsonl'),lines[1]+'\n');
 f.setRunning(true);const r=f.run('flush');
 assert.match(r.stderr,/结果未知,已移入 uncertain\.jsonl,不重发/);
 assert.deepEqual(f.calls().map(c=>c.at(-1)),['next']);
 assert.match(readFileSync(join(spool,'uncertain.jsonl'),'utf8'),/crashed-mid-delivery/);
 assert.match(f.run('pending').stdout,/\[uncertain\] .*crashed-mid-delivery/);
});

test('a docker exec that hangs and ignores TERM is hard-killed; the entry becomes uncertain (not re-sent) and the rest stays queued',t=>{
 const f=fixture(t);
 f.run('ticket','comment','OCV5-5','--body','HANG_ME');f.run('ticket','comment','OCV5-5','--body','after');
 f.setRunning(true);const started=Date.now();
 const r=spawnSync('bash',[script,'flush'],{env:{...process.env,PATH:join(f.dir,'bin')+':'+process.env.PATH,OC_V5_TASK_SPOOL_DIR:join(f.dir,'spool'),OC_V5_TASK_EXEC_TIMEOUT:'1',OC_V5_TASK_EXEC_KILL_AFTER:'1'},encoding:'utf8',timeout:60000});
 assert.equal(r.status,0,r.stderr);assert.ok(Date.now()-started<15000,`took ${Date.now()-started}ms`);
 assert.match(r.stderr,/送达超时\(rc=(124|137)\)/);
 assert.match(readFileSync(join(f.dir,'spool/uncertain.jsonl'),'utf8'),/HANG_ME/);
 assert.match(readFileSync(join(f.dir,'spool/pending.jsonl'),'utf8'),/"after"/);
 assert.equal(f.calls().length,0);
});

test('only one flush at a time: a second flush skips immediately while one is delivering',async t=>{
 const f=fixture(t);f.run('ticket','comment','OCV5-6','--body','HANG_ME');f.setRunning(true);
 const env={...process.env,PATH:join(f.dir,'bin')+':'+process.env.PATH,OC_V5_TASK_SPOOL_DIR:join(f.dir,'spool'),OC_V5_TASK_EXEC_TIMEOUT:'4',OC_V5_TASK_EXEC_KILL_AFTER:'1'};
 const {spawn}=await import('node:child_process');const first=spawn('bash',[script,'flush'],{env,stdio:'ignore'});
 spawnSync('sleep',['1']);const started=Date.now();
 const second=spawnSync('bash',[script,'flush'],{env,encoding:'utf8',timeout:60000});
 assert.equal(second.status,0);assert.match(second.stdout,/另一个 flush 正在进行,跳过/);assert.ok(Date.now()-started<3000);
 await new Promise(r=>first.on('exit',r));
});

test('the lease worker never waits for the flush (detached), even if it hangs',t=>{
 const f=fixture(t);
 const w=readFileSync(join(root,'scripts/v5-lease-worker.sh'),'utf8');
 const fnSrc=w.match(/^flush_task_spool\(\) \{[^\n]*\n[\s\S]*?^\}/m)[0];
 const dir=join(f.dir,'worker-scripts');mkdirSync(dir);
 writeFileSync(join(dir,'v5-task-host.sh'),'#!/usr/bin/env bash\nsleep 20\n');chmodSync(join(dir,'v5-task-host.sh'),0o755);
 const prog=['set -euo pipefail','WORKER_LOG_DIR='+JSON.stringify(join(f.dir,'wlog')),fnSrc,'flush_task_spool','echo returned'].join('\n');
 writeFileSync(join(dir,'worker.sh'),prog);
 const started=Date.now();const r=spawnSync('bash',[join(dir,'worker.sh')],{encoding:'utf8',timeout:30000});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/returned/);assert.ok(Date.now()-started<3000,`worker waited ${Date.now()-started}ms`);
 spawnSync('pkill',['-f',join(dir,'v5-task-host.sh')]);
});
