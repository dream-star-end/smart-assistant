/**
 * M2 — idle-timeout turn-waive 记账键口径测试(settle=waive 同值红线的 waive 侧)。
 *
 * 覆盖:
 *   1. waiveAccountingSessionId 纯函数:billingMode 能力分支 ——
 *      'engine-reported'(codex)→ engineSessionId(sessionKey)(恒可派生);
 *      'proxy'(CCB)→ ccb 原生 session id;未学到 → null(caller 跳过上报)。
 *   2. e2e:codex session 上 _reportTurnWaive 实际 POST /internal/v3/turn-waive
 *      的 body.sessionId === engineSessionId(session.sessionKey) —— 与
 *      CodexAdapter billing 事件(codexAdapterTurnParity.test.ts L273 断言
 *      engineSessionId(SESSION_KEY))同 helper 同入参,settle 与 waive 由构造
 *      保证同值;且满足 master 端 internalTurnWaive SESSION_ID_RE。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionManagerTurnWaive.test.ts
 */

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

import { SessionManager, waiveAccountingSessionId } from "../sessionManager.js";
// side-effect:注册 'ccb' / 'codex' factory。
import "../engine/ccbAdapter.js";
import "../engine/codexAdapter.js";
import { engineSessionId } from "../engine/engineSessionId.js";
import type { AgentDef, OpenClaudeConfig } from "@openclaude/storage";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/; // 镜像 internalTurnWaive.ts,不放宽

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: "127.0.0.1", port: 0, accessToken: "" },
    auth: { mode: "subscription", claudeCodePath: "" },
    sessions: { dbPath: "" },
    defaults: { model: "glm-5.2" },
  } as unknown as OpenClaudeConfig;
}

function makeSm(): SessionManager {
  const sm = new SessionManager(makeConfigStub());
  const ins = sm as unknown as {
    _saveResumeMap: () => void;
    _resumeMap: Map<string, string>;
    _resumeMapProvider: Map<string, string>;
  };
  ins._saveResumeMap = () => {};
  ins._resumeMap.clear();
  ins._resumeMapProvider.clear();
  return sm;
}

describe("waiveAccountingSessionId(记账键能力分支)", () => {
  test("engine-reported(codex)→ engineSessionId(sessionKey),不依赖 native id", () => {
    const key = "agent:main:webchat:dm:waive-peer";
    assert.equal(
      waiveAccountingSessionId({ billingMode: "engine-reported", sessionKey: key, ccbSessionId: null }),
      engineSessionId(key),
    );
    // 即便 ccbSessionId 有值(理论不发生),engine-reported 也**不得**用它
    assert.equal(
      waiveAccountingSessionId({
        billingMode: "engine-reported",
        sessionKey: key,
        ccbSessionId: "ccb-native-uuid",
      }),
      engineSessionId(key),
    );
    // 满足 master 端点校验(不放宽)
    assert.match(waiveAccountingSessionId({ billingMode: "engine-reported", sessionKey: key, ccbSessionId: null })!, SESSION_ID_RE);
  });

  test("proxy(CCB)→ ccb 原生 session id;未学到 → null(跳过上报)", () => {
    assert.equal(
      waiveAccountingSessionId({
        billingMode: "proxy",
        sessionKey: "agent:main:webchat:dm:x",
        ccbSessionId: "ccb-uuid-1",
      }),
      "ccb-uuid-1",
    );
    assert.equal(
      waiveAccountingSessionId({ billingMode: "proxy", sessionKey: "k", ccbSessionId: null }),
      null,
    );
    // billingMode 未知(防御)→ 沿 CCB 语义,不误派生 engine 键
    assert.equal(
      waiveAccountingSessionId({ billingMode: undefined, sessionKey: "k", ccbSessionId: null }),
      null,
    );
  });
});

describe("_reportTurnWaive e2e(codex session → master turn-waive POST)", () => {
  const KEY = "agent:main:webchat:dm:waive-e2e";
  const mainAgent = { id: "main", model: "glm-5.2" } as AgentDef;
  const savedBase = process.env.OPENCLAUDE_V3_MASTER_BASE_URL;
  const savedToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN;

  after(() => {
    if (savedBase === undefined) delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL;
    else process.env.OPENCLAUDE_V3_MASTER_BASE_URL = savedBase;
    if (savedToken === undefined) delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN;
    else process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = savedToken;
  });

  test("POST body.sessionId = engineSessionId(sessionKey)(与 settle 同 helper 同入参)", async () => {
    // 本测试等真实 SEND_DELAY_MS(5s)—— masterTurnWaive 有意延迟让在飞 settle
    // 落定;_reportTurnWaive 不传测试钩子(生产路径原样)。
    const received: Array<{ auth: string | undefined; body: unknown }> = [];
    let notify: (() => void) | null = null;
    const gotOne = new Promise<void>((r) => { notify = r; });
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(raw || "null") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ refundedCredits: "0" }));
        notify?.();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = "test-container-token";

    try {
      const sm = makeSm();
      const session = await sm.getOrCreate({
        sessionKey: KEY,
        agent: mainAgent,
        channel: "webchat",
        peerId: "waive-e2e",
        model: "gpt-5.6-sol", // resolveEngine → codex(engine-reported)
      });
      assert.equal(session.runner.capabilities.billingMode, "engine-reported");

      (sm as unknown as {
        _reportTurnWaive(s: unknown, reason: string): void;
      })._reportTurnWaive(session, "idle_timeout");

      // SEND_DELAY_MS = 5s + 网络余量
      await Promise.race([
        gotOne,
        new Promise((_r, rej) => setTimeout(() => rej(new Error("waive POST 未在 8s 内到达")), 8_000)),
      ]);

      assert.equal(received.length, 1);
      const body = received[0]!.body as { sessionId?: string; reason?: string; sinceTs?: number };
      assert.equal(body.sessionId, engineSessionId(KEY), "waive 记账键必须 = engineSessionId(sessionKey)");
      assert.match(body.sessionId!, SESSION_ID_RE);
      assert.equal(body.reason, "idle_timeout");
      assert.equal(typeof body.sinceTs, "number");
      assert.equal(received[0]!.auth, "Bearer test-container-token");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
