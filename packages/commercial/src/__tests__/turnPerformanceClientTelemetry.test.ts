/**
 * OCV5-40: server-emitted FIRST_THINKING_FRAME / FIRST_TEXT_FRAME telemetry
 * attaches bounded closed-allowlist browser_family & device_class derived from
 * the WebSocket upgrade User-Agent with zero PII leakage and full backward
 * compatibility when User-Agent is absent/unknown.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { describe, test } from "node:test";
import type { Pool } from "pg";
import { WebSocket, WebSocketServer } from "ws";

import { signAccess } from "../auth/jwt.js";
import {
  parseClientTelemetryFromUserAgent,
  recordTurnResponseMilestone,
  TurnResponseMilestoneTracker,
} from "../ws/turnPerformance.js";
import { BRIDGE_WS_PATH, createUserChatBridge, type UserChatBridgeDeps } from "../ws/userChatBridge.js";

const JWT_SECRET = "ocv5-40-turn-perf-telemetry-test-secret-0123456789";

const UA_SAFARI_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
const UA_SAFARI_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
const UA_SAFARI_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const UA_CHROME_DESKTOP_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const UA_CHROME_DESKTOP_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const UA_CHROME_DESKTOP_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const UA_CHROME_DESKTOP_CROS =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const UA_CHROME_ANDROID_MOBILE =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36";
const UA_CHROME_ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Safari/537.36";
const UA_CHROME_IOS_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1";
const UA_CHROME_IOS_TABLET =
  "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1";
const UA_EDGE_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0";
const UA_EDGE_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.0.0";
const UA_EDGE_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/128.0.0.0 Mobile/15E148 Safari/605.1.15";
const UA_FIREFOX_DESKTOP =
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0";
const UA_FIREFOX_ANDROID_MOBILE =
  "Mozilla/5.0 (Android 14; Mobile; rv:129.0) Gecko/129.0 Firefox/129.0";
const UA_FIREFOX_ANDROID_TABLET =
  "Mozilla/5.0 (Android 14; Tablet; rv:129.0) Gecko/129.0 Firefox/129.0";
const UA_FIREFOX_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/129.0 Mobile/15E148 Safari/605.1.15";

type FrictionInsert = {
  code: string;
  stage: string;
  browserFamily: unknown;
  deviceClass: unknown;
  params: readonly unknown[];
};

function makeRecordingPool(): { pool: Pool; frictionInserts: FrictionInsert[] } {
  const frictionInserts: FrictionInsert[] = [];
  const pool = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("INSERT INTO product_friction_events")) {
        frictionInserts.push({
          stage: String(params[3]),
          code: String(params[4]),
          browserFamily: params[11],
          deviceClass: params[12],
          params,
        });
      }
      if (/SELECT status FROM users WHERE id/.test(sql)) {
        return { rows: [{ status: "active" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, frictionInserts };
}

async function waitFor<T>(
  check: () => T | undefined,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = check();
    if (val !== undefined) return val;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("parseClientTelemetryFromUserAgent (OCV5-40)", () => {
  test("classifies Safari desktop/mobile/tablet accurately", () => {
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_SAFARI_MOBILE), {
      browserFamily: "safari",
      deviceClass: "mobile",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_SAFARI_IPAD), {
      browserFamily: "safari",
      deviceClass: "tablet",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_SAFARI_DESKTOP), {
      browserFamily: "safari",
      deviceClass: "desktop",
    });
  });

  test("classifies Chrome desktop, Android mobile/tablet, and Chrome iOS accurately", () => {
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_CHROME_DESKTOP_MAC), {
      browserFamily: "chrome",
      deviceClass: "desktop",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_CHROME_DESKTOP_WIN), {
      browserFamily: "chrome",
      deviceClass: "desktop",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_CHROME_DESKTOP_LINUX), {
      browserFamily: "chrome",
      deviceClass: "desktop",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_CHROME_DESKTOP_CROS), {
      browserFamily: "chrome",
      deviceClass: "desktop",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_CHROME_ANDROID_MOBILE), {
      browserFamily: "chrome",
      deviceClass: "mobile",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_CHROME_ANDROID_TABLET), {
      browserFamily: "chrome",
      deviceClass: "tablet",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_CHROME_IOS_MOBILE), {
      browserFamily: "chrome_ios",
      deviceClass: "mobile",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_CHROME_IOS_TABLET), {
      browserFamily: "chrome_ios",
      deviceClass: "tablet",
    });
  });

  test("classifies Edge and Firefox across desktop/mobile/tablet", () => {
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_EDGE_DESKTOP), {
      browserFamily: "edge",
      deviceClass: "desktop",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_EDGE_ANDROID), {
      browserFamily: "edge",
      deviceClass: "mobile",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_EDGE_IOS), {
      browserFamily: "edge",
      deviceClass: "mobile",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_FIREFOX_DESKTOP), {
      browserFamily: "firefox",
      deviceClass: "desktop",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_FIREFOX_ANDROID_MOBILE), {
      browserFamily: "firefox",
      deviceClass: "mobile",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_FIREFOX_ANDROID_TABLET), {
      browserFamily: "firefox",
      deviceClass: "tablet",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent(UA_FIREFOX_IOS), {
      browserFamily: "firefox",
      deviceClass: "mobile",
    });
  });

  test("returns null/null for absent, empty, whitespace, or non-string UA", () => {
    for (const input of [undefined, null, "", "   ", "\t\n", 42, {}, []]) {
      assert.deepEqual(parseClientTelemetryFromUserAgent(input), {
        browserFamily: null,
        deviceClass: null,
      });
    }
    assert.deepEqual(parseClientTelemetryFromUserAgent([UA_SAFARI_MOBILE, UA_CHROME_DESKTOP_MAC]), {
      browserFamily: "safari",
      deviceClass: "mobile",
    });
  });

  test("returns closed other/unknown tokens for CLI/unknown UAs without false-positive substring matches", () => {
    assert.deepEqual(parseClientTelemetryFromUserAgent("curl/8.5.0"), {
      browserFamily: "other",
      deviceClass: "unknown",
    });
    assert.deepEqual(parseClientTelemetryFromUserAgent("MyChrome/1.0 NotSafari/1.0"), {
      browserFamily: "other",
      deviceClass: "unknown",
    });
    assert.deepEqual(
      parseClientTelemetryFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) CustomApp/1.0"),
      { browserFamily: "other", deviceClass: "desktop" },
    );
  });

  test("bounds oversized UA input and leaks zero PII from adversarial headers", () => {
    const piiUa =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) alice@example.com bearer=sk-live-secret123; drop table users; Mobile/15E148 Safari/604.1";
    const parsed = parseClientTelemetryFromUserAgent(piiUa);
    assert.deepEqual(parsed, { browserFamily: "safari", deviceClass: "mobile" });
    assert.equal(JSON.stringify(parsed).includes("alice"), false);
    assert.equal(JSON.stringify(parsed).includes("sk-live"), false);

    // Tokens past the 512-char bound must not be scanned.
    const hugeUa = `${"X".repeat(10_000)} Chrome/128.0.0.0 Safari/537.36`;
    assert.deepEqual(parseClientTelemetryFromUserAgent(hugeUa), {
      browserFamily: "other",
      deviceClass: "unknown",
    });
  });
});

describe("TurnResponseMilestoneTracker & recordTurnResponseMilestone client telemetry", () => {
  test("attaches default connection telemetry to thinking and text milestones and supports per-turn null override", async () => {
    const { pool, frictionInserts } = makeRecordingPool();
    const tracker = new TurnResponseMilestoneTracker(512, {
      browserFamily: "safari",
      deviceClass: "mobile",
    });

    const browserTrace = "a".repeat(32);
    tracker.begin({
      traceId: browserTrace,
      sessionId: "sess_mobile",
      model: "gpt-6-astra",
      userId: 11n,
      startedAtMs: 1_000,
    });
    tracker.observe(
      {
        type: "outbound.message",
        traceId: browserTrace,
        peer: { id: "sess_mobile" },
        blocks: [{ kind: "thinking", text: "ponder" }],
        isFinal: false,
      },
      pool,
      undefined,
      1_400,
    );
    tracker.observe(
      {
        type: "outbound.message",
        traceId: browserTrace,
        peer: { id: "sess_mobile" },
        blocks: [{ kind: "text", text: "hello" }],
        isFinal: true,
      },
      pool,
      undefined,
      2_100,
    );

    // Non-browser turn (e.g. cron/recovery) explicitly passes null to avoid misattribution.
    const cronTrace = "b".repeat(32);
    tracker.begin({
      traceId: cronTrace,
      sessionId: "sess_cron",
      model: "gpt-6-astra",
      userId: 11n,
      startedAtMs: 3_000,
      browserFamily: null,
      deviceClass: null,
    });
    tracker.observe(
      {
        type: "outbound.message",
        traceId: cronTrace,
        peer: { id: "sess_cron" },
        blocks: [{ kind: "text", text: "cron done" }],
        isFinal: true,
      },
      pool,
      undefined,
      3_500,
    );

    await new Promise((r) => setImmediate(r));
    assert.equal(frictionInserts.length, 3);
    assert.deepEqual(
      frictionInserts.map((r) => [r.code, r.browserFamily, r.deviceClass]),
      [
        ["FIRST_THINKING_FRAME", "safari", "mobile"],
        ["FIRST_TEXT_FRAME", "safari", "mobile"],
        ["FIRST_TEXT_FRAME", null, null],
      ],
    );
  });

  test("sanitizes arbitrary/PII browserFamily & deviceClass inputs to null before SQL write", async () => {
    const { pool, frictionInserts } = makeRecordingPool();
    recordTurnResponseMilestone(pool, undefined, {
      traceId: "c".repeat(32),
      sessionId: "sess_san",
      model: "gpt-6-astra",
      userId: 12n,
      kind: "text",
      latencyMs: 250,
      browserFamily: "alice@example.com/secret" as never,
      deviceClass: "smartwatch_pii" as never,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(frictionInserts.length, 1);
    assert.equal(frictionInserts[0]!.code, "FIRST_TEXT_FRAME");
    assert.equal(frictionInserts[0]!.browserFamily, null);
    assert.equal(frictionInserts[0]!.deviceClass, null);
  });
});

describe("userChatBridge end-to-end WS upgrade User-Agent -> FIRST_*_FRAME telemetry (OCV5-40)", () => {
  async function runTurnWithUserAgent(userAgent: string | undefined): Promise<FrictionInsert[]> {
    const { pool, frictionInserts } = makeRecordingPool();
    const containerWss = new WebSocketServer({ port: 0 });
    let bridge: ReturnType<typeof createUserChatBridge> | null = null;
    let gateway: http.Server | null = null;
    try {
      await new Promise<void>((r) => containerWss.once("listening", () => r()));
      const containerPort = (containerWss.address() as { port: number }).port;
      const containerConnected = new Promise<WebSocket>((resolve) => {
        containerWss.on("connection", (ws) => resolve(ws));
      });

      bridge = createUserChatBridge({
        jwtSecret: JWT_SECRET,
        resolveContainerEndpoint: async () => ({ host: "127.0.0.1", port: containerPort }),
        loadAllowedModelChecker: async () => () => true,
        containerConnectTimeoutMs: 1_500,
        pgPool: pool,
        preCheckRedis: {
          async atomicReserve() { return { ok: true as const, locked: 0n, needed: 0n }; },
          async releaseReservation() { return true; },
        } as UserChatBridgeDeps["preCheckRedis"],
        pricing: { get() { return null; } } as unknown as UserChatBridgeDeps["pricing"],
      });

      gateway = http.createServer((_, res) => res.end());
      gateway.on("upgrade", (req, socket, head) => {
        if (userAgent === undefined) {
          req.headers["user-agent"] = undefined;
        }
        if (!bridge!.handleUpgrade(req, socket, head)) {
          socket.destroy();
        }
      });
      await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", () => r()));
      const gatewayPort = (gateway.address() as { port: number }).port;

      const { token } = await signAccess({ sub: "404", role: "user" }, JWT_SECRET);
      const clientWs = new WebSocket(
        `ws://127.0.0.1:${gatewayPort}${BRIDGE_WS_PATH}`,
        ["bearer", token],
        userAgent !== undefined ? { headers: { "User-Agent": userAgent } } : undefined,
      );
      await new Promise<void>((r) => clientWs.once("open", () => r()));
      const containerWs = await containerConnected;

      const forwardedP = new Promise<{ traceId: string }>((resolve) => {
        containerWs.on("message", (data) => {
          const text = typeof data === "string" ? data : data.toString("utf8");
          const parsed = JSON.parse(text) as { type?: string; traceId?: string };
          if (parsed.type === "inbound.message" && typeof parsed.traceId === "string") {
            resolve({ traceId: parsed.traceId });
          }
        });
      });

      clientWs.send(JSON.stringify({
        type: "inbound.message",
        model: "gpt-6-astra",
        peer: { id: "sess_ocv5_40" },
        clientMessageId: "cmid-ocv5-40",
        content: [{ type: "text", text: "ping" }],
      }));
      const { traceId } = await forwardedP;

      containerWs.send(JSON.stringify({
        type: "outbound.message",
        traceId,
        peer: { id: "sess_ocv5_40" },
        blocks: [{ kind: "thinking", text: "checking" }],
        isFinal: false,
      }));
      containerWs.send(JSON.stringify({
        type: "outbound.message",
        traceId,
        peer: { id: "sess_ocv5_40" },
        blocks: [{ kind: "text", text: "pong" }],
        isFinal: true,
      }));

      await waitFor(() =>
        frictionInserts.filter(
          (e) => e.code === "FIRST_THINKING_FRAME" || e.code === "FIRST_TEXT_FRAME",
        ).length === 2
          ? true
          : undefined,
      );

      clientWs.close();
      await new Promise<void>((r) => {
        if (clientWs.readyState === WebSocket.CLOSED) return r();
        clientWs.once("close", () => r());
      });
      return frictionInserts.filter(
        (e) => e.code === "FIRST_THINKING_FRAME" || e.code === "FIRST_TEXT_FRAME",
      );
    } finally {
      if (bridge) await bridge.shutdown();
      for (const client of containerWss.clients) client.terminate();
      await new Promise<void>((r) => containerWss.close(() => r()));
      if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
    }
  }

  test("Safari Mobile WS upgrade attaches safari/mobile to FIRST_THINKING_FRAME and FIRST_TEXT_FRAME with zero raw UA leakage", async () => {
    const events = await runTurnWithUserAgent(UA_SAFARI_MOBILE);
    assert.deepEqual(
      events.map((e) => [e.code, e.browserFamily, e.deviceClass]),
      [
        ["FIRST_THINKING_FRAME", "safari", "mobile"],
        ["FIRST_TEXT_FRAME", "safari", "mobile"],
      ],
    );
    for (const e of events) {
      assert.equal(JSON.stringify(e.params).includes("AppleWebKit"), false);
      assert.equal(JSON.stringify(e.params).includes("iPhone"), false);
    }
  });

  test("Chrome Desktop WS upgrade attaches chrome/desktop to FIRST_THINKING_FRAME and FIRST_TEXT_FRAME", async () => {
    const events = await runTurnWithUserAgent(UA_CHROME_DESKTOP_MAC);
    assert.deepEqual(
      events.map((e) => [e.code, e.browserFamily, e.deviceClass]),
      [
        ["FIRST_THINKING_FRAME", "chrome", "desktop"],
        ["FIRST_TEXT_FRAME", "chrome", "desktop"],
      ],
    );
  });

  test("Absent User-Agent WS upgrade preserves null/null backward compatibility", async () => {
    const events = await runTurnWithUserAgent(undefined);
    assert.deepEqual(
      events.map((e) => [e.code, e.browserFamily, e.deviceClass]),
      [
        ["FIRST_THINKING_FRAME", null, null],
        ["FIRST_TEXT_FRAME", null, null],
      ],
    );
  });
});
