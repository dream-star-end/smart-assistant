import assert from "node:assert/strict";
import https from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ensureDesktopOriginCert, issueDeviceCertificate } from "../desktop/deviceCa.js";
import { resetDesktopFlagCache, setDesktopSettingsLoader } from "../desktop/flags.js";
import {
  desktopTlsBindPort,
  desktopUpgradeAction,
  startDesktopTlsListener,
  type DesktopTlsHandlers,
} from "../http/desktopTlsListener.js";

function stubHandlers(hits: string[]): DesktopTlsHandlers {
  const hit = (name: string) => async (_req: IncomingMessage, res: ServerResponse) => {
    hits.push(name);
    res.statusCode = 204;
    res.end();
  };
  return {
    messages: hit("messages"),
    serverAuthored: hit("serverAuthored"),
    turnTape: hit("turnTape"),
    turnLease: hit("turnLease"),
    catalog: hit("catalog"),
  };
}

function httpsReq(opts: https.RequestOptions, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("desktop TLS split assembly", () => {
  test("upgrade policy: register only on master", () => {
    assert.equal(desktopUpgradeAction("master", "/ws/desktop-container-register"), "register");
    assert.equal(desktopUpgradeAction("egress", "/ws/desktop-container-register"), "not_found");
    assert.equal(desktopUpgradeAction("master", "/v1/messages"), "not_found");
  });

  test("split default ports do not collide", () => {
    assert.equal(desktopTlsBindPort("master").port, 18445);
    assert.equal(desktopTlsBindPort("egress").port, 18446);
  });

  test("flag off → neither role binds", async () => {
    const prev = process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }));
    const hits: string[] = [];
    const master = await startDesktopTlsListener({
      role: "master", bind: "127.0.0.1", port: 0, handlers: stubHandlers(hits),
    });
    const egress = await startDesktopTlsListener({
      role: "egress", bind: "127.0.0.1", port: 0, handlers: stubHandlers(hits),
    });
    assert.equal(master, null);
    assert.equal(egress, null);
    if (prev === undefined) delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    else process.env.OC_DESKTOP_VIRTUAL_CONTAINER = prev;
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
  });

  test("egress dispatches /v1/messages; register upgrade is 404; master register is not 404", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oc-dca-split-"));
    const prevCa = process.env.OPENCLAUDE_DEVICE_CA_DIR;
    const prevFlag = process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    process.env.OPENCLAUDE_DEVICE_CA_DIR = dir;
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }));
    const origin = await ensureDesktopOriginCert();
    const issued = await issueDeviceCertificate(randomUUID());
    const egressHits: string[] = [];
    const masterHits: string[] = [];
    const egress = await startDesktopTlsListener({
      role: "egress",
      allowRegister: false,
      bind: "127.0.0.1",
      port: 0,
      handlers: stubHandlers(egressHits),
    });
    const master = await startDesktopTlsListener({
      role: "master",
      allowRegister: true,
      bind: "127.0.0.1",
      port: 0,
      handlers: stubHandlers(masterHits),
    });
    assert.ok(egress && master);
    const tls = {
      hostname: "127.0.0.1",
      rejectUnauthorized: true,
      ca: origin.caCertPem,
      cert: issued.certPem,
      key: issued.keyPem,
      minVersion: "TLSv1.3" as const,
    };
    const msg = await httpsReq({
      ...tls,
      port: egress!.address.port,
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "application/json" },
    }, "{}");
    assert.equal(msg.status, 204);
    assert.deepEqual(egressHits, ["messages"]);

    const upEgress = await httpsReq({
      ...tls,
      port: egress!.address.port,
      method: "GET",
      path: "/ws/desktop-container-register",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("split-test-key-xxxx").toString("base64"),
      },
    });
    assert.equal(upEgress.status, 404);

    const upMaster = await httpsReq({
      ...tls,
      port: master!.address.port,
      method: "GET",
      path: "/ws/desktop-container-register",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.from("split-test-key-xxxx").toString("base64"),
      },
    });
    assert.notEqual(upMaster.status, 404);

    await egress!.close();
    await master!.close();
    if (prevCa === undefined) delete process.env.OPENCLAUDE_DEVICE_CA_DIR;
    else process.env.OPENCLAUDE_DEVICE_CA_DIR = prevCa;
    if (prevFlag === undefined) delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    else process.env.OC_DESKTOP_VIRTUAL_CONTAINER = prevFlag;
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
    await rm(dir, { recursive: true, force: true });
  });
});
