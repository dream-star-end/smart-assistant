/**
 * Swarm 蜂群操控指令(并发锁 / 诚实终止协议 / 会话 HTTP 路由 / 高阶剧本模板)单测(OCV5-828 R2 · B5 + B8)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/swarmCommand.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { readAntigravitySwarmSnapshot } from "../engine/antigravitySwarmWatcher.js";
import {
  expandSwarmPlaybook,
  getSwarmPlaybook,
  handleSwarmCommandRoute,
  injectSwarmDirective,
  listSwarmPlaybooks,
  parseSwarmControlCommand,
  terminateSwarmMember,
} from "../swarmCommand.js";

const COORD_CONV = "11111111-1111-4111-8111-111111111111";

function setupSwarmFixture(brainDir: string): string {
  const swarmDir = path.join(brainDir, COORD_CONV, ".system_generated", "swarm");
  mkdirSync(swarmDir, { recursive: true });
  writeFileSync(
    path.join(swarmDir, "members.json"),
    JSON.stringify(
      {
        title: "测试蜂群",
        members: {
          coordinator: { conversation_id: COORD_CONV, role: "coordinator", killed: false },
          "worker-1": { conversation_id: "22222222-2222-4222-8222-222222222222", role: "worker", killed: false },
          "dead-worker": { role: "worker", killed: true },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(swarmDir, "board.jsonl"),
    `${JSON.stringify({ seq: 1, agent: "coordinator", channel: "main", text: "@worker-1 开始执行", time: "2026-11-21T00:00:00.000Z" })}\n`,
  );
  return swarmDir;
}

function makeReq(opts: { method: string; url: string; body?: unknown; userId?: string }): IncomingMessage {
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  req.method = opts.method;
  req.url = opts.url;
  req.headers = {
    ...(opts.userId ? { "x-test-uid": opts.userId } : {}),
    ...(payload ? { "content-type": "application/json" } : {}),
  };
  return req;
}

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    get statusCode() {
      return status;
    },
    set statusCode(v: number) {
      status = v;
    },
    setHeader() {},
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
  };
}

describe("injectSwarmDirective", () => {
  it("injects @coordinator and @member directives into board.jsonl with monotonic seq under lock", async () => {
    const brainDir = mkdtempSync(path.join(tmpdir(), "oc-swarm-cmd-"));
    try {
      setupSwarmFixture(brainDir);

      const r1 = await injectSwarmDirective({
        brainDir,
        conversationId: COORD_CONV,
        target: "coordinator",
        message: "请优先收口单测再进入文档阶段",
        now: Date.parse("2026-11-21T01:00:00.000Z"),
      });
      assert.equal(r1.ok, true);
      if (r1.ok) {
        assert.equal(r1.seq, 2);
        assert.ok(r1.text.startsWith("@coordinator "));
        assert.deepEqual(r1.mentions, ["coordinator"]);
      }

      const r2 = await injectSwarmDirective({
        brainDir,
        conversationId: COORD_CONV,
        target: "@worker-1",
        message: "@worker-1 注意不要修改 handlers.ts",
        now: Date.parse("2026-11-21T01:01:00.000Z"),
      });
      assert.equal(r2.ok, true);
      if (r2.ok) assert.equal(r2.seq, 3);

      const snap = readAntigravitySwarmSnapshot({
        brainDir,
        conversationId: COORD_CONV,
        phase: "running",
        revision: 1,
      });
      assert.equal(snap?.totalPosts, 3);
      assert.equal(snap?.posts[1]?.agent, "human");
      assert.equal(snap?.posts[2]?.seq, 3);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });

  it("rejects killed/unknown targets, invalid conversationId, and symlinked board.jsonl", async () => {
    const brainDir = mkdtempSync(path.join(tmpdir(), "oc-swarm-sec-"));
    const outside = mkdtempSync(path.join(tmpdir(), "oc-swarm-out-"));
    try {
      const swarmDir = setupSwarmFixture(brainDir);

      const killedRes = await injectSwarmDirective({
        brainDir,
        conversationId: COORD_CONV,
        target: "dead-worker",
        message: "wake up",
      });
      assert.equal(killedRes.ok, false);
      if (!killedRes.ok) assert.equal(killedRes.code, "MEMBER_ALREADY_KILLED");

      const unknownRes = await injectSwarmDirective({
        brainDir,
        conversationId: COORD_CONV,
        target: "ghost",
        message: "hello",
      });
      assert.equal(unknownRes.ok, false);
      if (!unknownRes.ok) assert.equal(unknownRes.code, "MEMBER_NOT_FOUND");

      const badConv = await injectSwarmDirective({
        brainDir,
        conversationId: "../escape",
        target: "coordinator",
        message: "hello",
      });
      assert.equal(badConv.ok, false);
      if (!badConv.ok) assert.equal(badConv.code, "INVALID_CONVERSATION_ID");

      const outsideBoard = path.join(outside, "evil.jsonl");
      writeFileSync(outsideBoard, "");
      rmSync(path.join(swarmDir, "board.jsonl"));
      symlinkSync(outsideBoard, path.join(swarmDir, "board.jsonl"));

      const symRes = await injectSwarmDirective({
        brainDir,
        conversationId: COORD_CONV,
        target: "coordinator",
        message: "stop",
      });
      assert.equal(symRes.ok, false);
      if (!symRes.ok) assert.equal(symRes.code, "SYMLINK_REJECTED");
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("P1-1: serializes concurrent directives via async queue, backs off on external .board.lock without blocking event loop, rejects lock symlinks, and handles >4MB boards", async () => {
    const brainDir = mkdtempSync(path.join(tmpdir(), "oc-swarm-async-lock-"));
    const outside = mkdtempSync(path.join(tmpdir(), "oc-swarm-lock-out-"));
    try {
      const swarmDir = setupSwarmFixture(brainDir);

      // 1. 12 concurrent directives on same swarmDir produce unique monotonic seq 2..13
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, idx) =>
          injectSwarmDirective({
            brainDir,
            conversationId: COORD_CONV,
            target: "worker-1",
            message: `并发消息 #${idx}`,
            now: Date.parse("2026-11-21T03:00:00.000Z") + idx * 1000,
          }),
        ),
      );
      const seqs = results.map((r) => {
        assert.equal(r.ok, true);
        return r.ok ? r.seq : -1;
      });
      assert.deepEqual(
        [...seqs].sort((a, b) => a - b),
        [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      );

      // 2. External .board.lock held for 60ms: async backoff waits without blocking timers
      const lockPath = path.join(swarmDir, ".board.lock");
      writeFileSync(lockPath, "999999:0\n");
      let timerTicks = 0;
      const tickInterval = setInterval(() => {
        timerTicks += 1;
      }, 10);
      setTimeout(() => {
        rmSync(lockPath, { force: true });
      }, 60);
      try {
        const waitedRes = await injectSwarmDirective({
          brainDir,
          conversationId: COORD_CONV,
          target: "coordinator",
          message: "等待锁释放后写入",
          lockTimeoutMs: 1_000,
        });
        assert.equal(waitedRes.ok, true);
        if (waitedRes.ok) assert.equal(waitedRes.seq, 14);
        assert.ok(timerTicks >= 1, "async lock wait must not freeze the Node.js event loop");
      } finally {
        clearInterval(tickInterval);
      }

      // 3. Symlinked .board.lock is rejected fail-closed
      const evilLock = path.join(outside, "evil.lock");
      writeFileSync(evilLock, "x");
      symlinkSync(evilLock, lockPath);
      const symLockRes = await injectSwarmDirective({
        brainDir,
        conversationId: COORD_CONV,
        target: "coordinator",
        message: "must reject lock symlink",
        lockTimeoutMs: 200,
      });
      assert.equal(symLockRes.ok, false);
      if (!symLockRes.ok) assert.equal(symLockRes.code, "SYMLINK_REJECTED");
      rmSync(lockPath, { force: true });

      // 4. Large >4.5MB board.jsonl succeeds via O(1) tail scan without hitting legacy 4MB wall
      const bigFiller = "长讨论板内容".repeat(400);
      const chunks: string[] = [];
      let seq = 1;
      let bytes = 0;
      while (bytes < 4.6 * 1024 * 1024) {
        const line = `${JSON.stringify({ seq, agent: "worker-1", channel: "main", text: bigFiller })}\n`;
        chunks.push(line);
        bytes += Buffer.byteLength(line, "utf8");
        seq += 1;
      }
      writeFileSync(path.join(swarmDir, "board.jsonl"), chunks.join(""), "utf8");
      const lastSeqBefore = seq - 1;
      const bigBoardRes = await injectSwarmDirective({
        brainDir,
        conversationId: COORD_CONV,
        target: "coordinator",
        message: "超大讨论板续写测试",
      });
      assert.equal(bigBoardRes.ok, true);
      if (bigBoardRes.ok) assert.equal(bigBoardRes.seq, lastSeqBefore + 1);
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("B8: terminateSwarmMember honest status protocol (requested vs confirmed vs already_killed)", () => {
  it("posts @coordinator kill request without falsely mutating members.json, reports confirmed only with executor receipt, and fails loudly on board error", async () => {
    const brainDir = mkdtempSync(path.join(tmpdir(), "oc-swarm-kill-"));
    const outside = mkdtempSync(path.join(tmpdir(), "oc-swarm-kill-out-"));
    try {
      const swarmDir = setupSwarmFixture(brainDir);

      // Refuses coordinator termination
      const coordKill = await terminateSwarmMember({
        brainDir,
        conversationId: COORD_CONV,
        memberName: "coordinator",
      });
      assert.equal(coordKill.ok, false);
      if (!coordKill.ok) assert.equal(coordKill.code, "CANNOT_KILL_COORDINATOR");

      // Without executor confirmation → status === 'requested', members.json NOT overwritten!
      const reqRes = await terminateSwarmMember({
        brainDir,
        conversationId: COORD_CONV,
        memberName: "worker-1",
        reason: "陷入重复编译循环",
        now: Date.parse("2026-11-21T02:00:00.000Z"),
      });
      assert.equal(reqRes.ok, true);
      if (reqRes.ok) {
        assert.equal(reqRes.status, "requested");
        assert.equal(reqRes.alreadyKilled, false);
        assert.equal(reqRes.noticeSeq, 2);
      }
      const rosterUnchanged = JSON.parse(readFileSync(path.join(swarmDir, "members.json"), "utf8")) as {
        members: Record<string, { killed: boolean }>;
      };
      assert.equal(rosterUnchanged.members["worker-1"]?.killed, false);

      // With authoritative executor confirmation → status === 'confirmed'
      const confRes = await terminateSwarmMember({
        brainDir,
        conversationId: COORD_CONV,
        memberName: "worker-1",
        reason: "确认终止",
        confirmByExecutor: () => true,
      });
      assert.equal(confRes.ok, true);
      if (confRes.ok) {
        assert.equal(confRes.status, "confirmed");
        assert.equal(confRes.noticeSeq, 3);
      }

      // Already killed member → status === 'already_killed'
      const deadRes = await terminateSwarmMember({
        brainDir,
        conversationId: COORD_CONV,
        memberName: "dead-worker",
      });
      assert.equal(deadRes.ok, true);
      if (deadRes.ok) {
        assert.equal(deadRes.status, "already_killed");
        assert.equal(deadRes.alreadyKilled, true);
      }

      // Board write failure MUST NOT be swallowed!
      const evilBoard = path.join(outside, "evil.jsonl");
      writeFileSync(evilBoard, "");
      rmSync(path.join(swarmDir, "board.jsonl"));
      symlinkSync(evilBoard, path.join(swarmDir, "board.jsonl"));
      const failRes = await terminateSwarmMember({
        brainDir,
        conversationId: COORD_CONV,
        memberName: "worker-1",
      });
      assert.equal(failRes.ok, false);
      if (!failRes.ok) assert.equal(failRes.code, "SYMLINK_REJECTED");
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("B5: handleSwarmCommandRoute (POST /api/sessions/:id/swarm/command)", () => {
  it("authenticates uid, enforces session ownership, rejects client brainDir, and dispatches steer/kill/playbook", async () => {
    const brainDir = mkdtempSync(path.join(tmpdir(), "oc-swarm-route-"));
    try {
      setupSwarmFixture(brainDir);

      const deps = {
        authenticate: async (req: IncomingMessage) => {
          const uid = req.headers["x-test-uid"];
          return typeof uid === "string" ? { id: uid } : null;
        },
        resolveSessionSwarm: async (uid: string, sessionId: string) => {
          if (sessionId !== "sess-1") return null;
          if (uid !== "user-a") return "forbidden" as const;
          return { brainDir, conversationId: COORD_CONV };
        },
      };

      // 401 unauthenticated
      const r401 = makeRes();
      await handleSwarmCommandRoute(
        makeReq({ method: "POST", url: "/api/sessions/sess-1/swarm/command", body: { action: "steer" } }),
        r401.res,
        deps,
      );
      assert.equal(r401.status(), 401);

      // 403 unowned session
      const r403 = makeRes();
      await handleSwarmCommandRoute(
        makeReq({
          method: "POST",
          url: "/api/sessions/sess-1/swarm/command",
          userId: "user-b",
          body: { action: "steer", target: "coordinator", message: "hi" },
        }),
        r403.res,
        deps,
      );
      assert.equal(r403.status(), 403);

      // 400 client-supplied brainDir rejected!
      const r400 = makeRes();
      await handleSwarmCommandRoute(
        makeReq({
          method: "POST",
          url: "/api/sessions/sess-1/swarm/command",
          userId: "user-a",
          body: { action: "steer", target: "coordinator", message: "hi", brainDir: "/etc" },
        }),
        r400.res,
        deps,
      );
      assert.equal(r400.status(), 400);

      // 200 steer happy path
      const r200 = makeRes();
      await handleSwarmCommandRoute(
        makeReq({
          method: "POST",
          url: "/api/sessions/sess-1/swarm/command",
          userId: "user-a",
          body: { command: "/swarm-steer @worker-1 先跑单测" },
        }),
        r200.res,
        deps,
      );
      assert.equal(r200.status(), 200);
      assert.equal((r200.json() as { seq: number }).seq, 2);

      // 200 terminate request returns status='requested'
      const rKill = makeRes();
      await handleSwarmCommandRoute(
        makeReq({
          method: "POST",
          url: "/api/sessions/sess-1/swarm/command",
          userId: "user-a",
          body: { action: "terminate", memberName: "worker-1", reason: "stuck" },
        }),
        rKill.res,
        deps,
      );
      assert.equal(rKill.status(), 200);
      assert.equal((rKill.json() as { status: string }).status, "requested");
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });
});

describe("Swarm playbook templates & command parser", () => {
  it("ships 6 built-in research/engineering templates and expands them cleanly by ID or Chinese title", () => {
    const all = listSwarmPlaybooks();
    assert.equal(all.length, 6);
    assert.deepEqual(
      all.map((t) => t.title),
      [
        "并行实现+验收",
        "多源文献深研+核验",
        "架构深度体检",
        "多方案评审",
        "论文写作+盲审+批判修订",
        "受控实验循环（防刷分）",
      ],
    );

    const writeReview = getSwarmPlaybook("research-write-review-revise");
    assert.ok(writeReview);
    assert.equal(writeReview.category, "research");
    assert.equal(getSwarmPlaybook("写审修")?.id, "research-write-review-revise");
    assert.ok(writeReview.roles.some((r) => r.name === "blind-reviewer" && r.readOnly === true));

    const expLoop = getSwarmPlaybook("research-controlled-exp-loop");
    assert.ok(expLoop);
    assert.equal(expLoop.category, "research");
    assert.equal(getSwarmPlaybook("防刷分实验循环")?.id, "research-controlled-exp-loop");
    assert.ok(expLoop.roles.some((r) => r.name === "eval-guardian" && r.readOnly === true));

    for (const tpl of all) {
      assert.equal(getSwarmPlaybook(tpl.id)?.id, tpl.id);
      assert.equal(getSwarmPlaybook(tpl.title)?.id, tpl.id);
      const expanded = expandSwarmPlaybook(tpl.title, "重构科研引用引擎", {
        constraints: ["禁止修改 packages/web-react/**"],
      });
      assert.ok(expanded);
      assert.ok(expanded.prompt.includes(tpl.title));
      assert.ok(expanded.prompt.includes("重构科研引用引擎"));
      assert.ok(expanded.kickoffBoardMessage.startsWith("@all "));
      assert.ok(expanded.roles.some((r) => r.role === "coordinator"));
    }

    assert.equal(expandSwarmPlaybook("unknown-template", "task"), null);
    assert.equal(expandSwarmPlaybook("parallel-impl-verify", "   "), null);
  });

  it("parses /swarm-steer, /swarm-kill, and /swarm-playbook operator commands", () => {
    assert.deepEqual(parseSwarmControlCommand("/swarm-steer @worker-1 请先补单测"), {
      kind: "steer",
      target: "worker-1",
      message: "请先补单测",
    });
    assert.deepEqual(parseSwarmControlCommand("/swarm-kill worker-1 卡死超时"), {
      kind: "kill",
      memberName: "worker-1",
      reason: "卡死超时",
    });
    assert.deepEqual(parseSwarmControlCommand("/swarm-playbook 架构深度体检 审查 gateway 鉴权边界"), {
      kind: "playbook",
      templateId: "架构深度体检",
      task: "审查 gateway 鉴权边界",
    });
    assert.equal(parseSwarmControlCommand("ordinary message"), null);
  });
});
