import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
// 2026-10-08: scripts/codex-review.sh assembles the AGENTS.md review rubric context (scope, round N/M, memory).
const root=process.env.OC_SOURCE_PIN_TEST_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const script=join(root,'scripts/codex-review.sh');
function repo(t){
 const dir=mkdtempSync(join(tmpdir(),'codex-review-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',HOME:dir};
 const git=(...a)=>execFileSync('git',['-C',dir,...a],{env,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','t');git('config','user.email','t@example.invalid');
 writeFileSync(join(dir,'a.txt'),'1\n');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
 writeFileSync(join(dir,'a.txt'),'2\n');git('commit','-qam','change');
 const side=mkdtempSync(join(tmpdir(),'codex-review-side-'));t.after(()=>rmSync(side,{recursive:true,force:true}));const bin=join(side,'bin');mkdirSync(bin);
 writeFileSync(join(bin,'codex'),`#!/usr/bin/env bash\ncat > ${JSON.stringify(join(side,'prompt'))}\nwhile [[ $# -gt 0 ]]; do [[ "$1" == -o ]] && echo APPROVED > "$2"; shift; done\n`);chmodSync(join(bin,'codex'),0o755);
 const run=(...args)=>spawnSync('bash',[script,...args],{cwd:dir,env:{...env,PATH:bin+':'+process.env.PATH},encoding:'utf8'});
 return{dir,side,base,run};
}
test('round 1 prompt points at the AGENTS.md rubric with diff scope, round N/M and the fixed output',t=>{
 const r=repo(t);const o=r.run('--base',r.base,'--round','1','--max-rounds','1','--print-prompt');
 assert.equal(o.status,0,o.stderr);
 for(const want of[/AGENTS\.md 的「Codex review rubric」/,new RegExp(`git diff ${r.base}\\.\\.\\.HEAD`),/第 1 轮 \/ 上限 1/,/只输出一行 APPROVED/])assert.match(o.stdout,want);
 assert.doesNotMatch(o.stdout,/上一轮结论/);
});
test('round 2+ requires the previous round and carries it plus accepted decisions',t=>{
 const r=repo(t);
 assert.equal(r.run('--base',r.base,'--round','2','--max-rounds','3','--print-prompt').status,2);
 writeFileSync(join(r.side,'prev'),'REQUEST_CHANGES\n[P1] a.txt:1 — x — y');writeFileSync(join(r.side,'dec'),'- spool is at-most-once by design');
 const o=r.run('--base',r.base,'--round','2','--max-rounds','3','--prev',join(r.side,'prev'),'--decisions',join(r.side,'dec'),'--print-prompt');
 assert.equal(o.status,0,o.stderr);assert.match(o.stdout,/上一轮结论[\s\S]*\[P1\] a\.txt:1/);assert.match(o.stdout,/已定设计决定[\s\S]*at-most-once by design/);
});
test('round cap is enforced: past the cap the script refuses and says the initiator decides',t=>{
 const r=repo(t);writeFileSync(join(r.side,'prev'),'x');
 const o=r.run('--base',r.base,'--round','2','--max-rounds','1','--prev',join(r.side,'prev'),'--print-prompt');
 assert.equal(o.status,2);assert.match(o.stderr,/超过上限.*发起方裁决/);
 assert.equal(r.run('--base',r.base,'--round','1','--max-rounds','4','--print-prompt').status,2,'max rounds capped at 3');
});
test('real invocation runs codex read-only with the prompt on stdin, and refuses a dirty tree',t=>{
 const r=repo(t);const out=join(r.side,'out');
 let o=r.run('--base',r.base,'--round','1','--max-rounds','1','-o',out);assert.equal(o.status,0,o.stderr);
 assert.equal(readFileSync(out,'utf8').trim(),'APPROVED');assert.match(readFileSync(join(r.side,'prompt'),'utf8'),/Codex review rubric/);
 writeFileSync(join(r.dir,'a.txt'),'dirty\n');o=r.run('--base',r.base,'--round','1','--max-rounds','1','-o',out);
 assert.equal(o.status,2);assert.match(o.stderr,/工作树不干净/);
});
test('AGENTS.md carries the rubric and states that no gate changes',()=>{
 const a=readFileSync(join(root,'AGENTS.md'),'utf8');
 const sec=a.slice(a.indexOf('## Codex review rubric'));
 for(const want of[/只审这次 diff/,/只有 P0\/P1 阻断合并/,/轮次记忆/,/轮次上限/,/只输出一行 `APPROVED`/,/不改任何门/,/check-v5-fix-trailers\.sh/])assert.match(sec,want);
});
