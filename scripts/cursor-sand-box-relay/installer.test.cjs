"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const http = require("node:http");
const installer = join(__dirname, "installer.py"), modulePath = join(__dirname, "relay.cjs");
const hash = b => createHash("sha256").update(b).digest("hex");
function apply(host, module = modulePath, expected = hash(readFileSync(module))) {
  return spawnSync("python3", ["-c", `import importlib.util,json,pathlib,sys
s=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
try: print(json.dumps(m.install(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]).read_bytes(),sys.argv[4],'oc-sand-'+'a'*32)))
except Exception as e: print(type(e).__name__+':'+str(e));sys.exit(1)`, installer, host, module, expected], { encoding: "utf8", timeout: 10_000 });
}
test("deterministic install preserves auth, serves actual module probe and is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-installer-")), host = join(dir, "host-main.cjs");
  let server;
  try {
    const original = readFileSync(join(__dirname, "fixtures/host-original.cjs")); writeFileSync(host, original);
    const first = apply(host); assert.equal(first.status, 0, first.stdout + first.stderr);
    const patched = readFileSync(host); assert.notDeepEqual(patched, original);
    const again = apply(host); assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(JSON.parse(again.stdout).changed, false); assert.deepEqual(readFileSync(host), patched);
    const app = require(host); app.initialize({host:{log(){},environment:{auth:{}}},onStop(){}});
    server = http.createServer((q,s) => app.handleRequest({authToken:"TEST_GATE"},q,s));
    await new Promise(r=>server.listen(0,"127.0.0.1",r));
    const url = "http://127.0.0.1:"+server.address().port+"/sand-stream-relay/aiserver.v1.InferenceService/Stream";
    const headers={"content-type":"application/connect+proto","x-oc-sand-box-probe":"1","x-oc-sand-box-probe-nonce":"b".repeat(32)};
    const denied=await fetch(url,{method:"POST",body:"",headers});assert.equal(denied.status,401);await denied.text();
    const ok=await fetch(url,{method:"GET",headers:{...headers,authorization:"Bearer TEST_GATE"}});
    assert.equal(ok.status,200);assert.equal((await ok.json()).moduleSha256,hash(readFileSync(modulePath)));
  } finally { if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}rmSync(dir,{recursive:true,force:true}); }
});
test("unknown source, hash mismatch and syntax failure leave host and module unchanged", () => {
  const dir=mkdtempSync(join(tmpdir(),"sand-installer-reject-")),host=join(dir,"host-main.cjs"),target=join(dir,"ocv5-197-relay.cjs"),bad=join(dir,"bad.cjs");
  const original=readFileSync(join(__dirname,"fixtures/host-original.cjs"));
  try {
    writeFileSync(target,"OLD");writeFileSync(host,original);
    assert.equal(apply(host,modulePath,"0".repeat(64)).status,1);
    writeFileSync(bad,"function (");assert.equal(apply(host,bad).status,1);
    assert.deepEqual(readFileSync(host),original);assert.equal(readFileSync(target,"utf8"),"OLD");
    writeFileSync(host,original.toString().replace("const isCommand =","const changedCommand ="));const changed=readFileSync(host);
    assert.equal(apply(host).status,1);assert.deepEqual(readFileSync(host),changed);assert.equal(readFileSync(target,"utf8"),"OLD");
  }finally{rmSync(dir,{recursive:true,force:true});}
});
