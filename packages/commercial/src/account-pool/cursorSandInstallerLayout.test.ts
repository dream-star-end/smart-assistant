/** Sand relay installer against Cursor Box host layouts (INC-20261007-SAND-INSTALLER-HOST-F95DBFB).
 * Runs the real installer.py on the verbatim-gate f95dbfb fixture and serves the patched host. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const relayDir = fileURLToPath(new URL("../../../../scripts/cursor-sand-box-relay/", import.meta.url));
const installer = join(relayDir, "installer.py");
const modulePath = join(relayDir, "relay.cjs");
const hash = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

function apply(host: string): { status: number | null; stdout: string; stderr: string } {
  return spawnSync("python3", ["-c", `import importlib.util,json,pathlib,sys
s=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
try: print(json.dumps(m.install(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]).read_bytes(),sys.argv[4],'oc-sand-'+'a'*32)))
except Exception as e: print(type(e).__name__+':'+str(e));sys.exit(1)`, installer, host, modulePath, hash(readFileSync(modulePath))], { encoding: "utf8", timeout: 30_000 });
}

test("host f95dbfb layout: relay answers only the primary gateway token, never the WebAuthn proxy token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-installer-f95dbfb-")), host = join(dir, "host-main.cjs");
  let server: http.Server | undefined;
  try {
    writeFileSync(host, readFileSync(join(relayDir, "fixtures/host-f95dbfb.cjs")));
    const first = apply(host); assert.equal(first.status, 0, first.stdout + first.stderr);
    const patched = readFileSync(host, "utf8");
    assert.ok(patched.indexOf("return handleSandStreamRelay(deps, req, res);") < patched.indexOf("webAuthnProxyRefusal({"), "route sits before the proxy branch");
    const again = apply(host); assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(JSON.parse(again.stdout).changed, false);
    const app = createRequire(import.meta.url)(host);
    app.initialize({ host: { log() {}, environment: { auth: {} } }, onStop() {} });
    let deps: Record<string, unknown> = { authToken: "TEST_GATE", webAuthnProxyToken: "PROXY_GATE", isWebAuthnProxyCredentialLive: () => true };
    server = http.createServer((q, s) => app.handleRequest(deps, q, s));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = `${base}/sand-stream-relay/aiserver.v1.InferenceService/Stream`;
    const headers: Record<string, string> = { "content-type": "application/connect+proto", "x-oc-sand-box-probe": "1", "x-oc-sand-box-probe-nonce": "b".repeat(32) };
    for (const auth of [undefined, "Bearer PROXY_GATE", "Bearer wrong"]) {
      for (const method of ["GET", "POST"]) {
        const r = await fetch(url, { method, ...(method === "POST" ? { body: "" } : {}), headers: auth ? { ...headers, authorization: auth } : headers });
        assert.equal(r.status, 401, `${method} ${auth}`); await r.text();
      }
    }
    const ok = await fetch(url, { method: "GET", headers: { ...headers, authorization: "Bearer TEST_GATE" } });
    assert.equal(ok.status, 200); assert.equal((await ok.json() as { moduleSha256: string }).moduleSha256, hash(readFileSync(modulePath)));
    // The host's own proxy branch is unchanged for its other paths.
    const proxied = await fetch(`${base}/webauthn-requests`, { headers: { authorization: "Bearer PROXY_GATE" } });
    assert.equal(proxied.status, 404); await proxied.text();
    // No gateway token configured: the relay fails closed.
    deps = {};
    const open = await fetch(url, { method: "GET", headers });
    assert.equal(open.status, 401); await open.text();
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host f95dbfb layout: the installer's own route gate holds even when the relay module has no token check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-installer-f95dbfb-gate-")), host = join(dir, "host-main.cjs");
  let server: http.Server | undefined;
  try {
    writeFileSync(host, readFileSync(join(relayDir, "fixtures/host-f95dbfb.cjs")));
    const first = apply(host); assert.equal(first.status, 0, first.stdout + first.stderr);
    // Replace the installed relay with one that answers anything: only ROUTE_V3 can refuse now.
    writeFileSync(join(dir, "ocv5-197-relay.cjs"), 'exports.createRelay = () => (deps, req, res) => { res.writeHead(200); res.end("UNGATED_RELAY"); };\n');
    const app = createRequire(import.meta.url)(host);
    app.initialize({ host: { log() {}, environment: { auth: {} } }, onStop() {} });
    let deps: Record<string, unknown> = { authToken: "TEST_GATE", webAuthnProxyToken: "PROXY_GATE", isWebAuthnProxyCredentialLive: () => true };
    server = http.createServer((q, s) => app.handleRequest(deps, q, s));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/sand-stream-relay/aiserver.v1.InferenceService/Stream`;
    for (const auth of [undefined, "Bearer PROXY_GATE", "Bearer wrong"]) {
      for (const method of ["GET", "POST"]) {
        const r = await fetch(url, { method, ...(method === "POST" ? { body: "" } : {}), headers: auth ? { authorization: auth } : {} });
        assert.equal(r.status, 401, `${method} ${auth}`); await r.text();
      }
    }
    const ok = await fetch(url, { headers: { authorization: "Bearer TEST_GATE" } });
    assert.equal(ok.status, 200); assert.equal(await ok.text(), "UNGATED_RELAY");
    deps = {};
    const open = await fetch(url, {});
    assert.equal(open.status, 401); await open.text();
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-run refuses an f95dbfb host whose relay route sits after the proxy gate", () => {
  const r = spawnSync("python3", ["-c", `import importlib.util,sys
s=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
src=open(sys.argv[2]).read();patched=m.patch_source(src)
moved=patched.replace(m.ROUTE_V3,'',1).replace('    if (isPrepareUpgrade) {',m.ROUTE_V3+'    if (isPrepareUpgrade) {',1)
assert m.patch_source(patched)==patched
try: m.patch_source(moved); print('ACCEPTED')
except RuntimeError as e: print(e)`, installer, join(relayDir, "fixtures/host-f95dbfb.cjs")], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), "UNSUPPORTED_EXISTING_HOOK");
});

test("host path follows the expected PID's cwd among known Sand host directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "sand-host-dir-"));
  try {
    const r = spawnSync("python3", ["-c", `import importlib.util,os,pathlib,sys,json
s=importlib.util.spec_from_file_location('installer',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
here=pathlib.Path(os.getcwd())
found=str(m.resolve_host(os.getpid(),(pathlib.Path('/nonexistent-sand-host'),here)))
try: m.resolve_host(os.getpid(),(pathlib.Path('/nonexistent-sand-host'),)); other='accepted'
except RuntimeError as e: other=str(e)
print(json.dumps({'found':found,'other':other,'dirs':[str(d) for d in m.HOST_DIRS]}))`, installer], { cwd: dir, encoding: "utf8", timeout: 10_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.found, join(realpathSync(dir), "host-main.cjs"));
    assert.equal(out.other, "HOST_PID_MISMATCH");
    assert.deepEqual(out.dirs, ["/opt/sand/sand-host", "/home/box/sand-host"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
