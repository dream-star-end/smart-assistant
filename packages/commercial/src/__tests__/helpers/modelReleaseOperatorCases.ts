import assert from "node:assert/strict";
import { before, after, test, describe } from "node:test";
import { readFile, writeFile, mkdir, mkdtemp, stat, chmod, chown, symlink, rename, rm, realpath, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "pg";
import { buildSync } from "esbuild";
import { once } from "node:events";
import { createServer as createTcpServer, createConnection as createTcpConnection, type Socket } from "node:net";
import { getPool } from "../../db/index.js";
import { runMigrations } from "../../db/migrate.js";
import { useDedicatedTestDatabase, resetAndMigrateBefore } from "./db.js";
import {
  observe, apply, compensate, reconcile, readSnapshot, digest, primaryIdentity,
  expectedVersion, explicitOperatorDsn, CommitUnknown, permissionPreflight,
  type ModelManifest, type OperatorContext, type WriteRequest, type Observation,
  type Readiness, type Receipt,
} from "../../../../../ops/ocv5-308/model-release-operator.js";

let db: ReturnType<typeof useDedicatedTestDatabase>;
const manifest = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../../../../ops/ocv5-308/model-release-manifest.json", import.meta.url)), "utf8")) as ModelManifest;
const prepare = await readFile(fileURLToPath(new URL(
  "../../db/migrations/0293_commercial_new_models_prepare.sql", import.meta.url)));
let root: string;
let fixtureRelease: string;
let holder: ChildProcessWithoutNullStreams;
let nonce: string;
let context: OperatorContext;
let observation: Observation;
let ready: Readiness;
const catalogKeys = ["engine","provider_id","upstream_model_id","context_window",
  "capability_profile","capability_schema_version"];
const priceKeys = ["display_name","input_per_mtok","output_per_mtok","cache_read_per_mtok",
  "cache_write_per_mtok","multiplier","sort_order","visibility","default_effort","min_plan_code",
  "promo_label","extra_system_prompt"];
async function connect(): Promise<Client> {
  const client = new Client({ connectionString: db.url, connectionTimeoutMillis: 3000 });
  await client.connect();
  return client;
}
async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect();
  try { return await fn(client); } finally { await client.end(); }
}
async function issueLease(): Promise<void> {
  nonce = randomBytes(16).toString("hex");
  holder = spawn("bash", ["-c",
    'umask 077; exec 9>"$1"; flock -x 9; printf "READY\\n"; read -r line',
    "fixture-holder", context.leasePaths!.lock], { stdio: ["pipe","pipe","pipe"] });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    holder.stdout.on("data", (chunk) => { output += chunk.toString(); if(output.includes("READY\n")) resolve(); });
    holder.once("error", reject);
    holder.once("exit", (code) => reject(new Error("holder exited before readiness:" + code)));
  });
  const pid = holder.pid!;
  const kernel = await readFile("/proc/" + pid + "/stat", "utf8");
  const start = kernel.slice(kernel.lastIndexOf(") ") + 2).split(/\s+/)[19];
  const lock = await stat(context.leasePaths!.lock, { bigint: true });
  const primary = await withClient(primaryIdentity);
  const proof = { schema:1, nonce, holderPid:pid, holderStart:start,
    lockDevIno: lock.dev + ":" + lock.ino, expiresAt: Math.floor(Date.now()/1000)+600, ...primary };
  for (const [path, text] of [
    [context.leasePaths!.commonNonce, nonce + "\n"], [context.leasePaths!.manualNonce, nonce + "\n"],
    [context.leasePaths!.commonNonce + ".db", JSON.stringify(proof)],
  ]) { await writeFile(path, text, { mode:0o600 }); await chmod(path,0o600); }
}
async function stopHolder(): Promise<void> {
  if (holder && holder.exitCode === null) {
    const exited = once(holder, "exit"); holder.stdin.end("release\n"); await exited;
  }
}
async function seedProductionFloor(): Promise<void> {
  await resetAndMigrateBefore("0293");
  const pool = getPool();
  await pool.query("INSERT INTO users(id,email,password_hash,role,email_verified) " +
    "VALUES(1,'ocv5308-operator-fixture@example.test','fixture-not-login','admin',TRUE)");
  const allowed = manifest.existing_active_enabled.map((row) => row.catalog.model_id);
  const extra = await pool.query("SELECT entry_id,lock_version FROM model_catalog WHERE state='active' AND NOT(model_id=ANY($1::text[]))", [allowed]);
  for (const row of extra.rows) await pool.query("SELECT fn_model_disable_entry($1,$2,1)",
    [row.entry_id, row.lock_version]);
  for (const target of manifest.existing_active_enabled) {
    let old = (await pool.query(
      "SELECT * FROM model_catalog WHERE model_id=$1 AND state IN ('active','disabled') ORDER BY (state='active') DESC,entry_id DESC LIMIT 1",
      [target.catalog.model_id])).rows[0];
    if (!old && target.catalog.model_id === "oc-catalog-canary-glm52") {
      // This hidden row is installed by the real runtime canary operator,
      // not by migration replay. Only this explicit exception is seeded.
      const staged = await pool.query("SELECT fn_model_stage_version($1,$2,$3,$4,$5,$6::jsonb,$7,1) AS id",
        [target.catalog.model_id,target.catalog.engine,target.catalog.provider_id,
          target.catalog.upstream_model_id,target.catalog.context_window,
          JSON.stringify(target.catalog.capability_profile),target.catalog.capability_schema_version]);
      await pool.query("INSERT INTO model_pricing(model_id,display_name,input_per_mtok,output_per_mtok," +
        "cache_read_per_mtok,cache_write_per_mtok,multiplier,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,FALSE)",
        [target.catalog.model_id,...["display_name","input_per_mtok","output_per_mtok",
          "cache_read_per_mtok","cache_write_per_mtok","multiplier"].map((key)=>target.pricing[key])]);
      old=(await pool.query("SELECT * FROM model_catalog WHERE entry_id=$1",[staged.rows[0].id])).rows[0];
    }
    assert.ok(old, "full migration chain must contain frozen existing " + target.catalog.model_id);
    if (digest(Object.fromEntries(catalogKeys.map((key) => [key, old[key]]))) !==
      digest(Object.fromEntries(catalogKeys.map((key) => [key, target.catalog[key]])))) {
      const switched = await pool.query("SELECT fn_model_switch_version($1,$2,$3,$4,$5,$6::jsonb,$7,1,$8) AS id",
        [target.catalog.model_id,target.catalog.engine,target.catalog.provider_id,
          target.catalog.upstream_model_id,target.catalog.context_window,
          JSON.stringify(target.catalog.capability_profile),target.catalog.capability_schema_version,old.lock_version]);
      old = (await pool.query("SELECT * FROM model_catalog WHERE entry_id=$1",[switched.rows[0].id])).rows[0];
    }
    if (old.state === "disabled" || old.state === "staged") await pool.query("SELECT fn_model_activate_entry($1,$2,1)",
      [old.entry_id,old.lock_version]);
    const updated = await pool.query("UPDATE model_pricing SET " +
      priceKeys.map((key,i) => key+"=$"+(i+2)).join(",") +
      ",lock_version=lock_version+1,updated_by=1,updated_at=now() WHERE model_id=$1 RETURNING model_id",
      [target.catalog.model_id,...priceKeys.map((key) => target.pricing[key])]);
    assert.equal(updated.rowCount,1);
    if (target.catalog.model_id === "oc-catalog-canary-glm52") {
      await pool.query("SELECT fn_model_alias_set('oc-catalog-canary',$1,1)",[target.catalog.model_id]);
      await pool.query("INSERT INTO model_visibility_grants(user_id,model_id,granted_by) " +
        "VALUES(1,'oc-catalog-canary-glm52',1)");
    }
  }
  for (const [provider,donor] of [["claude","claude-opus-5"],["cursor","cursor-grok-4.6-high"],
    ["grok","grok-build"],["codex","gpt-5.6-sol"]]) {
    const group = await pool.query("INSERT INTO account_groups(label,provider,kind,enabled) " +
      "VALUES($1,$2,'official_oauth',TRUE) RETURNING id",["Operator fixture "+provider,provider]);
    await pool.query("INSERT INTO account_group_models(group_id,model_id) VALUES($1,$2)",
      [group.rows[0].id,donor]);
    if(provider==="codex") await pool.query("INSERT INTO account_group_models(group_id,model_id) " +
      "VALUES($1,'gpt-5.6-luna')",[group.rows[0].id]);
  }
  await runMigrations();
}
function request(runId: string): WriteRequest {
  return { runId,nonce,observation,readiness:ready };
}
function registerFixedGroup(group: "A" | "B" | "C" | "D" | "E") {
db = useDedicatedTestDatabase("commercial_model_release_operator_"+group.toLowerCase()+"_test");
describe("actual PG model release operator", () => {
before(async () => {
  assert.equal(db.available,true,"parent dedicated DB before hook must have completed");
  assert.equal(process.geteuid?.(),0,"actual host root fixture required");
  root = await mkdtemp(join(tmpdir(),"ocv5-308-operator-"));
  const releasesRoot = join(root,"releases"); await mkdir(releasesRoot);
  const sourceCommit="2188af24d8e451abb0a36259700b769ddc8f3719";
  const builtAt="20261003-120000", short=sourceCommit.slice(0,9);
  const release=join(releasesRoot,"rel-"+short+"-"+builtAt);
  fixtureRelease=release;
  await mkdir(join(release,"deploy/v5"),{recursive:true});
  const metadata=Buffer.from(JSON.stringify({requiredMigrations:["0293_commercial_new_models_prepare"]}));
  await writeFile(join(release,"deploy/v5/release-metadata.json"),metadata);
  await writeFile(join(release,"VERSION.json"),JSON.stringify({commit:short}));
  await writeFile(join(release,".complete"),JSON.stringify({schemaVersion:2,sourceCommit,builtAt,
    metadataSha256:createHash("sha256").update(metadata).digest("hex"),artifactSha256:"a".repeat(64)}));
  await mkdir(join(root,"lease"));
  context={manifest,prepareSqlSha256:createHash("sha256").update(prepare).digest("hex"),
    releasesRoot,leasePaths:{commonNonce:join(root,"lease/production-mutation.lock.admission-nonce"),manualNonce:join(root,"lease/production-mutation.lock.manual-holder"),lock:join(root,"lease/production-mutation.lock")}};
  await seedProductionFloor();
  await getPool().query("UPDATE deploy_state SET active_release=$1,phase='stable' WHERE singleton",[release]);
  await issueLease();
  observation=await withClient((client)=>observe(client,context));
  ready={schema:1,manifestSha256:observation.manifestSha256,sourceCommit,
    metadataSha256:observation.release.metadataSha256,prepareSqlSha256:context.prepareSqlSha256,
    runtimeReady:true,credentialsReady:true,compatibilityReady:true,evidenceSha256:[digest({fixture:true})]};
});
after(async()=>{await stopHolder();if(root)await rm(root,{recursive:true,force:true});});

function scenario01() {
test("explicit authorized DSN and all non-null catalog CAS inputs fail closed",()=>{
  assert.throws(()=>explicitOperatorDsn({DATABASE_URL:db.url}),/EXPLICIT_AUTHORIZED/);
  for(const value of [null,undefined,-1,1.5,"1",2147483648])assert.throws(()=>expectedVersion(value));
  assert.equal(expectedVersion(0),0);
  const override=new URL(db.url);override.searchParams.set("host","wrong");
  assert.throws(()=>explicitOperatorDsn({OC_V5_MODEL_RELEASE_DATABASE_URL:override.href}),/ENDPOINT_OVERRIDE/);
});
}

function scenario02() {
test("read-only preflight refuses actual 0144 deploy role and performs no model writes",async()=>{
  const role="ocv5308_deploy_"+process.pid;
  const before=await withClient(readSnapshot);
  const client=await connect();
  try{
    await client.query('CREATE ROLE "'+role+'"');
    await client.query("GRANT USAGE ON SCHEMA public TO "+role);
    await client.query("SELECT fn_model_authority_grant_deploy_role($1)",[role]);
    await client.query("SET ROLE "+role);
    await assert.rejects(permissionPreflight(client),/OPERATOR_PRIVILEGES_INSUFFICIENT/);
    await assert.rejects(apply(client,context,request("denied_deploy_role")),/OPERATOR_PRIVILEGES_INSUFFICIENT/);
    await client.query("RESET ROLE");
    assert.deepEqual(await readSnapshot(client),before);
  }finally{
    await client.query("RESET ROLE").catch(()=>{});
    await client.query("DROP OWNED BY "+role).catch(()=>{});
    await client.query("DROP ROLE IF EXISTS "+role).catch(()=>{});
    await client.end();
  }
});
}

function scenario03() {
test("stale snapshot or expired/wrong-type/wrong-primary proof refuses all activation atomically",async()=>{
  const proofPath=context.leasePaths!.commonNonce+".db";
  const original=await readFile(proofPath);
  const before=await withClient(readSnapshot);
  for(const change of [
    {expiresAt:1}, {holderStart:"1"}, {database:"not_this_primary_test"}, {nonce:"f".repeat(32)},
  ]){
    const proof={...JSON.parse(original.toString()),...change};
    await writeFile(proofPath,JSON.stringify(proof));
    await assert.rejects(withClient((client)=>apply(client,context,request("invalid_proof_"+Object.keys(change)[0]))));
    assert.deepEqual(await withClient(readSnapshot),before);
  }
  await writeFile(proofPath,original);
  const stale=structuredClone(observation);stale.snapshot.tables.model_pricing[0].lock_version+=1;
  stale.snapshotSha256=digest(stale.snapshot);
  await assert.rejects(withClient((client)=>apply(client,context,{...request("stale_snapshot_case"),observation:stale})),
    /OBSERVED_STATE_CAS_CONFLICT/);
  assert.deepEqual(await withClient(readSnapshot),before);
});
}

let activated: Receipt;
let compensatedReceipt: Receipt;
function scenario04() {
test("owner activates exact frozen17 plus Grok, preserves old33 permissions/prices, receipt reconciles and exact replay is side-effect free",async()=>{
  activated=await withClient((client)=>apply(client,context,request("actual_owner_activation")));
  assert.equal(activated.operation,"activate");
  assert.equal(activated.after.tables.model_catalog.filter((row)=>
    manifest.new_models.some((spec)=>spec.model_id===row.model_id)&&row.state==="active").length,17);
  assert.equal(activated.after.tables.model_pricing.find((row)=>row.model_id==="grok-build")!.multiplier,2);
  const before=await withClient(readSnapshot);
  const replay=await withClient((client)=>apply(client,context,request("actual_owner_activation")));
  assert.deepEqual(replay,activated);
  assert.deepEqual(await withClient(readSnapshot),before);
  assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release' AND target='actual_owner_activation'")).rowCount,1);
  const result=await withClient((client)=>reconcile(client,activated.runId,activated.requestSha256,activated.manifestSha256,context));
  assert.equal(result.kind,"committed");
  assert.deepEqual(await withClient(readSnapshot),before);
});
}

function scenario05() {
test("exact receipt compensation hides17 and restores Grok with a new version, never revives retired history",async()=>{
  const compensated=await withClient((client)=>compensate(client,context,
    request("actual_owner_compensation"),activated.runId));
  compensatedReceipt=compensated;
  assert.equal(compensated.operation,"compensate");
  assert.equal(compensated.after.tables.model_catalog.filter((row)=>
    manifest.new_models.some((spec)=>spec.model_id===row.model_id)&&row.state==="disabled").length,17);
  const restored=compensated.after.tables.model_catalog.find((row)=>row.model_id==="grok-build"&&row.state==="active")!;
  const original=activated.before.tables.model_catalog.find((row)=>row.model_id==="grok-build"&&row.state==="active")!;
  assert.notEqual(restored.entry_id,original.entry_id);
  assert.equal(restored.upstream_model_id,original.upstream_model_id);
  assert.equal(compensated.after.tables.model_pricing.find((row)=>row.model_id==="grok-build")!.multiplier,1);
  assert.equal(compensated.after.tables.model_pricing.find((row)=>row.model_id==="gpt-6-astra-1m")!.enabled,false);
  assert.deepEqual(await withClient((client)=>compensate(client,context,
    request("actual_owner_compensation"),activated.runId)),compensated);
});
}

function scenario06() {
test("RR reconciliation rejects only deploy-state drift even when all model tables remain exact",async()=>{
  const before=await withClient(readSnapshot);
  await getPool().query("UPDATE deploy_state SET generation=generation+1,lock_version=lock_version+1 WHERE singleton");
  await assert.rejects(withClient((client)=>reconcile(client,compensatedReceipt.runId,
    compensatedReceipt.requestSha256,compensatedReceipt.manifestSha256,context)),
    /RECONCILIATION_RELEASE_CONFLICT/);
  assert.deepEqual(await withClient(readSnapshot),before);
});
}

function scenario07() {
test("absent receipt remains UNKNOWN and never initiates apply",async()=>{
  const before=await withClient(readSnapshot);
  const result=await withClient((client)=>reconcile(client,"no_receipt_run",digest("unknown"),digest(manifest),context));
  assert.deepEqual(result,{kind:"unknown"});
  assert.deepEqual(await withClient(readSnapshot),before);
});
}

// Each CLI invocation gets a real private mount namespace. Fixed production
// paths are backed only by this _test fixture; no live/donor path is touched.
async function privateCli(args: string[], options: { limitOutput?: boolean; nonRoot?: boolean } = {}) {
  const trace = join(root,"namespace-"+randomBytes(8).toString("hex"));
  const parent = await readFile("/proc/self/mountinfo","utf8");
  const script = [
    "set -euo pipefail; umask 077",
    'printf "%s\\n" "$(readlink /proc/self/ns/mnt)" > "$CB_TRACE.ns"',
    'cat /proc/self/mountinfo > "$CB_TRACE.mountinfo.before"',
    '! grep -Eq " (shared|master):" /proc/self/mountinfo',
    // Cover existing parents before any mkdir; namespace != filesystem isolation.
    'mount -t tmpfs -o mode=755,size=16m tmpfs /run',
    'mount -t tmpfs -o mode=755,size=32m tmpfs /opt',
    'mkdir -p /run/openclaude-v5 /opt/openclaude/openclaude-v5-releases /opt/ocv5308-cli/ops/ocv5-308 /opt/ocv5308-cli/packages/commercial/src/db/migrations /opt/ocv5308-cli/node_modules',
    // These parents are new private tmpfs nodes, never bind sources.
    'chmod 755 /opt/ocv5308-cli /opt/ocv5308-cli/ops /opt/ocv5308-cli/ops/ocv5-308',
    'mount --bind "$CB_LEASE" /run/openclaude-v5',
    'mount --bind "$CB_RELEASES" /opt/openclaude/openclaude-v5-releases',
    'touch /opt/ocv5308-cli/ops/ocv5-308/model-release-operator.mjs /opt/ocv5308-cli/ops/ocv5-308/model-release-manifest.json /opt/ocv5308-cli/packages/commercial/src/db/migrations/0293_commercial_new_models_prepare.sql /opt/ocv5308-cli/node',
    'mount --bind "$CB_BUNDLE" /opt/ocv5308-cli/ops/ocv5-308/model-release-operator.mjs',
    'mount --bind "$CB_MANIFEST" /opt/ocv5308-cli/ops/ocv5-308/model-release-manifest.json',
    'mount --bind "$CB_SQL" /opt/ocv5308-cli/packages/commercial/src/db/migrations/0293_commercial_new_models_prepare.sql',
    'mount --bind "$CB_MODULES" /opt/ocv5308-cli/node_modules',
    'mount --bind "$CB_NODE" /opt/ocv5308-cli/node',
    'if [ "$CB_LIMIT_OUTPUT" = 1 ]; then mkdir /run/ocv5308-output; mount -t tmpfs -o mode=755,size=4096 tmpfs /run/ocv5308-output; fi',
    'cat /proc/self/mountinfo > "$CB_TRACE.mountinfo.after"',
    'if [ "$CB_NONROOT" = 1 ]; then exec setpriv --reuid 65534 --regid 65534 --clear-groups /opt/ocv5308-cli/node /opt/ocv5308-cli/ops/ocv5-308/model-release-operator.mjs "$@"; fi',
    'exec /opt/ocv5308-cli/node /opt/ocv5308-cli/ops/ocv5-308/model-release-operator.mjs "$@"',
  ].join("\n");
  const child = spawn("unshare", ["--mount","--propagation","private","bash","-c",script,
    "fixture-private-namespace",...args], { detached:true, env: { ...process.env,
      OC_V5_MODEL_RELEASE_DATABASE_URL: db.url, OC_V5_MUTATION_ADMISSION_NONCE:nonce,
      CB_TRACE:trace, CB_LEASE:join(root,"lease"), CB_RELEASES:context.releasesRoot!,
      CB_BUNDLE:join(root,"model-release-operator.mjs"),
      CB_MANIFEST:fileURLToPath(new URL("../../../../../ops/ocv5-308/model-release-manifest.json",import.meta.url)),
      CB_SQL:fileURLToPath(new URL("../../db/migrations/0293_commercial_new_models_prepare.sql",import.meta.url)),
      CB_MODULES:await realpath(fileURLToPath(new URL("../../../../../node_modules",import.meta.url))),
      CB_NODE:process.execPath, CB_LIMIT_OUTPUT:options.limitOutput?"1":"0", CB_NONROOT:options.nonRoot?"1":"0",
    }, stdio:["ignore","pipe","pipe"] });
  let stdout="",stderr="";
  child.stdout.on("data",(chunk)=>{stdout+=chunk.toString();});
  child.stderr.on("data",(chunk)=>{stderr+=chunk.toString();});
  let expired=false;
  const deadline=setTimeout(()=>{expired=true;try{process.kill(-child.pid!,"SIGTERM");}catch{}},15000);
  const [code,signal]=await once(child,"exit"); clearTimeout(deadline);
  assert.equal(expired,false,"actual CLI must terminate without consuming the fixture lease TTL");
  assert.equal(signal,null,"namespace CLI must exit normally");
  const childNamespace=(await readFile(trace+".ns","utf8")).trim();
  const parentNamespace=await readlink("/proc/self/ns/mnt");
  assert.notEqual(childNamespace,parentNamespace);
  const beforeMounts=await readFile(trace+".mountinfo.before","utf8");
  assert.equal(/ (?:shared|master):/.test(beforeMounts),false,"mount propagation must be private BEFORE mounting");
  assert.equal(await readFile("/proc/self/mountinfo","utf8"),parent,"host mount topology unchanged");
  const afterMounts=await readFile(trace+".mountinfo.after","utf8");
  console.log("OPERATOR_NAMESPACE_EVIDENCE "+JSON.stringify({
    childNamespace,parentNamespace,privatePropagation:true,hostUnchanged:true,
    beforeSha256:createHash("sha256").update(beforeMounts).digest("hex"),
    afterSha256:createHash("sha256").update(afterMounts).digest("hex"),
    hostSha256:createHash("sha256").update(parent).digest("hex"),
    nonRoot:!!options.nonRoot,limitOutput:!!options.limitOutput,code,
  }));
  return {code:code as number,stdout,stderr,trace};
}
async function resetFixture() {
  await stopHolder();
  await seedProductionFloor();
  await getPool().query("UPDATE deploy_state SET active_release=$1,phase='stable',generation=generation+1,lock_version=lock_version+1 WHERE singleton",[fixtureRelease]);
  await issueLease();
  observation=await withClient((client)=>observe(client,context));
  ready={...ready,manifestSha256:observation.manifestSha256,
    sourceCommit:observation.release.sourceCommit,metadataSha256:observation.release.metadataSha256};
}
async function configureCliFixture() {
  await resetFixture();
  await getPool().query("UPDATE deploy_state SET active_release=$1,lock_version=lock_version+1 WHERE singleton",
    ["/opt/openclaude/openclaude-v5-releases/"+fixtureRelease.split("/").at(-1)]);
  const bundle=join(root,"model-release-operator.mjs");
  buildSync({ entryPoints:[fileURLToPath(new URL("../../../../../ops/ocv5-308/model-release-operator.ts",import.meta.url))],
    outfile:bundle,platform:"node",format:"esm",packages:"external",bundle:true });
  await chmod(bundle,0o644);
  const output=join(root,"cli-observation-"+randomBytes(8).toString("hex")+".json");
  const result=await privateCli(["observe","--out",output]);
  assert.equal(result.code,0,result.stderr);
  const observed=JSON.parse(await readFile(output,"utf8")) as Observation;
  const readiness=join(root,"cli-readiness-"+randomBytes(8).toString("hex")+".json");
  await writeFile(readiness,JSON.stringify({...ready,manifestSha256:observed.manifestSha256,
    sourceCommit:observed.release.sourceCommit,metadataSha256:observed.release.metadataSha256}),{mode:0o600});
  return {output,readiness,observed};
}
function scenario08() {
test("actual fixed-path CLI refuses existing output and malformed authority files before DML",async()=>{
  const cli=await configureCliFixture();
  const before=await withClient(readSnapshot);
  const existing=join(root,"existing-output.json");await writeFile(existing,"existing",{mode:0o600});
  const existingResult=await privateCli(["apply","--observation",cli.output,"--readiness",cli.readiness,
    "--run-id","cli_existing_output","--out",existing]);
  assert.equal(existingResult.code,1,existingResult.stderr);
  assert.equal(await readFile(existing,"utf8"),"existing");
  assert.deepEqual(await withClient(readSnapshot),before);
  assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release'")).rowCount,0);

  const fifo=join(root,"readiness-fifo");await new Promise<void>((resolve,reject)=>{
    const child=spawn("mkfifo",["-m","600",fifo]);child.once("error",reject);
    child.once("exit",(code)=>code===0?resolve():reject(new Error("mkfifo:"+code)));
  });
  const started=Date.now();
  const fifoResult=await privateCli(["apply","--observation",cli.output,"--readiness",fifo,
    "--run-id","cli_fifo_readiness","--out",join(root,"fifo-refused-output.json")]);
  assert.equal(fifoResult.code,1,fifoResult.stderr);
  assert.ok(Date.now()-started<5000,"FIFO rejected promptly with no writer, not via lease timeout");
  assert.deepEqual(await withClient(readSnapshot),before);

  const proofPath=context.leasePaths!.commonNonce+".db";
  const original=await readFile(proofPath);
  for(const patch of [{holderStart:"1"},{expiresAt:1},{database:"wrong_primary_test"}]){
    await writeFile(proofPath,JSON.stringify({...JSON.parse(original.toString()),...patch}));
    const result=await privateCli(["apply","--observation",cli.output,"--readiness",cli.readiness,
      "--run-id","cli_invalid_"+Object.keys(patch)[0],"--out",join(root,"invalid-"+Object.keys(patch)[0]+".json")]);
    assert.equal(result.code,1,result.stderr);
    assert.deepEqual(await withClient(readSnapshot),before);
  }
  await writeFile(proofPath,original);
  const nonRoot=await privateCli(["observe","--out","/run/nonroot-output.json"],{nonRoot:true});
  assert.equal(nonRoot.code,1,nonRoot.stderr);
  assert.match(nonRoot.stderr,/MODEL_RELEASE_OPERATOR_REFUSED/);
  assert.deepEqual(await withClient(readSnapshot),before);
});
}
function scenario09() {
test("real COMMIT followed by actual tmpfs ENOSPC reports committed identity and real CLI reconciliation without reapply",async()=>{
  const cli=await configureCliFixture();
  const result=await privateCli(["apply","--observation",cli.output,"--readiness",cli.readiness,
    "--run-id","cli_committed_enospc","--out","/run/ocv5308-output/receipt.json"],{limitOutput:true});
  assert.equal(result.code,74,result.stderr);
  const status=JSON.parse(result.stderr.trim());
  assert.equal(status.status,"committed_local_output_failed");
  assert.equal(status.runId,"cli_committed_enospc");
  assert.match(status.requestSha256,/^[0-9a-f]{64}$/);
  assert.equal(status.manifestSha256,digest(manifest));
  const rows=await getPool().query("SELECT after FROM admin_audit WHERE action='ocv5-308.model-release' AND target=$1",[status.runId]);
  assert.equal(rows.rowCount,1,"receipt actually committed to PG before kernel output failure");
  const receipt=rows.rows[0].after as Receipt;
  const actual=await withClient(readSnapshot);
  assert.deepEqual(actual,receipt.after);
  assert.equal(actual.tables.model_catalog.filter((row)=>manifest.new_models.some((spec)=>spec.model_id===row.model_id)&&row.state==="active").length,17);
  const output=join(root,"cli-reconciliation.json");
  const reconciled=await privateCli(["reconcile","--run-id",status.runId,"--request-sha256",status.requestSha256,
    "--manifest-sha256",status.manifestSha256,"--out",output]);
  assert.equal(reconciled.code,0,reconciled.stderr);
  assert.equal(JSON.parse(await readFile(output,"utf8")).kind,"committed");
  assert.deepEqual(await withClient(readSnapshot),actual);
  assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release' AND target=$1",[status.runId])).rowCount,1);
});
}

function scenario10() {
test("late old invocation cannot activate after a real successor holder replaces its nonce",async()=>{
  await resetFixture();
  const oldRequest=request("late_old_nonce_rejected");
  await stopHolder();await issueLease();
  assert.notEqual(oldRequest.nonce,nonce);
  const before=await withClient(readSnapshot);
  const audit=await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'");
  await assert.rejects(withClient((client)=>apply(client,context,oldRequest)),/STALE_INVOCATION_NONCE/);
  assert.deepEqual(await withClient(readSnapshot),before);
  assert.deepEqual((await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'")).rows,audit.rows);
});
}

const driftCases: Array<[string,(client:Client)=>Promise<unknown>,RegExp]>=[
  ["catalog",async(client)=>{
    const old=observation.snapshot.tables.model_catalog.find((row)=>row.model_id==="grok-build"&&row.state==="active")!;
    await client.query("SELECT fn_model_switch_version($1,$2,$3,$4,$5,$6::jsonb,$7,1,$8)",
      [old.model_id,old.engine,old.provider_id,old.upstream_model_id,Number(old.context_window)+1,
        JSON.stringify(old.capability_profile),old.capability_schema_version,old.lock_version]);
  },/OBSERVED_STATE_CAS_CONFLICT/],
  ["pricing",async(client)=>{
    const old=observation.snapshot.tables.model_pricing.find((row)=>row.model_id==="grok-build")!;
    const result=await client.query("UPDATE model_pricing SET input_per_mtok=input_per_mtok+1,lock_version=lock_version+1,updated_by=1 WHERE model_id=$1 AND lock_version=$2 RETURNING model_id",[old.model_id,old.lock_version]);
    assert.equal(result.rowCount,1);
  },/OBSERVED_STATE_CAS_CONFLICT/],
  ["binding",async(client)=>{
    const old=observation.snapshot.tables.account_group_models.find((row)=>row.model_id==="grok-build")!;
    assert.ok(old);assert.equal((await client.query("DELETE FROM account_group_models WHERE group_id=$1 AND model_id=$2 RETURNING model_id",[old.group_id,old.model_id])).rowCount,1);
  },/OBSERVED_STATE_CAS_CONFLICT/],
  ["permission",async(client)=>{
    assert.equal((await client.query("DELETE FROM model_visibility_grants WHERE user_id=1 AND model_id='oc-catalog-canary-glm52' RETURNING model_id")).rowCount,1);
  },/OBSERVED_STATE_CAS_CONFLICT/],
  ["alias",async(client)=>{
    assert.equal((await client.query("SELECT 1 FROM model_aliases WHERE alias='oc-catalog-canary'")).rowCount,1);
    await client.query("SELECT fn_model_alias_remove('oc-catalog-canary')");
  },/OBSERVED_STATE_CAS_CONFLICT/],
  ["exclusion",async(client)=>{
    const old=observation.snapshot.tables.model_pricing.find((row)=>row.model_id==="gpt-6-astra-1m")!;
    assert.equal(old.enabled,false);
    assert.equal((await client.query("UPDATE model_pricing SET extra_system_prompt='legitimate admin exclusion annotation',lock_version=lock_version+1,updated_by=1 WHERE model_id=$1 AND lock_version=$2 RETURNING model_id",[old.model_id,old.lock_version])).rowCount,1);
  },/OBSERVED_STATE_CAS_CONFLICT/],
  ["release",async(client)=>{
    assert.equal((await client.query("UPDATE deploy_state SET generation=generation+1,lock_version=lock_version+1 WHERE singleton RETURNING singleton")).rowCount,1);
  },/LIVE_RELEASE_CAS_CONFLICT/],
];
function scenario11() {
const [name,mutate,error] = driftCases[0]!;
test("actual "+name+" admin drift is retained while stale activation refuses every operator effect",async()=>{
  await resetFixture();
  await withClient(mutate);
  const changed=await withClient(readSnapshot);
  if(name!=="release")assert.notEqual(digest(changed),observation.snapshotSha256);
  const audit=await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'");
  await assert.rejects(withClient((client)=>apply(client,context,request("stale_real_"+name))),error);
  assert.deepEqual(await withClient(readSnapshot),changed,"must preserve the legitimate admin change");
  assert.deepEqual((await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'")).rows,audit.rows);
});
}

function scenario12() {
const [name,mutate,error] = driftCases[1]!;
test("actual "+name+" admin drift is retained while stale activation refuses every operator effect",async()=>{
  await resetFixture();
  await withClient(mutate);
  const changed=await withClient(readSnapshot);
  if(name!=="release")assert.notEqual(digest(changed),observation.snapshotSha256);
  const audit=await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'");
  await assert.rejects(withClient((client)=>apply(client,context,request("stale_real_"+name))),error);
  assert.deepEqual(await withClient(readSnapshot),changed,"must preserve the legitimate admin change");
  assert.deepEqual((await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'")).rows,audit.rows);
});
}

function scenario13() {
const [name,mutate,error] = driftCases[2]!;
test("actual "+name+" admin drift is retained while stale activation refuses every operator effect",async()=>{
  await resetFixture();
  await withClient(mutate);
  const changed=await withClient(readSnapshot);
  if(name!=="release")assert.notEqual(digest(changed),observation.snapshotSha256);
  const audit=await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'");
  await assert.rejects(withClient((client)=>apply(client,context,request("stale_real_"+name))),error);
  assert.deepEqual(await withClient(readSnapshot),changed,"must preserve the legitimate admin change");
  assert.deepEqual((await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'")).rows,audit.rows);
});
}

function scenario14() {
const [name,mutate,error] = driftCases[3]!;
test("actual "+name+" admin drift is retained while stale activation refuses every operator effect",async()=>{
  await resetFixture();
  await withClient(mutate);
  const changed=await withClient(readSnapshot);
  if(name!=="release")assert.notEqual(digest(changed),observation.snapshotSha256);
  const audit=await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'");
  await assert.rejects(withClient((client)=>apply(client,context,request("stale_real_"+name))),error);
  assert.deepEqual(await withClient(readSnapshot),changed,"must preserve the legitimate admin change");
  assert.deepEqual((await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'")).rows,audit.rows);
});
}

function scenario15() {
const [name,mutate,error] = driftCases[4]!;
test("actual "+name+" admin drift is retained while stale activation refuses every operator effect",async()=>{
  await resetFixture();
  await withClient(mutate);
  const changed=await withClient(readSnapshot);
  if(name!=="release")assert.notEqual(digest(changed),observation.snapshotSha256);
  const audit=await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'");
  await assert.rejects(withClient((client)=>apply(client,context,request("stale_real_"+name))),error);
  assert.deepEqual(await withClient(readSnapshot),changed,"must preserve the legitimate admin change");
  assert.deepEqual((await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'")).rows,audit.rows);
});
}

function scenario16() {
const [name,mutate,error] = driftCases[5]!;
test("actual "+name+" admin drift is retained while stale activation refuses every operator effect",async()=>{
  await resetFixture();
  await withClient(mutate);
  const changed=await withClient(readSnapshot);
  if(name!=="release")assert.notEqual(digest(changed),observation.snapshotSha256);
  const audit=await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'");
  await assert.rejects(withClient((client)=>apply(client,context,request("stale_real_"+name))),error);
  assert.deepEqual(await withClient(readSnapshot),changed,"must preserve the legitimate admin change");
  assert.deepEqual((await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'")).rows,audit.rows);
});
}

function scenario17() {
const [name,mutate,error] = driftCases[6]!;
test("actual "+name+" admin drift is retained while stale activation refuses every operator effect",async()=>{
  await resetFixture();
  await withClient(mutate);
  const changed=await withClient(readSnapshot);
  if(name!=="release")assert.notEqual(digest(changed),observation.snapshotSha256);
  const audit=await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'");
  await assert.rejects(withClient((client)=>apply(client,context,request("stale_real_"+name))),error);
  assert.deepEqual(await withClient(readSnapshot),changed,"must preserve the legitimate admin change");
  assert.deepEqual((await getPool().query("SELECT count(*)::int AS n FROM admin_audit WHERE action='ocv5-308.model-release'")).rows,audit.rows);
});
}

function scenario18() {
test("fourth actual activation fault rolls back earlier three real activations, epoch and receipt",async()=>{
  await resetFixture();
  const ids=manifest.new_models.map((row)=>row.model_id).sort();
  assert.match(ids[3],/^[a-zA-Z0-9_.-]+$/);
  const client=await connect();
  const reached:string[]=[];
  const noticeListener=(notice: {message?:string})=>{if(notice.message?.startsWith("OCV5308_ACTIVATION_REACHED:"))reached.push(notice.message.slice("OCV5308_ACTIVATION_REACHED:".length));};
  client.on("notice",noticeListener);
  try{
    await client.query("CREATE FUNCTION ocv5308_fixture_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='active' AND OLD.state='staged' AND NEW.model_id='"+ids[3]+"' THEN RAISE EXCEPTION 'OCV5308_FOURTH_ACTIVATION_FAULT'; END IF; RETURN NEW; END $$; CREATE TRIGGER ocv5308_fixture_fault BEFORE UPDATE ON model_catalog FOR EACH ROW EXECUTE FUNCTION ocv5308_fixture_fault()");
    await client.query("CREATE FUNCTION ocv5308_fixture_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.state IS DISTINCT FROM 'active' AND NEW.state='active' AND NEW.model_id IN ('"+ids.slice(0,3).join("','")+"') THEN RAISE NOTICE 'OCV5308_ACTIVATION_REACHED:%',NEW.model_id; END IF; RETURN NEW; END $$; CREATE TRIGGER ocv5308_fixture_notice AFTER UPDATE ON model_catalog FOR EACH ROW EXECUTE FUNCTION ocv5308_fixture_notice()");
    const before=await readSnapshot(client);
    await assert.rejects(apply(client,context,request("mid_activation_real_fault")),/OCV5308_FOURTH_ACTIVATION_FAULT/);
    assert.deepEqual(reached,ids.slice(0,3),"three real AFTER UPDATE notices prove earlier DML executed before rollback");
    assert.deepEqual(await readSnapshot(client),before);
    assert.equal((await client.query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release'")).rowCount,0);
    console.log("OPERATOR_ROLLBACK_EVIDENCE "+JSON.stringify({reached,failedModel:ids[3],snapshotAndEpochRestored:true,receipts:0}));
  }finally{
    await client.query("DROP TRIGGER IF EXISTS ocv5308_fixture_fault ON model_catalog; DROP TRIGGER IF EXISTS ocv5308_fixture_notice ON model_catalog; DROP FUNCTION IF EXISTS ocv5308_fixture_fault(); DROP FUNCTION IF EXISTS ocv5308_fixture_notice()");
    client.removeListener("notice",noticeListener);
    await client.end();
  }
});
}

function scenario19() {
test("actual CLI refuses directory, non-root owned readiness and symlink without DML",async()=>{
  const cli=await configureCliFixture();
  const before=await withClient(readSnapshot);
  const directory=join(root,"readiness-directory");await mkdir(directory,{mode:0o600});
  const wrongOwner=join(root,"readiness-wrong-owner.json");await writeFile(wrongOwner,await readFile(cli.readiness),{mode:0o600});await chown(wrongOwner,65534,65534);
  const link=join(root,"readiness-symlink.json");await symlink(cli.readiness,link);
  for(const [name,path] of [["directory",directory],["owner",wrongOwner],["symlink",link]]){
    const result=await privateCli(["apply","--observation",cli.output,"--readiness",path,
      "--run-id","cli_bad_file_"+name,"--out",join(root,"file-refused-"+name+".json")]);
    assert.equal(result.code,1,result.stderr);assert.match(result.stderr,/MODEL_RELEASE_OPERATOR_REFUSED/);
    assert.deepEqual(await withClient(readSnapshot),before);
    assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release'")).rowCount,0);
  }
});
}

function scenario20() {
test("compensation never overwrites a subsequent legitimate admin pricing CAS change",async()=>{
  await resetFixture();
  const receipt=await withClient((client)=>apply(client,context,request("compensation_drift_activation")));
  const old=receipt.after.tables.model_pricing.find((row)=>row.model_id==="grok-build")!;
  assert.equal((await getPool().query("UPDATE model_pricing SET input_per_mtok=input_per_mtok+1,lock_version=lock_version+1,updated_by=1 WHERE model_id=$1 AND lock_version=$2 RETURNING model_id",[old.model_id,old.lock_version])).rowCount,1);
  const changed=await withClient(readSnapshot);
  await assert.rejects(withClient((client)=>compensate(client,context,request("compensation_drift_rejected"),receipt.runId)),/COMPENSATION_POSTSTATE_CAS_CONFLICT/);
  assert.deepEqual(await withClient(readSnapshot),changed);
  assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release'")).rowCount,1);
});
}

async function wireCommitProxy(mode:"drop-ack"|"hold-commit"|"hold-begin") {
  const target=new URL(db.url);
  const sockets=new Set<Socket>();
  let commitFrame:Buffer|undefined;
  let beginHeld=false;
  let closed:Promise<void>|undefined;
  let releaseFrame:(()=>void)|undefined;
  let sawCommitAck=false;
  let armed=false;
  let backendPid=0;
  let commitResolve:()=>void=()=>{};
  const commitReached=new Promise<void>((resolve)=>{commitResolve=resolve;});
  const server=createTcpServer((front)=>{
    const back=createTcpConnection({host:target.hostname,port:Number(target.port)});
    front.setNoDelay(true);back.setNoDelay(true);
    sockets.add(front);sockets.add(back);
    for(const socket of [front,back]){
      socket.on("error",()=>{front.destroy();back.destroy();});
      socket.on("close",()=>sockets.delete(socket));
    }
    front.on("close",()=>back.destroy());back.on("close",()=>front.destroy());
    let input:Buffer=Buffer.alloc(0),output:Buffer=Buffer.alloc(0),startup=true;
    front.on("data",(chunk)=>{
      input=Buffer.concat([input,chunk]);
      while(input.length>=4){
        if(startup){
          const length=input.readInt32BE(0);assert.ok(length>=8&&length<=16777216);
          if(input.length<length)return;
          assert.equal(input.readInt32BE(4),196608,"fixture proxy supports actual plaintext PG startup only");
          back.write(input.subarray(0,length));input=input.subarray(length);startup=false;continue;
        }
        if(input.length<5)return;
        const length=input.readInt32BE(1)+1;assert.ok(length>=5&&length<=16777216);
        if(input.length<length)return;
        const frame=input.subarray(0,length);input=input.subarray(length);
        const isCommit=frame[0]===81&&frame.subarray(5).toString()==="COMMIT\0";
        if(mode==="hold-begin"&&frame[0]===81&&frame.subarray(5).toString()==="BEGIN\0"){
          beginHeld=true;console.log("OPERATOR_WIRE_PHASE "+JSON.stringify({mode,type:"Q",backendPid,phase:"begin-before-forward",at:Date.now()}));continue;
        }
        if(isCommit){
          console.log("OPERATOR_WIRE_PHASE "+JSON.stringify({mode,type:"Q",backendPid,phase:"commit-before-forward",at:Date.now()}));
          armed=true;
          if(mode==="hold-commit"){
            assert.equal(commitFrame,undefined,"only one actual commit frame may be held");
            commitFrame=Buffer.from(frame);releaseFrame=()=>{back.write(commitFrame!);commitFrame=undefined;};commitResolve();continue;
          }
        }
        back.write(frame);
      }
    });
    back.on("data",(chunk)=>{
      output=Buffer.concat([output,chunk]);
      while(output.length>=5){
        const length=output.readInt32BE(1)+1;assert.ok(length>=5&&length<=16777216);
        if(output.length<length)return;
        const frame=output.subarray(0,length);output=output.subarray(length);
        if(frame[0]===75){assert.equal(frame.length,13);backendPid=frame.readInt32BE(5);}
        if(armed&&frame[0]===67&&frame.subarray(5).toString()==="COMMIT\0"){
          sawCommitAck=true;console.log("OPERATOR_WIRE_PHASE "+JSON.stringify({mode,type:"C",backendPid,phase:"actual-commit-ack",at:Date.now()}));
          if(mode==="drop-ack"){
            commitResolve();front.destroy();back.destroy();return;
          }
        }
        front.write(frame);
      }
    });
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const url=new URL(db.url);url.hostname="127.0.0.1";url.port=String(address.port);
  return {url:url.href,commitReached,release:()=>{assert.ok(releaseFrame);releaseFrame();},
    evidence:()=>({mode,backendPid,sawCommitAck,commitHeld:!!commitFrame,beginHeld}),
    close:()=>{
      if(!closed){
        console.log("OPERATOR_WIRE_PHASE "+JSON.stringify({mode,backendPid,phase:"proxy-closing",at:Date.now()}));
        for(const socket of sockets)socket.destroy();
        closed=new Promise<void>((resolve)=>server.close(()=>resolve()));
      }
      return closed;
    }};
}
async function boundedEvidence<T>(label:string,fn:()=>Promise<T|undefined>,budget=5000):Promise<T>{
  const deadline=Date.now()+budget;
  while(Date.now()<deadline){const value=await fn();if(value!==undefined)return value;await new Promise<void>((resolve)=>setTimeout(resolve,10));}
  throw new Error("bounded evidence timeout: "+label);
}
function scenario21() {
test("actual server COMMIT acknowledgment loss yields UNKNOWN then new connection reconciles one committed receipt without reapply",async()=>{
  await resetFixture();
  const proxy=await wireCommitProxy("drop-ack");
  const client=new Client({connectionString:proxy.url,connectionTimeoutMillis:3000});client.on("error",()=>{});
  await client.connect();
  try{
    let unknown:CommitUnknown|undefined;
    await assert.rejects(apply(client,context,request("real_wire_commit_ack_loss")),(error:unknown)=>{
      assert.ok(error instanceof CommitUnknown);unknown=error;return true;
    });
    assert.ok(unknown);assert.equal(proxy.evidence().sawCommitAck,true);
    const actual=await withClient(readSnapshot);
    const audit=await getPool().query("SELECT after FROM admin_audit WHERE action='ocv5-308.model-release' AND target=$1",[unknown.runId]);
    assert.equal(audit.rowCount,1);
    const receipt=audit.rows[0].after as Receipt;assert.deepEqual(actual,receipt.after);
    assert.equal(actual.tables.model_catalog.filter((row)=>manifest.new_models.some((spec)=>spec.model_id===row.model_id)&&row.state==="active").length,17);
    const result=await withClient((fresh)=>reconcile(fresh,unknown!.runId,unknown!.requestSha256,digest(manifest),context));
    assert.equal(result.kind,"committed");assert.deepEqual(await withClient(readSnapshot),actual);
    assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release' AND target=$1",[unknown.runId])).rowCount,1);
    console.log("OPERATOR_COMMIT_WIRE_EVIDENCE "+JSON.stringify({...proxy.evidence(),status:"unknown_then_committed",receipts:1,noReapply:true}));
  }finally{await client.end().catch(()=>{});await proxy.close();}
});
}

function scenario22() {
test("qualified old transaction keeps actual common and six table locks until real COMMIT, fencing successor helper and valid admin INSERT/DELETE",async()=>{
  await resetFixture();
  const proxy=await wireCommitProxy("hold-commit");
  const client=new Client({connectionString:proxy.url,connectionTimeoutMillis:3000});client.on("error",()=>{});
  await client.connect();
  const peers:Client[]=[];
  const pending:Promise<unknown>[]=[];
  let commitError:unknown;
  const commit=apply(client,context,request("qualified_old_actual_commit")).catch((error)=>{commitError=error;return undefined;});
  try{
    await boundedEvidence("actual COMMIT frame held",async()=>proxy.evidence().commitHeld?true:undefined);
    const oldPid=proxy.evidence().backendPid;assert.ok(oldPid>1);
    const oldState=await getPool().query("SELECT state FROM pg_stat_activity WHERE pid=$1",[oldPid]);
    assert.equal(oldState.rows[0].state,"idle in transaction");
    assert.equal((await getPool().query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted",[oldPid])).rowCount,2);
    assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release' AND target='qualified_old_actual_commit'")).rowCount,0);
    assert.deepEqual(await withClient(readSnapshot),observation.snapshot,"no pre-COMMIT effect visible to independent client");

    await stopHolder();nonce=randomBytes(16).toString("hex");
    const successorNonce=nonce,marker=join(root,"successor-effects-marker");
    const envFile=join(root,"successor-test.env");
    const shellQuote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
    await writeFile(envFile,["DATABASE_URL","MODEL_AUTHORITY_DEPLOY_DATABASE_URL","MODEL_CATALOG_ADMIN_DATABASE_URL"].map((key)=>key+"="+shellQuote(db.url)).join("\n")+"\nOC_EGRESS_SECRET=fixture-not-production\n",{mode:0o600});
    const helper=fileURLToPath(new URL("../../../../../scripts/lib/v5-mutation-admission.sh",import.meta.url));
    holder=spawn("bash",["-c",'set -euo pipefail; umask 077; exec 9>"$1"; flock -x 9; source "$2"; v5_mutation_admission "$3" "$4" "$5" "$(date +%s)" 30 "$PPID"; printf "%s\\n" "$4" > "$6"; printf "ADMITTED\\n" > "$7"; printf "READY\\n"; read -r line',
      "actual-successor-helper",context.leasePaths!.lock,helper,context.leasePaths!.commonNonce,successorNonce,envFile,context.leasePaths!.manualNonce,marker],{stdio:["pipe","pipe","pipe"]});
    let helperError="";holder.stderr.on("data",(data)=>{helperError+=data.toString();});
    const blockedHelper=await boundedEvidence("actual admission helper common PG barrier",async()=>{
      assert.equal(holder.exitCode,null,helperError);
      const result=await getPool().query("SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%production-mutation-admission%'",[oldPid]);
      return result.rows.length===1?result.rows[0]:undefined;
    });
    assert.equal((await readFile(context.leasePaths!.commonNonce,"utf8")).trim(),successorNonce);
    await assert.rejects(stat(marker),{code:"ENOENT"});
    const group=observation.snapshot.tables.account_groups.find((row)=>row.provider==="cursor"&&row.label==="Operator fixture cursor")!;
    const insertModel=manifest.existing_active_enabled.map((row)=>row.catalog).find((row)=>row.provider_id==="cursor"&&!observation.snapshot.tables.account_group_models.some((binding)=>binding.group_id===group.id&&binding.model_id===row.model_id))!;
    assert.ok(group);assert.ok(insertModel);
    const delBinding=observation.snapshot.tables.account_group_models.find((row)=>row.model_id==="grok-build")!;
    const statements:Array<[string,unknown[]]>=[
      ["SELECT fn_model_alias_set('ocv5308-concurrent-alias','oc-catalog-canary-glm52',1)",[]],
      ["SELECT fn_model_alias_remove('oc-catalog-canary')",[]],
      ["INSERT INTO account_group_models(group_id,model_id) VALUES($1,$2)",[group.id,insertModel.model_id]],
      ["DELETE FROM account_group_models WHERE group_id=$1 AND model_id=$2",[delBinding.group_id,delBinding.model_id]],
      ["INSERT INTO model_visibility_grants(user_id,model_id,granted_by) VALUES(1,'grok-build',1)",[]],
      ["DELETE FROM model_visibility_grants WHERE user_id=1 AND model_id='oc-catalog-canary-glm52'",[]],
    ];
    const peerPids:number[]=[];
    for(const [sql,params] of statements){
      const peer=await connect();peers.push(peer);
      peerPids.push((await peer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      pending.push(peer.query(sql,params).then((result)=>{assert.equal(result.rowCount,1);return result;}));
      pending.at(-1)!.catch(()=>{});
    }
    const blockers=await boundedEvidence("all six actual admin DML blocked by operator",async()=>{
      const result=await getPool().query("SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=ANY($1::int[])",[peerPids]);
      return result.rows.length===6&&result.rows.every((row)=>row.blockers.includes(oldPid))?result.rows:undefined;
    });
    await assert.rejects(stat(marker),{code:"ENOENT"});
    assert.equal(proxy.evidence().sawCommitAck,false);
    proxy.release();const receipt=await commit;assert.equal(commitError,undefined);assert.ok(receipt);
    assert.equal(proxy.evidence().sawCommitAck,true);
    await Promise.all(pending);
    await boundedEvidence("successor only effects after actual common COMMIT",async()=>{
      try{return (await readFile(marker,"utf8"))==="ADMITTED\n"?true:undefined;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
    });
    assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release' AND target=$1",[receipt.runId])).rowCount,1);
    assert.equal((await getPool().query("SELECT 1 FROM model_aliases WHERE alias='ocv5308-concurrent-alias'")).rowCount,1);
    assert.equal((await getPool().query("SELECT 1 FROM model_aliases WHERE alias='oc-catalog-canary'")).rowCount,0);
    assert.equal((await getPool().query("SELECT 1 FROM account_group_models WHERE group_id=$1 AND model_id=$2",[group.id,insertModel.model_id])).rowCount,1);
    assert.equal((await getPool().query("SELECT 1 FROM account_group_models WHERE group_id=$1 AND model_id=$2",[delBinding.group_id,delBinding.model_id])).rowCount,0);
    assert.equal((await getPool().query("SELECT 1 FROM model_visibility_grants WHERE user_id=1 AND model_id='grok-build'")).rowCount,1);
    assert.equal((await getPool().query("SELECT 1 FROM model_visibility_grants WHERE user_id=1 AND model_id='oc-catalog-canary-glm52'")).rowCount,0);
    console.log("OPERATOR_QUALIFIED_COMMIT_EVIDENCE "+JSON.stringify({...proxy.evidence(),blockedHelper,blockers,successorAfterCommit:true,adminDmlExecuted:6,receipts:1}));
  }finally{
    // On any exception, close transport BEFORE awaiting a possibly future held COMMIT.
    await proxy.close();await commit;
    await Promise.allSettled(pending);for(const peer of peers)await peer.end().catch(()=>{});
    await stopHolder();await client.end().catch(()=>{});
  }
});
}

function scenario23() {
test("actual administrator Astra activation is retained when frozen-observation operator refuses excluded availability drift",async()=>{
  await resetFixture();
  const excluded=observation.snapshot.tables.model_catalog.find((row)=>row.model_id==="gpt-6-astra-1m"&&row.state==="disabled")!;
  assert.ok(excluded);
  assert.equal(observation.snapshot.tables.model_pricing.find((row)=>row.model_id==="gpt-6-astra-1m")!.enabled,false);
  await getPool().query("SELECT fn_model_activate_entry($1,$2,1)",[excluded.entry_id,expectedVersion(excluded.lock_version)]);
  const changed=await withClient(readSnapshot);
  assert.equal(changed.tables.model_catalog.find((row)=>row.entry_id===excluded.entry_id)!.state,"active");
  assert.equal(changed.tables.model_pricing.find((row)=>row.model_id==="gpt-6-astra-1m")!.enabled,true);
  await assert.rejects(withClient((client)=>apply(client,context,request("excluded_availability_drift"))),/OBSERVED_STATE_CAS_CONFLICT/);
  assert.deepEqual(await withClient(readSnapshot),changed);
  assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release'")).rowCount,0);
});
}

function scenario24() {
test("two actual clients with same observe and run id serialize on common lock and commit exactly one receipt and epoch transition",async()=>{
  await resetFixture();
  const proxy=await wireCommitProxy("hold-commit");
  const first=new Client({connectionString:proxy.url,connectionTimeoutMillis:3000});first.on("error",()=>{});
  await first.connect();const second=await connect();
  const sameRequest=request("actual_concurrent_same_run");
  let firstError:unknown,secondError:unknown,secondDone=false;
  const firstResult=apply(first,context,sameRequest).catch((error)=>{firstError=error;return undefined;});
  let secondResult:Promise<Receipt|undefined>|undefined;
  try{
    await boundedEvidence("first actual COMMIT held",async()=>proxy.evidence().commitHeld?true:undefined);
    const firstPid=proxy.evidence().backendPid;
    const secondPid=(await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    secondResult=apply(second,context,sameRequest).then((receipt)=>{secondDone=true;return receipt;},(error)=>{secondDone=true;secondError=error;return undefined;});
    const blockers=await boundedEvidence("actual second apply common lock blocked by first",async()=>{
      const result=await getPool().query("SELECT pg_blocking_pids($1) AS blockers",[secondPid]);
      return result.rows[0].blockers.includes(firstPid)?result.rows[0].blockers:undefined;
    });
    assert.equal(secondDone,false);
    assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release' AND target=$1",[sameRequest.runId])).rowCount,0);
    proxy.release();const [a,b]=await Promise.all([firstResult,secondResult]);
    assert.equal(firstError,undefined);assert.equal(secondError,undefined);assert.ok(a);assert.ok(b);assert.deepEqual(a,b);
    assert.deepEqual(await withClient(readSnapshot),a.after,"same-id follower has no second model or epoch writes");
    assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release' AND target=$1",[sameRequest.runId])).rowCount,1);
    console.log("OPERATOR_CONCURRENT_IDEMPOTENCY_EVIDENCE "+JSON.stringify({firstPid,secondPid,blockers,receipts:1,oneEpochTransition:true}));
  }finally{
    await proxy.close();await firstResult;if(secondResult)await secondResult;
    await first.end().catch(()=>{});await second.end().catch(()=>{});
  }
});
}

function scenario25() {
const register = (kind: "manifest" | "prepare") => {
test("actual apply refuses "+kind+" hash drift before model DML",async()=>{
  await resetFixture();
  const altered={...context};
  if(kind==="manifest"){
    altered.manifest=structuredClone(context.manifest);
    altered.manifest.standard_grok_target.pricing.input_per_mtok=Number(altered.manifest.standard_grok_target.pricing.input_per_mtok)+1;
    assert.notEqual(digest(altered.manifest),observation.manifestSha256);
  }else{
    altered.prepareSqlSha256=digest({differentPrepare:true});
    assert.notEqual(altered.prepareSqlSha256,observation.prepareSqlSha256);
  }
  const before=await withClient(readSnapshot);
  await assert.rejects(withClient((client)=>apply(client,altered,request("actual_hash_"+kind))),kind==="manifest"?/MANIFEST_DRIFT/:/PREPARATION_SQL_DRIFT/);
  assert.deepEqual(await withClient(readSnapshot),before);
  assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release'")).rowCount,0);
});
};
register("manifest");
}

function scenario26() {
const register = (kind: "manifest" | "prepare") => {
test("actual apply refuses "+kind+" hash drift before model DML",async()=>{
  await resetFixture();
  const altered={...context};
  if(kind==="manifest"){
    altered.manifest=structuredClone(context.manifest);
    altered.manifest.standard_grok_target.pricing.input_per_mtok=Number(altered.manifest.standard_grok_target.pricing.input_per_mtok)+1;
    assert.notEqual(digest(altered.manifest),observation.manifestSha256);
  }else{
    altered.prepareSqlSha256=digest({differentPrepare:true});
    assert.notEqual(altered.prepareSqlSha256,observation.prepareSqlSha256);
  }
  const before=await withClient(readSnapshot);
  await assert.rejects(withClient((client)=>apply(client,altered,request("actual_hash_"+kind))),kind==="manifest"?/MANIFEST_DRIFT/:/PREPARATION_SQL_DRIFT/);
  assert.deepEqual(await withClient(readSnapshot),before);
  assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release'")).rowCount,0);
});
};
register("prepare");
}

function scenario27() {
test("same committed run id with different valid readiness payload refuses precise conflict and preserves its unique receipt",async()=>{
  await resetFixture();
  const original=request("actual_payload_identity_conflict");
  const receipt=await withClient((client)=>apply(client,context,original));
  const changed={...original,readiness:{...original.readiness,evidenceSha256:[digest({differentValidEvidence:true})]}};
  assert.notDeepEqual(changed.readiness.evidenceSha256,original.readiness.evidenceSha256);
  await assert.rejects(withClient((client)=>apply(client,context,changed)),/RUN_ID_PAYLOAD_CONFLICT/);
  assert.deepEqual(await withClient(readSnapshot),receipt.after);
  const rows=await getPool().query("SELECT after FROM admin_audit WHERE action='ocv5-308.model-release' AND target=$1",[receipt.runId]);
  assert.equal(rows.rowCount,1);assert.deepEqual(rows.rows[0].after,receipt);
});
}

function scenario28() {
test("actual pre-COMMIT premise timeout closes its proxy before awaiting apply and leaves no PG backend or OS holder",async()=>{
  await resetFixture();
  const before=await withClient(readSnapshot),holderPid=holder.pid!;
  const proxy=await wireCommitProxy("hold-begin");
  const client=new Client({connectionString:proxy.url,connectionTimeoutMillis:3000});client.on("error",()=>{});
  await client.connect();
  let failure:unknown,done=false;
  const applied=apply(client,context,request("actual_cleanup_before_commit")).then(()=>{done=true;},(error)=>{done=true;failure=error;});
  try{
    await boundedEvidence("real BEGIN frame stopped before forwarding",async()=>proxy.evidence().beginHeld?true:undefined);
    const pid=proxy.evidence().backendPid;
    assert.ok(pid>1);assert.equal(proxy.evidence().commitHeld,false);assert.equal(done,false);
    const started=Date.now();
    await assert.rejects(boundedEvidence("forced COMMIT not yet present",async()=>proxy.evidence().commitHeld?true:undefined),/bounded evidence timeout: forced COMMIT not yet present/);
    assert.ok(Date.now()-started>=5000);
    assert.equal(proxy.evidence().commitHeld,false);assert.equal(done,false);
    await proxy.close();
    await boundedEvidence("actual apply ends after proxy cleanup",async()=>done?true:undefined);
    await applied;assert.ok(failure instanceof Error);assert.equal(failure instanceof CommitUnknown,false);
    await boundedEvidence("actual former backend is gone",async()=>{
      const result=await getPool().query("SELECT 1 FROM pg_stat_activity WHERE pid=$1",[pid]);return result.rowCount===0?true:undefined;
    });
    await stopHolder();await assert.rejects(readFile("/proc/"+holderPid+"/stat"),{code:"ENOENT"});
    assert.deepEqual(await withClient(readSnapshot),before);
    assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release'")).rowCount,0);
    console.log("OPERATOR_PRECOMMIT_CLEANUP_EVIDENCE "+JSON.stringify({...proxy.evidence(),budget:5000,backendGone:true,holderGone:true,snapshotAndEpochUnchanged:true}));
  }finally{
    await proxy.close();await applied;
    await stopHolder();await client.end().catch(()=>{});
  }
});
}

function scenario29() {
const register = (kind: "binding" | "catalog") => {
test("compensation preserves subsequent legitimate "+kind+" admin drift without overwriting or extra receipt",async()=>{
  await resetFixture();
  const activated=await withClient((client)=>apply(client,context,request("comp_drift_activation_"+kind)));
  if(kind==="binding"){
    const binding=activated.after.tables.account_group_models.find((row)=>row.model_id==="grok-build")!;
    assert.ok(binding);
    assert.equal((await getPool().query("DELETE FROM account_group_models WHERE group_id=$1 AND model_id=$2 RETURNING model_id",[binding.group_id,binding.model_id])).rowCount,1);
  }else{
    const old=activated.after.tables.model_catalog.find((row)=>row.model_id==="grok-build"&&row.state==="active")!;
    const switched=await getPool().query("SELECT fn_model_switch_version($1,$2,$3,$4,$5,$6::jsonb,$7,1,$8) AS id",
      [old.model_id,old.engine,old.provider_id,old.upstream_model_id,Number(old.context_window)+1,
        JSON.stringify(old.capability_profile),old.capability_schema_version,expectedVersion(old.lock_version)]);
    assert.notEqual(switched.rows[0].id,old.entry_id);
  }
  const changed=await withClient(readSnapshot);
  assert.notEqual(digest(changed),activated.afterSha256,"the real administrator operation must change the stored poststate");
  await assert.rejects(withClient((client)=>compensate(client,context,request("comp_actual_drift_"+kind),activated.runId)),/COMPENSATION_POSTSTATE_CAS_CONFLICT/);
  assert.deepEqual(await withClient(readSnapshot),changed);
  const receipts=await getPool().query("SELECT after FROM admin_audit WHERE action='ocv5-308.model-release'");
  assert.equal(receipts.rowCount,1);assert.deepEqual(receipts.rows[0].after,activated);
});
};
register("binding");
}

function scenario30() {
const register = (kind: "binding" | "catalog") => {
test("compensation preserves subsequent legitimate "+kind+" admin drift without overwriting or extra receipt",async()=>{
  await resetFixture();
  const activated=await withClient((client)=>apply(client,context,request("comp_drift_activation_"+kind)));
  if(kind==="binding"){
    const binding=activated.after.tables.account_group_models.find((row)=>row.model_id==="grok-build")!;
    assert.ok(binding);
    assert.equal((await getPool().query("DELETE FROM account_group_models WHERE group_id=$1 AND model_id=$2 RETURNING model_id",[binding.group_id,binding.model_id])).rowCount,1);
  }else{
    const old=activated.after.tables.model_catalog.find((row)=>row.model_id==="grok-build"&&row.state==="active")!;
    const switched=await getPool().query("SELECT fn_model_switch_version($1,$2,$3,$4,$5,$6::jsonb,$7,1,$8) AS id",
      [old.model_id,old.engine,old.provider_id,old.upstream_model_id,Number(old.context_window)+1,
        JSON.stringify(old.capability_profile),old.capability_schema_version,expectedVersion(old.lock_version)]);
    assert.notEqual(switched.rows[0].id,old.entry_id);
  }
  const changed=await withClient(readSnapshot);
  assert.notEqual(digest(changed),activated.afterSha256,"the real administrator operation must change the stored poststate");
  await assert.rejects(withClient((client)=>compensate(client,context,request("comp_actual_drift_"+kind),activated.runId)),/COMPENSATION_POSTSTATE_CAS_CONFLICT/);
  assert.deepEqual(await withClient(readSnapshot),changed);
  const receipts=await getPool().query("SELECT after FROM admin_audit WHERE action='ocv5-308.model-release'");
  assert.equal(receipts.rowCount,1);assert.deepEqual(receipts.rows[0].after,activated);
});
};
register("catalog");
}

function scenario31() {
test("actual fixed-path CLI refuses proof directory, foreign owner, symlink and stale measured kernel start with zero effects",async()=>{
  const cli=await configureCliFixture();
  const before=await withClient(readSnapshot);
  const proof=context.leasePaths!.commonNonce+".db",backup=proof+".fixture-backup";
  const original=await readFile(proof);
  const parsed=JSON.parse(original.toString());
  const kernel=await readFile("/proc/"+holder.pid+"/stat","utf8");
  const measured=kernel.slice(kernel.lastIndexOf(") ")+2).split(/\s+/)[19];
  assert.equal(parsed.holderPid,holder.pid);assert.equal(parsed.holderStart,measured);
  for(const kind of ["directory","owner","symlink","old-start"]){
    let moved=false;
    try{
      if(kind==="directory"||kind==="symlink"){
        await rename(proof,backup);moved=true;
        if(kind==="directory")await mkdir(proof,{mode:0o600});else await symlink(backup,proof);
      }else if(kind==="owner")await chown(proof,65534,65534);
      else await writeFile(proof,JSON.stringify({...parsed,holderStart:(BigInt(measured)+1n).toString()}));
      const refused=await privateCli(["apply","--observation",cli.output,"--readiness",cli.readiness,
        "--run-id","cli_actual_proof_"+kind,"--out",join(root,"proof-refused-"+kind+".json")]);
      assert.equal(refused.code,1,refused.stderr);assert.match(refused.stderr,/MODEL_RELEASE_OPERATOR_REFUSED/);
      assert.deepEqual(await withClient(readSnapshot),before);
      assert.equal((await getPool().query("SELECT 1 FROM admin_audit WHERE action='ocv5-308.model-release'")).rowCount,0);
    }finally{
      if(moved){await rm(proof,{recursive:kind==="directory"});await rename(backup,proof);}
      await chown(proof,0,0);await chmod(proof,0o600);await writeFile(proof,original);
      assert.deepEqual(await readFile(proof),original);
      const restored=await stat(proof);assert.equal(restored.isFile(),true);assert.equal(restored.uid,0);assert.equal(restored.mode&0o777,0o600);
    }
  }
});
}

switch (group) {
case "A": scenario01(); scenario02(); scenario03(); scenario04(); scenario05(); scenario06(); scenario30(); scenario31(); break;
case "B": scenario13(); scenario15(); scenario18(); scenario25(); scenario28(); break;
case "C": scenario07(); scenario10(); scenario16(); scenario21(); scenario24(); scenario29(); break;
case "D": scenario09(); scenario11(); scenario17(); scenario20(); scenario22(); scenario27(); break;
case "E": scenario08(); scenario12(); scenario14(); scenario19(); scenario23(); scenario26(); break;
}
});
}
export function registerOperatorGroupA() { registerFixedGroup("A"); }
export function registerOperatorGroupB() { registerFixedGroup("B"); }
export function registerOperatorGroupC() { registerFixedGroup("C"); }
export function registerOperatorGroupD() { registerFixedGroup("D"); }
export function registerOperatorGroupE() { registerFixedGroup("E"); }
