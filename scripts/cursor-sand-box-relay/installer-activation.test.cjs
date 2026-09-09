"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const http = require("node:http");
const vm = require("node:vm");
const ts = require("typescript");
const hash = b => createHash("sha256").update(b).digest("hex");
const installer = join(__dirname, "installer.py"), moduleFile = join(__dirname, "relay.cjs");
const nativeSourceFile = join(__dirname, "fixtures/supervisor-source.txt");
const nativeSource = fs.readFileSync(nativeSourceFile, "utf8");
assert.equal(hash(nativeSource), "a387f70a2134addc6a1f576b9a50589a2680d047daed15ecf7d102afc8f741c8");
// Parse source as DATA; never import/run the supervisor application. Only the
// exact command/health consumer and pure helpers run against our own child/HTTP.
const ast = ts.createSourceFile("source.js", nativeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(), methods = new Map();
for (const n of ast.statements) {
  if (ts.isFunctionDeclaration(n)) functions.set(n.name.text, n.getText(ast).replace(/^export /, ""));
  if (ts.isClassDeclaration(n) && n.name.text === "Supervisor") for (const m of n.members) if (m.name) methods.set(m.name.getText(ast), m.getText(ast));
}
function consumer(commandPath, child, healthPort) {
  const fnNames = ["parseCommand", "commandRequiresIdle", "decideUpgradeReadiness", "shouldForceHostUpgrade", "decideUpgradeAction", "shouldProcessCommand", "safeRead", "fetchHealth"];
  const methodNames = ["processCommand", "commandState", "removeCommand", "handleCommand", "stopHost", "probeBusyState"];
  for (const name of fnNames) assert.ok(functions.has(name), name);
  for (const name of methodNames) assert.ok(methods.has(name), name);
  const Constructor = vm.runInNewContext(`const COMMAND_KINDS=["ping","restart","upgrade"],UPGRADE_MODES=["bundle","image","restart"],MAX_DEFER_MS=21600000,HEALTH_TIMEOUT_MS=1500;\n${fnNames.map(n=>functions.get(n)).join("\n")}\nclass NativeConsumer {${methodNames.map(n=>methods.get(n)).join("\n")}}; NativeConsumer`,
    { http, existsSync: fs.existsSync, readFileSync: fs.readFileSync, rmSync: fs.rmSync, log() {} });
  const c = new Constructor(), acks = new Set();
  Object.assign(c, { commandPath, child, adoptedHost: null, appliedCommandIds: new Set(), stoppedHostPids: new Set(), expectedHostExits: new Set(),
    pendingUpgradeDeferredSinceMs: Date.now()-30*3600_000, hostRunning: () => child.exitCode === null && child.signalCode === null,
    readGatewayEndpoint: () => ({port: healthPort}), isAcked: id => acks.has(id), ack: id => acks.add(id),
    requestHostPause: () => { throw Error("MUST_NOT_PAUSE_OR_FORCE"); } });
  return c;
}
async function bounded(p, label) {
  let timer; try { return await Promise.race([p, new Promise((_, reject) => { timer=setTimeout(()=>reject(Error(label)),5000); })]); }
  finally { clearTimeout(timer); }
}
async function hostChild(dir) {
  const code = `const http=require('node:http');
globalThis.testClient=async req=>{for await(const b of req.body){};return {status:200,header:new Headers({'content-type':'application/connect+proto'}),body:(async function*(){yield Buffer.from('FIRST');await new Promise(r=>process.once('message',r));yield Buffer.from('LAST')})()}};
const app=require('./host-main.cjs');app.initialize({host:{log(){},environment:{auth:{}}},onStop(){}});
const s=http.createServer((q,r)=>app.handleRequest({authToken:'TEST_GATE'},q,r));s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port})));`;
  const p = spawn(process.execPath, ["-e",code], {cwd:dir,stdio:["ignore","pipe","pipe","ipc"]});
  let out="", err="";p.stderr.on("data",b=>err+=b);
  try {
    const data=await bounded(new Promise((resolve,reject)=>{p.stdout.on("data",b=>{out+=b;if(out.includes("\n"))resolve(out.split("\n")[0]);});p.once("exit",()=>reject(Error(err||"child exited")));}),"child ready");
    return { process:p, port:JSON.parse(data).port };
  } catch(e) {p.kill();throw e;}
}
async function closeChild(child) { if(child && child.process.exitCode===null && child.process.signalCode===null){const done=once(child.process,"exit");child.process.kill();await bounded(done,"cleanup child");} }
function apply(dir,pid,nonce="a",supervisor=nativeSourceFile) {
  const payload={expectedPid:pid,agentId:"maintenance-own",nonce:"oc-sand-"+nonce.repeat(32),moduleSha256:hash(fs.readFileSync(moduleFile)),moduleBase64:fs.readFileSync(moduleFile).toString("base64")};
  return spawnSync("python3",["-c",`import importlib.util,json,pathlib,sys
s=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
try: print(json.dumps(m.apply_payload(json.load(sys.stdin),pathlib.Path(sys.argv[2])/'host-main.cjs',pathlib.Path(sys.argv[3]),pathlib.Path(sys.argv[2])/'mailbox'/'command.json')))
except Exception as e: print(type(e).__name__+':'+str(e));sys.exit(1)`,installer,dir,supervisor],{input:JSON.stringify(payload),encoding:"utf8",timeout:10000});
}
function setup() {
  const dir=fs.mkdtempSync(join(tmpdir(),"sand-activation-"));fs.mkdirSync(join(dir,"mailbox"));
  fs.copyFileSync(join(__dirname,"fixtures/host-original.cjs"),join(dir,"host-main.cjs"));
  fs.utimesSync(join(dir,"host-main.cjs"),new Date(0),new Date(0));return dir;
}
test("native consumer defers for own Bot, late other Bot and unknown health, then reloads exactly once and serves capability",{timeout:20000},async()=>{
  const dir=setup();let child,next,health;let busy=true,unknown=false,healthCalls=0;
  try {
    child=await hostChild(dir);
    health=http.createServer((q,r)=>{healthCalls++;r.end(unknown?"not-json":JSON.stringify({isBusy:busy}));});
    await new Promise(r=>health.listen(0,"127.0.0.1",r));
    const result=apply(dir,child.process.pid);assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout).phase,"restart-queued");
    const command=join(dir,"mailbox/command.json");assert.deepEqual(JSON.parse(fs.readFileSync(command)),{id:"oc-sand-"+"a".repeat(32),kind:"restart"});
    const c=consumer(command,child.process,health.address().port);
    // Initially the maintenance Bot itself is running; then another Bot starts
    // after the parent's old idle observation and outlives maintenance.
    await c.processCommand();assert.equal(c.stoppedHostPids.size,0);assert.ok(fs.existsSync(command));
    await c.processCommand();assert.equal(c.stoppedHostPids.size,0);assert.ok(fs.existsSync(command));
    unknown=true;await c.processCommand();assert.equal(c.stoppedHostPids.size,0);assert.ok(fs.existsSync(command));
    unknown=false;busy=false;const ended=once(child.process,"exit");await c.processCommand();await bounded(ended,"native restart");
    assert.equal(c.stoppedHostPids.size,1);assert.equal(healthCalls,4);assert.equal(fs.existsSync(command),false);
    await c.processCommand();assert.equal(c.stoppedHostPids.size,1,"no second restart after command consumed");
    next=await hostChild(dir);assert.notEqual(next.process.pid,child.process.pid);
    const r=await fetch(`http://127.0.0.1:${next.port}/sand-stream-relay/aiserver.v1.InferenceService/Stream`,{headers:{authorization:"Bearer TEST_GATE","x-oc-sand-box-probe":"1","x-oc-sand-box-probe-nonce":"a".repeat(32)}});
    assert.equal(r.status,200);assert.equal((await r.json()).moduleSha256,hash(fs.readFileSync(moduleFile)));
  }finally{await closeChild(child);await closeChild(next);if(health){health.closeAllConnections();await new Promise(r=>health.close(r));}fs.rmSync(dir,{recursive:true,force:true});}
});
test("old loaded relay stream survives staged replacement with zero restart commands",{timeout:20000},async()=>{
  const dir=setup();let child,reader;
  try {
    // Install the owned hook offline, then load the actual hash-pinned 198 relay.
    const prep=spawnSync("python3",["-c",`import importlib.util,pathlib,sys
s=importlib.util.spec_from_file_location('i',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=pathlib.Path(sys.argv[2]);p.write_text(m.patch_source(p.read_text()))`,installer,join(dir,"host-main.cjs")]);assert.equal(prep.status,0);
    let source=fs.readFileSync(join(dir,"host-main.cjs"),"utf8").replace('return () => { throw Error("unexpected upstream"); };','return globalThis.testClient;').replace('getGrokBotToken(){throw Error("must not request a token")}','getGrokBotToken(){return "SYNTHETIC_BOX_TOKEN"}');
    fs.writeFileSync(join(dir,"host-main.cjs"),source);fs.utimesSync(join(dir,"host-main.cjs"),new Date(0),new Date(0));
    const legacy=fs.readFileSync(join(__dirname,"fixtures/legacy-relay.cjs"));assert.equal(hash(legacy),"97200144b9a591503687a7c06b8fc0597454590a496eeb0de31872a2a514203a");fs.writeFileSync(join(dir,"ocv5-197-relay.cjs"),legacy);
    child=await hostChild(dir);
    const r=await fetch(`http://127.0.0.1:${child.port}/sand-stream-relay/aiserver.v1.InferenceService/Stream`,{method:"POST",body:Buffer.from([0,0,0,0,0]),headers:{authorization:"Bearer TEST_GATE","content-type":"application/connect+proto"},signal:AbortSignal.timeout(15000)});
    assert.equal(r.status,200);reader=r.body.getReader();const first=await reader.read();assert.equal(Buffer.from(first.value).toString(),"FIRST");
    const result=apply(dir,child.process.pid,"b");assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout).phase,"awaiting-natural-restart");
    assert.equal(fs.existsSync(join(dir,"mailbox/command.json")),false);assert.equal(child.process.signalCode,null);assert.equal(child.process.exitCode,null);
    assert.equal(hash(fs.readFileSync(join(dir,"ocv5-197-relay.cjs"))),hash(fs.readFileSync(moduleFile)));
    child.process.send("finish");let rest="";for(;;){const b=await reader.read();if(b.done)break;rest+=Buffer.from(b.value).toString();}assert.equal(rest,"LAST");
  }finally{await reader?.cancel().catch(()=>{});await closeChild(child);fs.rmSync(dir,{recursive:true,force:true});}
});
test("unknown supervisor, newer source and occupied mailbox never force or overwrite",{timeout:20000},async()=>{
  for(const mode of ["unknown","newer","occupied"]){const dir=setup();let child;try{
    child=await hostChild(dir);let supervisor=nativeSourceFile;
    if(mode==="unknown"){supervisor=join(dir,"unknown.txt");fs.writeFileSync(supervisor,"unknown supervisor");}
    if(mode==="newer")fs.utimesSync(join(dir,"host-main.cjs"),new Date(),new Date());
    if(mode==="occupied")fs.writeFileSync(join(dir,"mailbox/command.json"),'OTHER-COMMAND');
    const result=apply(dir,child.process.pid,"c",supervisor);
    assert.equal(child.process.signalCode,null);assert.equal(child.process.exitCode,null);
    if(mode==="occupied"){assert.equal(result.status,1);assert.match(result.stdout,/SUPERVISOR_COMMAND_BUSY/);assert.equal(fs.readFileSync(join(dir,"mailbox/command.json"),"utf8"),'OTHER-COMMAND');}
    else{assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(JSON.parse(result.stdout).phase,"awaiting-natural-restart");assert.equal(fs.existsSync(join(dir,"mailbox/command.json")),false);}
  }finally{await closeChild(child);fs.rmSync(dir,{recursive:true,force:true});}}
});
test("durable restart intent prevents a duplicate command after consumer removed it",()=>{
  const dir=setup();try{
    const r=spawnSync("python3",["-c",`import importlib.util,pathlib,sys,json
s=importlib.util.spec_from_file_location('i',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=pathlib.Path(sys.argv[2]);box=p/'mailbox'/'command.json';args=(p/'host-main.cjs',box,'oc-sand-'+'d'*32,'own','a'*64,lambda:None)
first=m.queue_native_restart(*args);box.unlink();second=m.queue_native_restart(*args)
print(json.dumps({'first':first,'second':second,'exists':box.exists()}))`,installer,dir],{encoding:"utf8",timeout:10000});
    assert.equal(r.status,0,r.stdout+r.stderr);assert.deepEqual(JSON.parse(r.stdout),{first:"restart-queued",second:"restart-delivery-unknown",exists:false});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
