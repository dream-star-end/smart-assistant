import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
// Never source deploy top-level: only extracted production functions run.
const root=process.env.OC_SOURCE_PIN_TEST_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const d=readFileSync(join(root,'scripts/deploy-v5-selfhost.sh'),'utf8'),m=readFileSync(join(root,'scripts/v5-selfhost-master-release-lib.sh'),'utf8');
function fn(s,n){const match=s.match(new RegExp('^'+n+'\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}','m'));assert.ok(match,n);return match[0];}
const q=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'oc-source-pin-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const repo=join(dir,'repo');mkdirSync(repo);
 const env={PATH:process.env.PATH,HOME:dir,TMPDIR:dir,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',LC_ALL:'C.UTF-8'};
 const git=(...a)=>execFileSync('git',['-C',repo,...a],{env,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','test');git('config','user.email','test@example.invalid');
 const p=join(repo,'packages/commercial/agent-sandbox/platform-runtime/prompts');mkdirSync(p,{recursive:true});
 writeFileSync(join(p,'marker.md'),'platform-A\n');git('add','.');git('commit','-qm','A');const A=git('rev-parse','HEAD');
 writeFileSync(join(p,'marker.md'),'platform-B\n');git('commit','-qam','B');const B=git('rev-parse','HEAD');return{dir,repo,env,git,A,B};
}
function bash(f,s,body){return spawnSync('bash',['-eu','-o','pipefail','-c',['REPO_ROOT='+q(f.repo),'TEST_ROOT='+q(f.dir),'A='+q(f.A),'B='+q(f.B),'log() { :; }; mlog() { :; }; die() { echo "$*" >&2; exit 73; }',s,body].join('\n')],{env:f.env,cwd:f.dir,encoding:'utf8',timeout:15000});}
function ok(o){assert.equal(o.status,0,o.stdout+'\n'+o.stderr);return o.stdout.trim();}
const expected=()=>fn(d,'source_commit')+'\n'+fn(d,'cutover_expected_source_commit');
// Actual archive/copy remains production. Seed semantics/digest are separate tests.
const platformStubs=[
 'PLATFORM_SRC="$REPO_ROOT/packages/commercial/agent-sandbox/platform-runtime"',
 'OC_HOTCFG_PLATFORM_ROOT="$TEST_ROOT/hotcfg"; SEED_CLI=isolated-seed',
 'npx() { test -f "$4/prompts/marker.md"; }',
 'oc_hotcfg_finalize_bundle() { cp "$1/prompts/marker.md" "$TEST_ROOT/payload"; echo 0123456789ab; }'
].join('\n');
test('master explicit A survives HEAD B; standalone stays B; invalid pin rejects',t=>{
 const f=fixture(t),o=bash(f,fn(m,'build_master_release'),'DRY=1; MASTER_RELEASES_ROOT="$TEST_ROOT/releases"; build_master_release "$A"; echo "$BUILT_MASTER_RELEASE"; build_master_release; echo "$BUILT_MASTER_RELEASE"');
 const rows=ok(o).split('\n');assert.ok(rows[0].includes('rel-'+f.A.slice(0,9)+'-'),rows[0]);assert.ok(rows[1].includes('rel-'+f.B.slice(0,9)+'-'),rows[1]);
 const bad=bash(f,fn(m,'build_master_release'),'DRY=1; MASTER_RELEASES_ROOT="$TEST_ROOT/releases"; build_master_release nope');assert.equal(bad.status,73);assert.match(bad.stderr,/source commit/);
});
test('actual platform payload is A in archive mode and B in working-tree mode',t=>{
 const f=fixture(t);for(const[mode,value]of[[1,'platform-A'],[0,'platform-B']]){ok(bash(f,fn(d,'build_platform_bundle'),platformStubs+'\nDRY=0; PLATFORM_FROM_HEAD='+mode+'; build_platform_bundle "$A"'));assert.equal(readFileSync(join(f.dir,'payload'),'utf8').trim(),value);}
});
test('only same-invocation archive deploy uses pin',t=>{
 const f=fixture(t),s='DEPLOY_BUILT_RELEASE="$TEST_ROOT/rel-A"; DEPLOY_BUILT_SOURCE_COMMIT="$A"; PLATFORM_FROM_HEAD=1; cutover_expected_source_commit; PLATFORM_FROM_HEAD=0; cutover_expected_source_commit; DEPLOY_BUILT_RELEASE=""; PLATFORM_FROM_HEAD=1; cutover_expected_source_commit';
 assert.deepEqual(ok(bash(f,expected(),s)).split('\n'),[f.A,f.B,f.B]);
 assert.equal(bash(f,expected(),'DEPLOY_BUILT_RELEASE=x; DEPLOY_BUILT_SOURCE_COMMIT=bad; PLATFORM_FROM_HEAD=1; cutover_expected_source_commit').status,73);
});
test('production static gate rejects legacy mixed source and wrong pinned candidate',t=>{
 const f=fixture(t),rel=join(f.dir,'candidate');mkdirSync(rel);
 for(const[candidate,mode,wanted]of[[f.A,0,f.B],[f.B,1,f.A]]){
  writeFileSync(join(rel,'.complete'),JSON.stringify({schemaVersion:1,sourceCommit:candidate,builtAt:'20260908-000000',metadataSha256:'a'.repeat(64),artifactSha256:'b'.repeat(64)}));
  const s='release_dir_is_poisoned() { return 1; }; MASTER_RELEASE_COMPLETE_SCHEMA_VERSION=1\nDEPLOY_BUILT_RELEASE='+q(rel)+'; DEPLOY_BUILT_SOURCE_COMMIT="$A"; PLATFORM_FROM_HEAD='+mode+'\nassert_master_release_static_gate "$DEPLOY_BUILT_RELEASE" "$(cutover_expected_source_commit)"';
  const o=bash(f,expected()+'\n'+fn(m,'assert_master_release_static_gate'),s);assert.equal(o.status,73,o.stderr);assert.ok(o.stderr.includes('sourceCommit='+candidate),o.stderr);assert.ok(o.stderr.includes(wanted),o.stderr);
 }
});
test('actual cmd_deploy passes captured A through lease master runtime payload expected after HEAD B',t=>{
 const f=fixture(t);f.git('checkout','-q',f.A);writeFileSync(join(f.dir,'env'),'');symlinkSync(f.repo,join(f.dir,'live'));
 const source=[fn(d,'cmd_deploy'),expected(),fn(m,'build_master_release'),fn(d,'build_platform_bundle').replace('build_platform_bundle()','production_platform_bundle()')].join('\n');
 const body=[platformStubs,'DRY=1; ALLOW_DIRTY=0; PLATFORM_FROM_HEAD=1','V5_ENV="$TEST_ROOT/env"; MASTER_LIVE_LINK="$TEST_ROOT/live"; MASTER_RELEASES_ROOT="$TEST_ROOT/releases"',
 'preflight_common() { :; }; explain_dirty_semantics() { :; }; ensure_selfhost_env_keys() { :; }',
 'docker() { :; }; ensure_node_modules() { :; }; install_aux_units() { :; }; refresh_ccb_proxy_path() { :; }; ensure_model_authority() { :; }',
 'lease_train_begin() { echo "$1" > "$TEST_ROOT/lease"; git -C "$REPO_ROOT" checkout -q "$B"; }',
 'lease_train_finish() { :; }; build_runtime_release() { echo "$1" > "$TEST_ROOT/runtime"; }',
 'build_platform_bundle() { DRY=0; production_platform_bundle "$1"; DRY=1; }',
 'cmd_cutover() { cutover_expected_source_commit > "$TEST_ROOT/expected"; }','cmd_deploy; echo "$DEPLOY_BUILT_RELEASE"'].join('\n');
 assert.ok(ok(bash(f,source,body)).includes('rel-'+f.A.slice(0,9)+'-'));
 for(const n of['lease','runtime','expected'])assert.equal(readFileSync(join(f.dir,n),'utf8').trim(),f.A,n);
 assert.equal(readFileSync(join(f.dir,'payload'),'utf8').trim(),'platform-A');assert.equal(f.git('rev-parse','HEAD'),f.B);
});
test('internal pin is reset instead of inherited from caller environment',()=>assert.match(d,/^DEPLOY_BUILT_SOURCE_COMMIT=""/m));

test('production lease consumes captured A and rejects a different train target',t=>{
 const f=fixture(t);
 const source=fn(d,'source_commit')+'\n'+fn(d,'lease_train_begin');
 const stubs=[
 'DRY=0; LEASE_TRAIN_ID=tr-isolated; LEASE_TARGET_SHA="$A"; LEASE_LIB=unused',
 'lease_train_load_lib() { :; }; lease_init_db() { :; }; lease_valid_train_id() { [[ "$1" == tr-isolated ]]; }',
 'train_field() { case "$2" in status) echo planned;; target_sha) echo "$LEASE_TARGET_SHA";; executor_pid) echo 0;; esac; }',
 'lease_tx() { cat > "$TEST_ROOT/lease.sql"; }; lease_now() { echo 2026-09-08T00:00:00Z; }; lease_event_sql() { :; }'
 ].join('\n');
 ok(bash(f,source,stubs+'\nlease_train_begin "$A"'));
 assert.match(readFileSync(join(f.dir,'lease.sql'),'utf8'),/UPDATE train SET status='building'/);
 const bad=bash(f,source,stubs+'\nLEASE_TARGET_SHA="$B"; lease_train_begin "$A"');
 assert.equal(bad.status,73,bad.stderr);assert.ok(bad.stderr.includes(f.B),bad.stderr);
});
