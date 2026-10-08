import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,existsSync,statSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
// 2026-10-08 devflow-opt: host-side oc-task entry with an at-most-once comment spool for when oc-v5-u3 is idle-swept.
const root=process.env.OC_SOURCE_PIN_TEST_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const script=join(root,'scripts/v5-task-host.sh');
// Fake docker. inspect: $dir/running. exec: records argv (\x1f-joined, \x1e per call) to $dir/calls.
//   `ticket get OCV5-404` → not_found JSON, exit 4; $dir/gateway-down → every call exits 3;
//   a write whose body contains FAIL_ME → exit 4; HANG_ME → ignores TERM and sleeps.
function fixture(t,{running=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'v5-task-host-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const bin=join(dir,'bin');mkdirSync(bin);
 writeFileSync(join(bin,'docker'),`#!/usr/bin/env bash
if [[ "$1" == inspect ]]; then [[ -f "${dir}/running" ]] && echo true || echo false; exit 0; fi
if [[ "$1" == exec ]]; then
  shift; while [[ "$1" == -* ]]; do case "$1" in -u|-e) shift 2;; *) shift;; esac; done
  ctr="$1"; shift; shift
  { printf '%s' "$ctr"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >> "${dir}/calls"
  [[ -f "${dir}/gateway-down" ]] && { echo "oc-task: gateway unreachable" >&2; exit 3; }
  if [[ "$1 $2" == "ticket get" ]]; then
    [[ "$3" == OCV5-404 ]] && { echo '{"ok":false,"error":"ticket OCV5-404 not found","code":"not_found"}'; exit 4; }
    echo '{"ok":true}'; exit 0
  fi
  for a in "$@"; do [[ "$a" == *FAIL_ME* ]] && { echo "api 500" >&2; exit 4; }; done
  for a in "$@"; do [[ "$a" == *HANG_ME* ]] && { trap '' TERM; sleep 30; exit 0; }; done
  echo '{"ok":true}'; exit 0
fi
exit 1
`);chmodSync(join(bin,'docker'),0o755);
 if(running)writeFileSync(join(dir,'running'),'');
 const env={...process.env,PATH:bin+':'+process.env.PATH,OC_V5_TASK_SPOOL_DIR:join(dir,'spool')};
 const run=(...args)=>spawnSync('bash',[script,...args],{env,encoding:'utf8',timeout:60000});
 const calls=()=>existsSync(join(dir,'calls'))?readFileSync(join(dir,'calls'),'utf8').split('\x1e').filter(Boolean).map(r=>r.split('\x1f')):[];
 const writes=()=>calls().filter(c=>c[2]==='comment');
 const ls=(st)=>{const p=join(dir,'spool',st);return existsSync(p)?readdirSync(p).filter(n=>n.endsWith('.json')).sort():[];};
 const bodyOf=(st,n)=>JSON.parse(readFileSync(join(dir,'spool',st,n),'utf8')).args.at(-1);
 return{dir,env,run,calls,writes,ls,bodyOf,setRunning:(v)=>v?writeFileSync(join(dir,'running'),''):rmSync(join(dir,'running'),{force:true}),
  setGateway:(up)=>up?rmSync(join(dir,'gateway-down'),{force:true}):writeFileSync(join(dir,'gateway-down'),'')};
}

test('container up: oc-task runs via docker exec as before',t=>{
 const f=fixture(t,{running:true});const r=f.run('ticket','get','OCV5-1');
 assert.equal(r.status,0,r.stderr);assert.deepEqual(f.calls(),[['oc-v5-u3','ticket','get','OCV5-1']]);
});

test('container down: a multi-line comment is spooled (0700 dirs, 0600 file, exit 75), then probed and delivered verbatim',t=>{
 const f=fixture(t);const body='line one\nline "two" with $(not-expanded) and `ticks`\n\n- item';
 const r=f.run('ticket','comment','OCV5-9','--body',body);
 assert.equal(r.status,75,r.stderr);assert.match(r.stderr,/已入队 tq-/);
 const [n]=f.ls('q');assert.ok(n);assert.equal(statSync(join(f.dir,'spool/q',n)).mode&0o777,0o600);assert.equal(statSync(join(f.dir,'spool/q')).mode&0o777,0o700);
 assert.equal(f.calls().length,0);
 assert.match(f.run('pending').stdout,/\[q\] tq-.* uid=3 .*ticket comment OCV5-9/);
 f.setRunning(true);assert.equal(f.run('flush','--quiet').status,0);
 assert.deepEqual(f.calls(),[['oc-v5-u3','ticket','get','OCV5-9'],['oc-v5-u3','ticket','comment','OCV5-9','--body',body]]);
 assert.deepEqual(f.ls('q'),[]);assert.deepEqual(f.ls('delivered'),[n]);
});

test('a failed write is never retried: it becomes uncertain, the flush stops, later entries stay queued in order',t=>{
 const f=fixture(t);
 for(const b of['first','FAIL_ME second','third','fourth'])assert.equal(f.run('ticket','comment','OCV5-2','--body',b).status,75);
 f.setRunning(true);const r=f.run('flush');assert.match(r.stderr,/结果未知,已移入 uncertain\/,不重发/);
 assert.deepEqual(f.writes().map(c=>c.at(-1)),['first','FAIL_ME second']);
 assert.deepEqual(f.ls('uncertain').map(n=>f.bodyOf('uncertain',n)),['FAIL_ME second']);
 assert.deepEqual(f.ls('q').map(n=>f.bodyOf('q',n)),['third','fourth']);
 f.run('flush');assert.deepEqual(f.writes().map(c=>c.at(-1)),['first','FAIL_ME second','third','fourth'],'uncertain entry must not be re-sent');
});

test('gateway not ready: the read-only probe fails, nothing is written, the entry stays queued',t=>{
 const f=fixture(t);f.run('ticket','comment','OCV5-3','--body','wait-for-me');f.setRunning(true);f.setGateway(false);
 const r=f.run('flush');assert.match(r.stderr,/预探测失败\(rc=3\)/);
 assert.equal(f.writes().length,0);assert.equal(f.ls('q').length,1);assert.equal(f.ls('uncertain').length,0);
 f.setGateway(true);f.run('flush');assert.deepEqual(f.writes().map(c=>c.at(-1)),['wait-for-me']);
});

test('probe says the ticket does not exist: entry goes to failed/ (never sent) and the flush continues',t=>{
 const f=fixture(t);f.run('ticket','comment','OCV5-404','--body','orphan');f.run('ticket','comment','OCV5-5','--body','fine');
 f.setRunning(true);f.run('flush');
 assert.deepEqual(f.writes().map(c=>c.at(-1)),['fine']);assert.deepEqual(f.ls('failed').map(n=>f.bodyOf('failed',n)),['orphan']);
 assert.match(f.run('pending').stdout,/\[failed\] .*orphan[\s\S]*工单 OCV5-404 不存在;未发送/);
});

test('at-most-once across a crash: an entry left in inflight/ is reported uncertain and never re-sent',t=>{
 const f=fixture(t);f.run('ticket','comment','OCV5-4','--body','crashed-mid-write');f.run('ticket','comment','OCV5-4','--body','next');
 const [first]=f.ls('q');mkdirSync(join(f.dir,'spool/inflight'),{recursive:true});
 spawnSync('mv',[join(f.dir,'spool/q',first),join(f.dir,'spool/inflight',first)]);
 f.setRunning(true);const r=f.run('flush');
 assert.match(r.stderr,/上次送达途中被打断,结果未知/);
 assert.deepEqual(f.writes().map(c=>c.at(-1)),['next']);assert.deepEqual(f.ls('uncertain'),[first]);assert.deepEqual(f.ls('inflight'),[]);
});

test('every entry lives in exactly one state directory (rename-only transitions)',t=>{
 const f=fixture(t);for(const b of['a','FAIL_ME b','c'])f.run('ticket','comment','OCV5-6','--body',b);
 f.setRunning(true);f.run('flush');f.run('flush');
 const all=['q','inflight','delivered','uncertain','failed'].flatMap(st=>f.ls(st));
 assert.equal(all.length,3);assert.equal(new Set(all).size,3);
});

test('a write that hangs and ignores TERM is hard-killed into uncertain; the rest stays queued',t=>{
 const f=fixture(t);f.run('ticket','comment','OCV5-7','--body','HANG_ME');f.run('ticket','comment','OCV5-7','--body','after');
 f.setRunning(true);const started=Date.now();
 const r=spawnSync('bash',[script,'flush'],{env:{...f.env,OC_V5_TASK_EXEC_TIMEOUT:'1',OC_V5_TASK_EXEC_KILL_AFTER:'1'},encoding:'utf8',timeout:60000});
 assert.equal(r.status,0,r.stderr);assert.ok(Date.now()-started<15000,`took ${Date.now()-started}ms`);
 assert.deepEqual(f.ls('uncertain').map(n=>f.bodyOf('uncertain',n)),['HANG_ME']);assert.deepEqual(f.ls('q').map(n=>f.bodyOf('q',n)),['after']);
});

test('container up but older comments cannot be delivered yet: a live comment queues behind them instead of overtaking',t=>{
 const f=fixture(t);f.run('ticket','comment','OCV5-8','--body','older');f.setRunning(true);f.setGateway(false);
 const r=f.run('ticket','comment','OCV5-8','--body','newer');assert.equal(r.status,75,r.stderr);
 assert.equal(f.writes().length,0);assert.deepEqual(f.ls('q').map(n=>f.bodyOf('q',n)),['older','newer']);
 f.setGateway(true);f.run('flush');assert.deepEqual(f.writes().map(c=>c.at(-1)),['older','newer']);
});

test('container up with an empty queue after flushing: a live comment runs directly, after the flushed ones',t=>{
 const f=fixture(t);f.run('ticket','comment','OCV5-8','--body','queued');f.setRunning(true);
 const r=f.run('ticket','comment','OCV5-8','--body','live');assert.equal(r.status,0,r.stderr);
 assert.deepEqual(f.writes().map(c=>c.at(-1)),['queued','live']);
});

test('container down: reads and create fail clearly (exit 3) and are never queued',t=>{
 const f=fixture(t);
 for(const args of[['ticket','get','OCV5-1'],['ticket','list'],['ticket','create','--project-id','OCV5','--type','chore','--title','x']]){
  const r=f.run(...args);assert.equal(r.status,3,args.join(' ')+r.stderr);assert.match(r.stderr,/未运行/);
 }
 assert.deepEqual(f.ls('q'),[]);
});

test('concurrent enqueues all land as distinct, valid entries',t=>{
 const f=fixture(t);
 for(let i=0;i<12;i++)spawnSync('bash',['-c',`for j in 1 2 3; do bash ${JSON.stringify(script)} ticket comment OCV5-7 --body "p${i}-$j" & done; wait`],{env:f.env,encoding:'utf8',timeout:60000});
 const names=f.ls('q');assert.equal(names.length,36);assert.equal(new Set(names.map(n=>f.bodyOf('q',n))).size,36);
});

test('argument fidelity: leading --, empty strings, quotes, unicode and backslashes are delivered verbatim',t=>{
 const f=fixture(t);const odd=['ticket','comment','OCV5-8','--body','--looks-like-a-flag',"it's \"quoted\"",'','中文 ✓','a\\nb'];
 assert.equal(f.run(...odd).status,75);f.setRunning(true);f.run('flush');
 assert.deepEqual(f.writes(),[['oc-v5-u3',...odd]]);
});

test('only one flush at a time: a second flush skips immediately while one is delivering',async t=>{
 const f=fixture(t);f.run('ticket','comment','OCV5-6','--body','HANG_ME');f.setRunning(true);
 const env={...f.env,OC_V5_TASK_EXEC_TIMEOUT:'4',OC_V5_TASK_EXEC_KILL_AFTER:'1'};
 const first=spawn('bash',[script,'flush'],{env,stdio:'ignore'});
 spawnSync('sleep',['1']);const started=Date.now();
 const second=spawnSync('bash',[script,'flush'],{env,encoding:'utf8',timeout:60000});
 assert.equal(second.status,0);assert.match(second.stdout,/另一个 flush 正在进行,跳过/);assert.ok(Date.now()-started<3000);
 await new Promise(r=>first.on('exit',r));
});

test('flush with an empty or missing spool is a quiet no-op',t=>{
 const f=fixture(t);const r=f.run('flush','--quiet');assert.equal(r.status,0);assert.equal(r.stdout+r.stderr,'');
});

test('lease worker: launches the flush as a transient systemd unit (own cgroup, no inherited fds) only when entries are queued',t=>{
 const f=fixture(t);
 const w=readFileSync(join(root,'scripts/v5-lease-worker.sh'),'utf8');
 const fnSrc=w.match(/^flush_task_spool\(\) \{[^\n]*\n[\s\S]*?^\}/m)[0];
 const main=w.slice(w.indexOf('\nmain() {'),w.indexOf('\n}',w.indexOf('\nmain() {')));
 assert.ok(main.indexOf('flush_task_spool')>main.indexOf('deliver_outbox'),'runs after the lease outbox');
 const sbin=join(f.dir,'sbin');mkdirSync(sbin);
 writeFileSync(join(sbin,'systemd-run'),`#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(join(f.dir,'systemd-run.args'))}\n`);chmodSync(join(sbin,'systemd-run'),0o755);
 const scripts=join(f.dir,'worker-scripts');mkdirSync(scripts);writeFileSync(join(scripts,'v5-task-host.sh'),'#!/usr/bin/env bash\n');chmodSync(join(scripts,'v5-task-host.sh'),0o755);
 const prog=['set -Eeuo pipefail','TASK_SPOOL_DIR='+JSON.stringify(join(f.dir,'spool')),fnSrc,'flush_task_spool','echo returned'].join('\n');
 writeFileSync(join(scripts,'worker.sh'),prog);
 const env={...process.env,PATH:sbin+':'+process.env.PATH};
 let r=spawnSync('bash',[join(scripts,'worker.sh')],{env,encoding:'utf8',timeout:30000});
 assert.equal(r.status,0,r.stderr);assert.equal(existsSync(join(f.dir,'systemd-run.args')),false,'empty queue → no launch');
 f.run('ticket','comment','OCV5-1','--body','x');
 r=spawnSync('bash',[join(scripts,'worker.sh')],{env,encoding:'utf8',timeout:30000});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/returned/);
 const args=readFileSync(join(f.dir,'systemd-run.args'),'utf8').trim().split('\n');
 for(const want of['--collect','--unit=openclaude-v5-oc-task-spool-flush','--property=RuntimeMaxSec=300','flush','--quiet'])assert.ok(args.includes(want),want+' in '+args.join(' '));
});
