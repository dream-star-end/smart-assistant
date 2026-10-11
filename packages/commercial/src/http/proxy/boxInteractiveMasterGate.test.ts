// OCV5-380: the interactive Box route's master endpoints are off unless OC_BOX_INTERACTIVE_MASTER=1, and
// the Box exec endpoint never goes to a wildcard credential policy. Commercial runs with
// OC_V5_CURSOR_CREDENTIAL_UIDS=all and without the switch: before this gate a selfhost merge would have
// handed every commercial user container the shared Box's exec URL and token.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { boxExecTargetEntitlement } from "../../cursor/access.js";
import {
  BOX_EXEC_TARGET_PATH, BOX_LOGIN_PATH, BOX_LOGIN_SIGNALS_PATH,
  boxInteractiveMasterEnabled, boxInteractiveMasterRoute, isBoxInteractiveMasterPath, makeBoxLoginHandler,
} from "./boxLoginHandler.js";

const PATHS = [BOX_LOGIN_PATH, BOX_LOGIN_SIGNALS_PATH, BOX_EXEC_TARGET_PATH];
const container = { resolve: async () => ({ uid: 3n, containerId: 7n }) } as never;
const target = { kind: "target" as const, accountId: 25n,
  execUrl: "https://box.example.cursorvm.com/agent.v1.ControlService/Exec", execToken: "T0K", networkToken: "N3T" };

async function call(handler: ReturnType<typeof makeBoxLoginHandler>, path: string, body: unknown):
  Promise<{ status: number; text: string }> {
  const server = createServer((req, res) => {
    void handler(req, res, { hostUuid: "gate-test", boundIp: "127.0.0.1" })
      .catch(() => { res.statusCode = 500; res.end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

/** The egress assembly: the real handler behind the gate, an exec lookup that uses the real entitlement. */
function egressRoute(env: NodeJS.ProcessEnv) {
  let builds = 0;
  const lookups: bigint[] = [];
  const route = boxInteractiveMasterRoute(env, () => {
    builds++;
    return makeBoxLoginHandler({ identity: container,
      logins: { choose: async () => ({ kind: "login", profile: "default", reason: "affinity", alternatives: 0 }),
        observe: () => true } as never,
      execTargets: async (uid) => {
        const entitlement = boxExecTargetEntitlement(uid, env);
        if (entitlement !== "entitled") return { kind: entitlement };
        lookups.push(uid);
        return target;
      } });
  });
  return { route, builds: () => builds, lookups };
}

test("OCV5-380 interactive Box master endpoints are off unless OC_BOX_INTERACTIVE_MASTER is exactly 1", async () => {
  for (const value of [undefined, "", "0", "true", "on", "yes", " 1", "1 "]) {
    const env: NodeJS.ProcessEnv = { OC_V5_CURSOR_CREDENTIAL_UIDS: "all", OC_V5_CURSOR_OWNER_UID: "4",
      ...(value === undefined ? {} : { OC_BOX_INTERACTIVE_MASTER: value }) };
    assert.equal(boxInteractiveMasterEnabled(env), false, JSON.stringify(value));
    const egress = egressRoute(env);
    for (const path of PATHS) {
      const body = path === BOX_EXEC_TARGET_PATH ? {} : { account_id: "25" };
      const out = await call(egress.route, path, body);
      assert.equal(out.status, 404, `${path} with ${JSON.stringify(value)}`);
      assert.ok(!out.text.includes("T0K") && !out.text.includes("cursorvm"), "nothing of the Box leaks");
    }
    assert.equal(egress.builds(), 0, "no login service or exec lookup is built while off");
    assert.deepEqual(egress.lookups, []);
  }
});

test("OCV5-380 the egress routes exactly the three interactive paths through the gate", () => {
  assert.deepEqual(PATHS.map(isBoxInteractiveMasterPath), [true, true, true]);
  assert.equal(isBoxInteractiveMasterPath("/internal/box/stop"), false);
  assert.equal(isBoxInteractiveMasterPath("/internal/box/exec-target/"), false);
  const source = readFileSync(new URL("../../egress/main.ts", import.meta.url), "utf8");
  assert.match(source, /const boxLoginHandler = boxInteractiveMasterRoute\(process\.env, \(\) => makeBoxLoginHandler\(/);
  assert.match(source, /if \(isBoxInteractiveMasterPath\(path\)\) \{\n\s+Promise\.resolve\(boxLoginHandler\(req, res,/);
  assert.equal(source.match(/makeBoxLoginHandler\(/g)?.length, 1, "the handler is built in one place, behind the gate");
  assert.doesNotMatch(source, /isCursorCredentialEntitled/, "exec-target uses the wildcard-refusing entitlement");
});

test("OCV5-380 with the switch on, exec-target refuses a wildcard credential policy and serves listed uids", async () => {
  for (const uids of ["all", "*", " all "]) {
    const egress = egressRoute({ OC_BOX_INTERACTIVE_MASTER: "1", OC_V5_CURSOR_CREDENTIAL_UIDS: uids });
    const out = await call(egress.route, BOX_EXEC_TARGET_PATH, {});
    assert.deepEqual([out.status, JSON.parse(out.text)], [403, { error: "BOX_EXEC_WILDCARD_REFUSED" }], uids);
    assert.deepEqual(egress.lookups, [], "the Box is never resolved for a wildcard policy");
  }
  const owner = egressRoute({ OC_BOX_INTERACTIVE_MASTER: "1", OC_V5_CURSOR_OWNER_UID: "*" });
  assert.equal((await call(owner.route, BOX_EXEC_TARGET_PATH, {})).status, 403, "a wildcard owner uid is refused too");
  const other = egressRoute({ OC_BOX_INTERACTIVE_MASTER: "1", OC_V5_CURSOR_CREDENTIAL_UIDS: "9" });
  assert.deepEqual(JSON.parse((await call(other.route, BOX_EXEC_TARGET_PATH, {})).text), { error: "BOX_EXEC_NOT_ENTITLED" });
  const selfhost = egressRoute({ OC_BOX_INTERACTIVE_MASTER: "1", OC_V5_CURSOR_CREDENTIAL_UIDS: "3", OC_V5_CURSOR_OWNER_UID: "3" });
  const ok = await call(selfhost.route, BOX_EXEC_TARGET_PATH, {});
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.text).exec_token, "T0K");
  assert.deepEqual(selfhost.lookups, [3n]);
  assert.equal((await call(selfhost.route, BOX_LOGIN_PATH, { account_id: "25" })).status, 200, "login stays served on selfhost");
});

test("OCV5-380 boxExecTargetEntitlement: wildcard refused, explicit list and owner fallback as the mount", () => {
  assert.equal(boxExecTargetEntitlement(3, { OC_V5_CURSOR_CREDENTIAL_UIDS: "all" }), "wildcard_refused");
  assert.equal(boxExecTargetEntitlement(3, { OC_V5_CURSOR_CREDENTIAL_UIDS: "*", OC_V5_CURSOR_OWNER_UID: "3" }), "wildcard_refused");
  assert.equal(boxExecTargetEntitlement(3, { OC_V5_CURSOR_CREDENTIAL_UIDS: "3,4" }), "entitled");
  assert.equal(boxExecTargetEntitlement(9, { OC_V5_CURSOR_CREDENTIAL_UIDS: "3,4", OC_V5_CURSOR_OWNER_UID: "9" }), "not_entitled");
  assert.equal(boxExecTargetEntitlement(9, { OC_V5_CURSOR_CREDENTIAL_UIDS: " ", OC_V5_CURSOR_OWNER_UID: "9" }), "entitled");
  assert.equal(boxExecTargetEntitlement(3, {}), "not_entitled");
  assert.equal(boxExecTargetEntitlement(3, { OC_V5_CURSOR_CREDENTIAL_UIDS: "3,evil" }), "not_entitled");
});
