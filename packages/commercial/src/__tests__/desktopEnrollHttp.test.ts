import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { HttpError } from "../http/util.js";
import { handleDesktopEnrollStart } from "../http/desktopEnroll.js";
import type { CommercialHttpDeps, RequestContext } from "../http/handlers.js";
import { resetDesktopFlagCache, setDesktopSettingsLoader } from "../desktop/flags.js";
import { rootLogger } from "../logging/logger.js";

function req(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  stream.method = "POST";
  stream.url = "/api/desktop/enroll/start";
  stream.headers = { "content-type": "application/json" };
  return stream;
}

function dummyDeps(): CommercialHttpDeps {
  return {
    jwtSecret: "desktop-enroll-http-test-secret-32bytes-min",
    mailer: { send: async () => {} },
    redis: { async incr() { return 1; }, async expire() { return 1; } },
  } as CommercialHttpDeps;
}

function ctx(): RequestContext {
  return {
    requestId: "t",
    clientIp: "127.0.0.1",
    authBoundIp: "127.0.0.1",
    userAgent: "test",
    log: rootLogger.child({ subsys: "test" }),
  };
}

describe("desktop enroll HTTP gates", () => {
  test("flag off → 404", async () => {
    const prev = process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }));
    const res = { statusCode: 0, setHeader() {}, end() {} } as unknown as ServerResponse;
    await assert.rejects(
      () => handleDesktopEnrollStart(req({}), res, ctx(), dummyDeps()),
      (e: unknown) => e instanceof HttpError && e.status === 404,
    );
    if (prev === undefined) delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    else process.env.OC_DESKTOP_VIRTUAL_CONTAINER = prev;
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
  });

  test("kill switch → 503", async () => {
    const prev = process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    const prevK = process.env.OC_DESKTOP_KIND_KILLSWITCH;
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    process.env.OC_DESKTOP_KIND_KILLSWITCH = "1";
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [1] }));
    const res = { statusCode: 0, setHeader() {}, end() {} } as unknown as ServerResponse;
    await assert.rejects(
      () => handleDesktopEnrollStart(req({}), res, ctx(), dummyDeps()),
      (e: unknown) => e instanceof HttpError && e.status === 503 && e.code === "DESKTOP_KILLSWITCH",
    );
    if (prev === undefined) delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    else process.env.OC_DESKTOP_VIRTUAL_CONTAINER = prev;
    if (prevK === undefined) delete process.env.OC_DESKTOP_KIND_KILLSWITCH;
    else process.env.OC_DESKTOP_KIND_KILLSWITCH = prevK;
    setDesktopSettingsLoader(null);
    resetDesktopFlagCache();
  });
});
