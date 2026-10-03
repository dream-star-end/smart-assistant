import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(path.join(root, 'scripts/lib/v5-mutation-admission.sh'), 'utf8');
const begin = '# V5_IDENTITY_NORMALIZER_BEGIN', end = '# V5_IDENTITY_NORMALIZER_END';
assert.equal(source.split(begin).length - 1, 1);
assert.equal(source.split(end).length - 1, 1);
const original = source.split(begin)[1].split(end)[0];
let code = original, transformCount = 0;
if (process.env.OC_V5_IDENTITY_TYPE_RED === '1') {
  for (const [old, next] of [['if value.get("inRecovery") is not False:', 'if value.get("inRecovery") != False:'], ['return ("boolean", value)', 'return ("number", Decimal(value))']]) {
    assert.equal(code.split(old).length - 1, 1); code = code.replace(old, next); transformCount++;
  }
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const reports: object[] = [];
function normalize(raw: string[]) {
  const out = spawnSync('python3', ['-c', code, ...raw], { encoding: 'utf8', timeout: 5000 });
  assert.equal(out.signal, null, 'normalizer must terminate normally');
  return out;
}
const base = { clusterId:'7421739387452538148',database:'openclaude_test',databaseOid:'16384',serverAddress:'127.0.0.1',serverPort:55432,postmasterEpoch:'1760000000.125',inRecovery:false };
const raw = JSON.stringify(base);
function check(name: string, rows: string[], accept: boolean) {
  test(name, () => {
    const out = normalize(rows);
    assert.equal(out.status, accept ? 0 : 79, out.stderr);
    if (accept) { assert.equal(out.stdout.trim(), rows[0].trim()); assert.deepEqual(JSON.parse(out.stdout), JSON.parse(rows[0])); }
    else assert.equal(out.stdout, '', 'invalid role never emits a proof identity');
    reports.push({ name, accepted: out.status === 0 });
    if (process.env.OC_IDENTITY_REPORT) writeFileSync(process.env.OC_IDENTITY_REPORT, JSON.stringify({ sourceSha:sha(source),originalNormalizerSha:sha(original),consumedNormalizerSha:sha(code),transformCount,cases:reports },null,2));
  });
}
check('actual SQL-shaped identities accept', [raw,raw,raw], true);
check('key order and surrounding whitespace are equivalent', [raw,' \n'+JSON.stringify(Object.fromEntries(Object.entries(base).reverse()))+'\n ',raw], true);
check('number 1 and 1.0 are equivalent as in jq', [raw,raw.replace('55432','55432.0'),raw], true);
check('matching unknown typed fields are preserved', [0,1,2].map(()=>JSON.stringify({...base,extra:{arr:[false,0,'0',null,{},[]]}})), true);
for (let role=0;role<3;role++) {
  const rows=[raw,raw,raw];rows[role]=JSON.stringify({...base,inRecovery:0});
  check('role '+role+' recovery zero cannot impersonate false',rows,false);
  const port=[raw,raw,raw];port[role]=JSON.stringify({...base,serverPort:true});
  check('role '+role+' boolean port is not a number',port,false);
}
for (const [key,value] of Object.entries({clusterId:'7421739387452538149',database:'different_database',databaseOid:'16385',serverAddress:'127.0.0.2',serverPort:55433,postmasterEpoch:'1760000001.125',inRecovery:true})) {
  check('same cluster controls cannot hide changed '+key,[raw,JSON.stringify({...base,[key]:value}),raw],false);
}
check('unknown object value false is not number zero',[JSON.stringify({...base,extra:false}),JSON.stringify({...base,extra:0}),JSON.stringify({...base,extra:false})],false);
check('unknown field addition cannot disappear',[raw,JSON.stringify({...base,extra:null}),raw],false);
for (const value of ['NaN','Infinity','-Infinity']) check('non-JSON constant '+value+' is rejected',[raw,raw.replace('55432',value),raw],false);
for (const value of ['',raw+'\n'+raw,'{broken','[]',JSON.stringify({...base,clusterId:'１２３'}),JSON.stringify({...base,databaseOid:16384})]) check('malformed or invalid schema '+JSON.stringify(value).slice(0,40),[raw,value,raw],false);
test('three independent real PG role connections yield accepted unchanged proof identity', () => {
  const dsn='postgresql://test:test@127.0.0.1:55432/openclaude_test';
  const sql="SELECT json_build_object('clusterId', system_identifier::text, 'database', current_database(), 'databaseOid', (SELECT oid::text FROM pg_database WHERE datname=current_database()), 'serverAddress', inet_server_addr()::text, 'serverPort', inet_server_port(), 'postmasterEpoch', extract(epoch FROM pg_postmaster_start_time())::text, 'inRecovery', pg_is_in_recovery())::text FROM pg_control_system()";
  const rows=[0,1,2].map(()=>{const out=spawnSync('psql',[dsn,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',sql],{encoding:'utf8',timeout:5000});assert.equal(out.status,0,out.stderr);return out.stdout;});
  const out=normalize(rows);assert.equal(out.status,0,out.stderr);assert.equal(out.stdout.trim(),rows[0].trim());
  reports.push({name:'actual-three-role-PG', actualConnections:3,accepted:true});
  if (process.env.OC_IDENTITY_REPORT) writeFileSync(process.env.OC_IDENTITY_REPORT,JSON.stringify({sourceSha:sha(source),originalNormalizerSha:sha(original),consumedNormalizerSha:sha(code),transformCount,cases:reports},null,2));
});
