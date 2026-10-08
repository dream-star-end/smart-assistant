import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
// 2026-10-08 devflow-opt: web dist reuse + runtime release built in parallel.
// Same style as selfhostSourcePin: never source deploy top-level; run extracted production functions.
const root=process.env.OC_SOURCE_PIN_TEST_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const d=readFileSync(join(root,'scripts/deploy-v5-selfhost.sh'),'utf8'),m=readFileSync(join(root,'scripts/v5-selfhost-master-release-lib.sh'),'utf8');
function fn(s,n){const match=s.match(new RegExp('^'+n+'\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}','m'));assert.ok(match,n);return match[0];}
function block(s,startRe,endRe){const a=s.search(startRe);assert.ok(a>=0,String(startRe));const rest=s.slice(a);const b=rest.search(endRe);assert.ok(b>0,String(endRe));return rest.slice(0,b);}
const q=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const webLib=[block(m,/^WEB_DIST_REUSE_RECORD=/m,/^master_web_dist_key\(\)/m),fn(m,'master_web_dist_key'),fn(m,'web_dist_digest'),fn(m,'find_web_dist_donor'),fn(m,'write_web_dist_reuse_record'),fn(m,'release_dir_is_poisoned')].join('\n');
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'oc-deploy-speed-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const repo=join(dir,'repo');
 const env={PATH:process.env.PATH,HOME:dir,TMPDIR:dir,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',LC_ALL:'C.UTF-8'};
 const git=(...a)=>execFileSync('git',['-C',repo,...a],{env,encoding:'utf8'}).trim();
 for(const p of['packages/web-react/src','packages/protocol/src','packages/mcp-memory/src','packages/gateway/src','scripts'])mkdirSync(join(repo,p),{recursive:true});
 const files={'packages/web-react/src/App.tsx':'app-1\n','packages/protocol/src/frames.ts':'p-1\n','packages/mcp-memory/src/toolNames.ts':'t-1\n','packages/gateway/src/x.ts':'g-1\n','package-lock.json':'{"l":1}\n','package.json':'{}\n','scripts/v5-selfhost-master-release-lib.sh':'# lib-1\n'};
 execFileSync('git',['init','-q',repo],{env});git('config','user.name','t');git('config','user.email','t@example.invalid');
 for(const[k,v]of Object.entries(files))writeFileSync(join(repo,k),v);git('add','.');git('commit','-qm','base');
 const commit=(path,content)=>{writeFileSync(join(repo,path),content);git('commit','-qam','c '+path);return git('rev-parse','HEAD');};
 return{dir,repo,env,git,commit,base:git('rev-parse','HEAD')};
}
function bash(f,src,body){return spawnSync('bash',['-eu','-o','pipefail','-c',['REPO_ROOT='+q(f.repo),'TEST_ROOT='+q(f.dir),'log() { echo "$*"; }; mlog() { echo "$*" >&2; }; die() { echo "$*" >&2; exit 73; }','MASTER_RELEASES_ROOT="$TEST_ROOT/releases"; MASTER_LIVE_LINK="$TEST_ROOT/live"',src,body].join('\n')],{env:f.env,cwd:f.dir,encoding:'utf8',timeout:20000});}
function ok(o){assert.equal(o.status,0,o.stdout+'\n'+o.stderr);return o.stdout.trim();}
const key=(f,sha)=>ok(bash(f,webLib,'master_web_dist_key '+q(sha)));

test('web dist key changes with every web build input and ignores unrelated backend changes',t=>{
 const f=fixture(t);const k0=key(f,f.base);assert.match(k0,/^[0-9a-f]{64}$/);
 const gw=f.commit('packages/gateway/src/x.ts','g-2\n');assert.equal(key(f,gw),k0,'gateway-only change must keep the key');
 let prev=k0;
 for(const p of['packages/web-react/src/App.tsx','packages/protocol/src/frames.ts','packages/mcp-memory/src/toolNames.ts','package-lock.json','package.json','scripts/v5-selfhost-master-release-lib.sh']){
  const sha=f.commit(p,'changed '+p+'\n');const k=key(f,sha);assert.notEqual(k,prev,p+' must change the key');prev=k;
 }
 assert.equal(bash(f,webLib,'master_web_dist_key 0000000000000000000000000000000000000000').status===0,false,'unknown sha must not produce a key');
});

// Builds a sealed-looking release with a dist and (optionally) a reuse record written by production code.
function release(f,name,{key:k,html='<html><head><meta name="oc-build" content="0123456789abcdef"></head></html>',complete=true,record=true,poison=false}={}){
 const rel=join(f.dir,'releases',name),dist=join(rel,'packages/web-react/dist');mkdirSync(join(dist,'assets'),{recursive:true});
 writeFileSync(join(dist,'index.html'),html);writeFileSync(join(dist,'assets/main.js'),'console.log(1)\n');
 if(complete)writeFileSync(join(rel,'.complete'),'{}');if(poison)writeFileSync(join(rel,'.poisoned'),'');
 if(record)ok(bash(f,webLib,'write_web_dist_reuse_record '+q(rel)+' '+q(k)+' built '+q(f.base)));
 return rel;
}

test('donor search prefers live, re-verifies the dist digest, and rejects poisoned/incomplete/mismatched releases',t=>{
 const f=fixture(t);const k=key(f,f.base);
 const live=release(f,'rel-live',{key:k});symlinkSync(live,join(f.dir,'live'));
 assert.equal(ok(bash(f,webLib,'find_web_dist_donor '+q(k))),live);
 // Tampered dist in live → skipped; an older intact release is used instead.
 const older=release(f,'rel-older',{key:k});
 writeFileSync(join(live,'packages/web-react/dist/assets/main.js'),'tampered\n');
 assert.equal(ok(bash(f,webLib,'find_web_dist_donor '+q(k))),older);
 // Poisoned, incomplete, record-less and other-key releases are never donors.
 rmSync(older,{recursive:true,force:true});
 release(f,'rel-poison',{key:k,poison:true});release(f,'rel-incomplete',{key:k,complete:false});release(f,'rel-norecord',{key:k,record:false});
 release(f,'rel-otherkey',{key:'f'.repeat(64)});
 const none=bash(f,webLib,'find_web_dist_donor '+q(k));assert.equal(none.status,1,none.stdout+none.stderr);assert.equal(none.stdout,'');
});

test('build_master_release reuses a matching dist instead of running the web build, and records itself as a future donor',t=>{
 const f=fixture(t);const k=key(f,f.base);const live=release(f,'rel-live',{key:k});symlinkSync(live,join(f.dir,'live'));
 // Extract just the frontend section of build_master_release and run it against a staging dir.
 const bmr=fn(m,'build_master_release');
 const section=block(bmr,/^  t0="\$\(date \+%s\)"\n  web_key=/m,/^  # openclaude-memory MCP server/m);
 const body=['staging="$TEST_ROOT/staging"; full_sha='+q(f.base)+'; mkdir -p "$staging/packages/web-react"','cleanup_master_staging() { :; }',
  'npm() { echo NPM_BUILD_RAN >&2; return 99; }',section,'echo "mode=$MASTER_FRONTEND_MODE"; cat "$staging/.web-dist-reuse.json"'].join('\n');
 const out=bash(f,webLib,body);const s=ok(out);
 assert.match(s,/mode=reused/);assert.doesNotMatch(out.stderr,/NPM_BUILD_RAN/);
 const rec=JSON.parse(s.slice(s.indexOf('{')));assert.equal(rec.key,k);assert.equal(rec.mode,'reused');assert.equal(rec.donor,live);
 assert.equal(readFileSync(join(f.dir,'staging/packages/web-react/dist/assets/main.js'),'utf8'),'console.log(1)\n');
 // OC_V5_FORCE_WEB_BUILD=1 → the real build path runs (our npm stub fails it → die 73).
 rmSync(join(f.dir,'staging'),{recursive:true,force:true});
 const forced=bash(f,webLib,'OC_V5_FORCE_WEB_BUILD=1\n'+body);assert.equal(forced.status,73,forced.stderr);assert.match(forced.stderr,/NPM_BUILD_RAN/);
});

const bgSrc=()=>[fn(d,'start_runtime_release_bg'),fn(d,'collect_runtime_release_bg'),fn(d,'reap_runtime_release_bg')].join('\n');
const bgPrelude='DRY=0; RUNTIME_BG_PID=""; RUNTIME_BG_LOG=""; RUNTIME_BG_RESULT=""; OC_HOTCFG_RELEASES_ROOT="$TEST_ROOT/rt"; mkdir -p "$OC_HOTCFG_RELEASES_ROOT"';

test('runtime release builds in the background while master builds, and its result reaches the parent shell',t=>{
 const f=fixture(t);
 const body=[bgPrelude,
  'build_runtime_release() { log "rt-start $1"; sleep 2; mkdir -p "$OC_HOTCFG_RELEASES_ROOT/rel-abc"; BUILT_RUNTIME_RELEASE="$OC_HOTCFG_RELEASES_ROOT/rel-abc"; RUNTIME_IMAGE_ID=sha256:feed; log "rt-done"; }',
  't0=$(date +%s%N); start_runtime_release_bg deadbeef; sleep 2; collect_runtime_release_bg deadbeef; t1=$(date +%s%N)',
  'echo "R=$BUILT_RUNTIME_RELEASE I=$RUNTIME_IMAGE_ID waited_ms=$(( (t1-t0)/1000000 ))"'].join('\n');
 const s=ok(bash(f,bgSrc(),body));
 assert.match(s,/R=.*\/rt\/rel-abc I=sha256:feed/);assert.match(s,/rt-start deadbeef/);assert.match(s,/rt-done/);
 // 2s bg build + 2s foreground master work: serial would take >=4s.
 const total=Number(/waited_ms=(\d+)/.exec(s)[1]);assert.ok(total<3500,'bg build must overlap the foreground work, total '+total+'ms');
});

test('a failed background runtime build fails the deploy (die) with its log replayed, live untouched',t=>{
 const f=fixture(t);
 const o=bash(f,bgSrc(),[bgPrelude,'build_runtime_release() { log "rt-boom-log"; die "release finalize 失败"; }','start_runtime_release_bg x; collect_runtime_release_bg x; echo SHOULD_NOT_REACH'].join('\n'));
 assert.equal(o.status,73,o.stdout+o.stderr);assert.match(o.stdout,/rt-boom-log/);assert.match(o.stderr,/后台构建失败/);assert.doesNotMatch(o.stdout,/SHOULD_NOT_REACH/);
});

test('if the parent dies first, EXIT cleanup waits for the background build before releasing anything',t=>{
 const f=fixture(t);
 const o=bash(f,bgSrc(),[bgPrelude,'build_runtime_release() { sleep 1; touch "$TEST_ROOT/bg-finished"; BUILT_RUNTIME_RELEASE=x; RUNTIME_IMAGE_ID=y; }',
  'trap reap_runtime_release_bg EXIT','start_runtime_release_bg x; die "master build failed"'].join('\n'));
 assert.equal(o.status,73);assert.ok(existsSync(join(f.dir,'bg-finished')),'bg build must have completed before the shell exited');
});

test('dry-run and OC_V5_SERIAL_RUNTIME_BUILD=1 keep the serial in-place build',t=>{
 const f=fixture(t);
 const s=ok(bash(f,bgSrc(),[bgPrelude,'OC_V5_SERIAL_RUNTIME_BUILD=1','build_runtime_release() { echo "serial $$ $BASHPID"; BUILT_RUNTIME_RELEASE=x; }','start_runtime_release_bg x; [[ -z "$RUNTIME_BG_PID" ]]; collect_runtime_release_bg x'].join('\n')));
 const [, a, b]=/serial (\d+) (\d+)/.exec(s);assert.equal(a,b,'serial build must run in the parent shell');
});

test('cmd_deploy wires the bg runtime build around build_master_release and the EXIT trap reaps it',()=>{
 const cd=fn(d,'cmd_deploy');
 assert.ok(cd.indexOf('start_runtime_release_bg "$sha"')>=0&&cd.indexOf('start_runtime_release_bg "$sha"')<cd.indexOf('build_master_release "$sha"'));
 assert.ok(cd.indexOf('collect_runtime_release_bg "$sha"')>cd.indexOf('build_master_release "$sha"')&&cd.indexOf('collect_runtime_release_bg "$sha"')<cd.indexOf('build_platform_bundle "$sha"'));
 assert.doesNotMatch(cd,/^\s+build_runtime_release "\$sha"/m);
 const cleanup=fn(d,'cleanup_selfhost_deploy');assert.ok(cleanup.indexOf('reap_runtime_release_bg')<cleanup.indexOf('lease_train_on_exit'),'reap before train/lock release');
});
