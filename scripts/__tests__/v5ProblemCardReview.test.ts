import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildOcTaskArgs,
  dockerCopyDigestArgv,
  dockerExecOcTaskArgv,
  fingerprintOf,
  inboxTitle,
  nextActions,
  parseWindowHours,
  renderDigest,
  renderTicketBody,
  safeDate,
  shouldOpenTicket,
  type FingerprintAgg,
  type ReviewAgg,
  type StateFile,
  type TicketRef,
  type WindowCounts,
} from "../v5-problem-card-review.js";

function counts(partial: Partial<WindowCounts> = {}): WindowCounts {
  return {
    shown: 0,
    recovered: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
    affected_users: 0,
    affected_users_failed: 0,
    p50_recover_ms: null,
    traces: [],
    ...partial,
  };
}

function fpRow(over: Partial<FingerprintAgg> & { fingerprint: string }): FingerprintAgg {
  const parts = over.fingerprint.split(":");
  return {
    stage: parts[0] ?? "problem_card",
    code: parts[1] ?? "upstream_failed",
    path: parts[2] ?? "-",
    reason: parts[3] ?? "-",
    h24: counts(),
    d7: counts(),
    ...over,
  };
}

function aggOf(rows: FingerprintAgg[], date = "2026-09-08"): ReviewAgg {
  return {
    date,
    windowHours: 24,
    fingerprints: rows,
    decisions: [{ key: "not_recoverable", n: 4 }],
    jobs: [{ key: "automatic_retry_exhausted", n: 2 }],
    fallbacks: [{ key: "visible_fallback", n: 1 }],
  };
}

describe("fingerprintOf", () => {
  test("NULL/empty path and reason become -", () => {
    assert.equal(
      fingerprintOf({ stage: "problem_card", code: "upstream_failed", path: null, reason: null }),
      "problem_card:upstream_failed:-:-",
    );
    assert.equal(
      fingerprintOf({ stage: "problem_card", code: "upstream_failed", path: "", reason: "  " }),
      "problem_card:upstream_failed:-:-",
    );
  });

  test("unknown tokens become other", () => {
    assert.equal(
      fingerprintOf({
        stage: "problem_card",
        code: "upstream_failed",
        path: "Immediate!",
        reason: "not recoverable",
      }),
      "problem_card:upstream_failed:other:other",
    );
  });

  test("bounded snake tokens pass through", () => {
    assert.equal(
      fingerprintOf({
        stage: "recovery_decision",
        code: "upstream_failed",
        path: "decision",
        reason: "not_recoverable",
      }),
      "recovery_decision:upstream_failed:decision:not_recoverable",
    );
  });
});

describe("shouldOpenTicket threshold quadrants", () => {
  test("failed>=3 AND affected_users_failed>=2 opens", () => {
    assert.equal(shouldOpenTicket({ failed: 3, affected_users_failed: 2 }), true);
    assert.equal(shouldOpenTicket({ failed: 10, affected_users_failed: 3 }), true);
  });

  test("failed>=5 opens even for a single user", () => {
    assert.equal(shouldOpenTicket({ failed: 5, affected_users_failed: 1 }), true);
    assert.equal(shouldOpenTicket({ failed: 5, affected_users_failed: 0 }), true);
  });

  test("failed=3 with one user does not open", () => {
    assert.equal(shouldOpenTicket({ failed: 3, affected_users_failed: 1 }), false);
    assert.equal(shouldOpenTicket({ failed: 4, affected_users_failed: 1 }), false);
  });

  test("high user count with failed<3 does not open", () => {
    assert.equal(shouldOpenTicket({ failed: 2, affected_users_failed: 9 }), false);
    assert.equal(shouldOpenTicket({ failed: 0, affected_users_failed: 0 }), false);
  });
});

describe("safeDate", () => {
  test("accepts ISO calendar dates", () => {
    assert.equal(safeDate("2026-09-08"), "2026-09-08");
    assert.equal(safeDate("2026-02-28"), "2026-02-28");
  });

  test("rejects illegal dates", () => {
    assert.throws(() => safeDate("2026-13-01"), /invalid --date/);
    assert.throws(() => safeDate("2026-02-30"), /invalid --date/);
    assert.throws(() => safeDate("2026/09/08"), /invalid --date/);
    assert.throws(() => safeDate("today"), /invalid --date/);
    assert.throws(() => safeDate("2026-9-8"), /invalid --date/);
  });

  test("empty falls back to CST today", () => {
    const fixed = new Date("2026-09-07T16:30:00Z"); // CST 2026-09-08 00:30
    assert.equal(safeDate(undefined, fixed), "2026-09-08");
    assert.equal(safeDate("", fixed), "2026-09-08");
  });
});

describe("parseWindowHours", () => {
  test("default and range", () => {
    assert.equal(parseWindowHours(undefined), 24);
    assert.equal(parseWindowHours("1h"), 1);
    assert.equal(parseWindowHours("720h"), 720);
    assert.throws(() => parseWindowHours("0h"), /out of range/);
    assert.throws(() => parseWindowHours("721h"), /out of range/);
    assert.throws(() => parseWindowHours("24"), /invalid --window/);
  });
});

describe("renderTicketBody stays bounded", () => {
  test("includes counts/traces/classification and drops unbounded extras", () => {
    const fingerprint = "problem_card:upstream_failed:immediate:-";
    const review = aggOf([
      fpRow({
        fingerprint,
        stage: "problem_card",
        code: "upstream_failed",
        path: "immediate",
        reason: "-",
        h24: counts({
          shown: 6,
          failed: 5,
          recovered: 1,
          affected_users: 2,
          affected_users_failed: 2,
          traces: ["tr_aaa", "tr_bbb", "tr_ccc"],
        }),
        d7: counts({ shown: 20, failed: 12, recovered: 4, traces: ["tr_aaa"] }),
      }),
    ]);
    (review as unknown as { message: string }).message = "SECRET_STACK_TRACE /usr/secret";
    (review as unknown as { userAgent: string }).userAgent = "Mozilla/5.0";
    (review as unknown as { url: string }).url = "https://evil.example/trace";
    const body = renderTicketBody(fingerprint, review);
    assert.match(body, /problem_card:upstream_failed:immediate:-/);
    assert.match(body, /真故障或不可恢复码/);
    assert.match(body, /tr_aaa/);
    assert.match(body, /not_recoverable/);
    assert.equal(body.includes("SECRET_STACK_TRACE"), false);
    assert.equal(body.includes("Mozilla/5.0"), false);
    assert.equal(body.includes("evil.example"), false);
    assert.equal(/stack/i.test(body), false);
    assert.equal(/user-agent|user_agent/i.test(body), false);
  });
});

describe("renderDigest", () => {
  test("empty aggregation still renders a complete digest", () => {
    const md = renderDigest(aggOf([]));
    assert.match(md, /^# 问题卡日报 2026-09-08/m);
    assert.match(md, /空聚合/);
    assert.match(md, /今日动作/);
    assert.match(md, /不查 messages/);
  });

  test("top table orders by failed and inbox title uses N/M/rate", () => {
    const review = aggOf([
      fpRow({
        fingerprint: "problem_card:a:immediate:-",
        h24: counts({ shown: 2, failed: 2, recovered: 0, affected_users_failed: 1 }),
      }),
      fpRow({
        fingerprint: "visible_fallback:completed:reconciler:orphan",
        stage: "visible_fallback",
        path: "reconciler",
        reason: "orphan",
        h24: counts({ shown: 9, failed: 9, recovered: 0, affected_users_failed: 3 }),
      }),
    ]);
    const md = renderDigest(review, [
      {
        kind: "create",
        fingerprint: "visible_fallback:completed:reconciler:orphan",
        title: "problem-card: visible_fallback:completed:reconciler:orphan",
        body: "x",
      },
    ]);
    const posFallback = md.indexOf("visible_fallback:completed:reconciler:orphan");
    const posA = md.indexOf("problem_card:a:immediate:-");
    assert.ok(posFallback > 0 && posA > posFallback);
    assert.match(md, /对账占位/);
    assert.match(md, /新建单/);
    assert.equal(inboxTitle(review), "问题卡日报 2026-09-08：2 类 / 11 张终态卡 / 恢复率 0.0%");
  });
});

describe("nextActions", () => {
  const qualifying = fpRow({
    fingerprint: "problem_card:upstream_failed:immediate:-",
    stage: "problem_card",
    path: "immediate",
    h24: counts({ shown: 5, failed: 5, recovered: 0, affected_users: 2, affected_users_failed: 2 }),
    d7: counts({ shown: 5, failed: 5 }),
  });

  test("no ticket + threshold → create", () => {
    const { actions } = nextActions(aggOf([qualifying]), { fingerprints: {} }, []);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.kind, "create");
    assert.equal(actions[0]!.fingerprint, qualifying.fingerprint);
    if (actions[0]!.kind === "create") {
      assert.equal(actions[0].title, `problem-card: ${qualifying.fingerprint}`);
      assert.match(actions[0].body, /真故障或不可恢复码/);
    }
  });

  test("idempotent second run with same counts does nothing", () => {
    const review = aggOf([qualifying]);
    const tickets: TicketRef[] = [
      { identifier: "OCV5-170", title: `problem-card: ${qualifying.fingerprint}`, status: "backlog" },
    ];
    const state: StateFile = {
      fingerprints: {
        [qualifying.fingerprint]: {
          identifier: "OCV5-170",
          created_at: "2026-09-08",
          last_counts: {
            shown: 5,
            recovered: 0,
            failed: 5,
            cancelled: 0,
            pending: 0,
            affected_users: 2,
            affected_users_failed: 2,
          },
          daily: [{ date: "2026-09-08", failed: 5 }],
        },
      },
    };
    const { actions } = nextActions(review, state, tickets);
    assert.deepEqual(actions, []);
  });

  test("existing ticket + changed counts + not commented today → comment", () => {
    const review = aggOf([qualifying]);
    const tickets: TicketRef[] = [
      { identifier: "OCV5-170", title: `problem-card: ${qualifying.fingerprint}`, status: "ready" },
    ];
    const state: StateFile = {
      fingerprints: {
        [qualifying.fingerprint]: {
          identifier: "OCV5-170",
          created_at: "2026-09-07",
          last_comment_date: "2026-09-07",
          last_counts: { shown: 3, failed: 3, recovered: 0, cancelled: 0, pending: 0, affected_users: 2, affected_users_failed: 2 },
          daily: [{ date: "2026-09-07", failed: 3 }],
        },
      },
    };
    const { actions } = nextActions(review, state, tickets);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.kind, "comment");
    if (actions[0]!.kind === "comment") {
      assert.equal(actions[0].identifier, "OCV5-170");
      assert.match(actions[0].body, /failed=5/);
    }
  });

  test("already commented today stays silent even if counts differ", () => {
    const review = aggOf([
      fpRow({
        ...qualifying,
        h24: counts({ shown: 9, failed: 9, affected_users_failed: 3 }),
      }),
    ]);
    const tickets: TicketRef[] = [
      { identifier: "OCV5-170", title: `problem-card: ${qualifying.fingerprint}`, status: "backlog" },
    ];
    const state: StateFile = {
      fingerprints: {
        [qualifying.fingerprint]: {
          identifier: "OCV5-170",
          created_at: "2026-09-08",
          last_comment_date: "2026-09-08",
          last_counts: { failed: 5 },
          daily: [{ date: "2026-09-08", failed: 5 }],
        },
      },
    };
    assert.deepEqual(nextActions(review, state, tickets).actions, []);
  });

  test("seven zero-failed days suggests close once", () => {
    const quiet = fpRow({
      fingerprint: "recovery_job:upstream_failed:job_terminal:automatic_retry_exhausted",
      stage: "recovery_job",
      path: "job_terminal",
      reason: "automatic_retry_exhausted",
      h24: counts({ shown: 0, failed: 0 }),
    });
    const daily = [];
    for (let i = 6; i >= 0; i--) {
      daily.push({ date: `2026-09-0${8 - i}`, failed: 0 });
    }
    const tickets: TicketRef[] = [
      { identifier: "OCV5-99", title: `problem-card: ${quiet.fingerprint}`, status: "blocked" },
    ];
    const state: StateFile = {
      fingerprints: {
        [quiet.fingerprint]: {
          identifier: "OCV5-99",
          created_at: "2026-09-01",
          daily,
        },
      },
    };
    const { actions, nextState } = nextActions(aggOf([quiet]), state, tickets);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.kind, "suggest_close");
    if (actions[0]!.kind === "suggest_close") {
      assert.equal(actions[0].body, "建议关单：7 天无新样本");
      assert.equal(actions[0].identifier, "OCV5-99");
    }
    nextState.fingerprints[quiet.fingerprint]!.close_suggested_at = "2026-09-08";
    assert.deepEqual(nextActions(aggOf([quiet]), nextState, tickets).actions, []);
  });

  test("done/cancelled tickets are not reused; a new create is planned", () => {
    const review = aggOf([qualifying]);
    for (const status of ["done", "cancelled", "canceled"]) {
      const { actions } = nextActions(review, { fingerprints: {} }, [
        { identifier: "OCV5-1", title: `problem-card: ${qualifying.fingerprint}`, status },
      ]);
      assert.equal(actions[0]?.kind, "create", status);
    }
  });
});

describe("buildOcTaskArgs argv (no shell)", () => {
  test("title and body land as argv elements, never via sh -c", () => {
    const title = "problem-card: problem_card:x:immediate:-";
    const body = "hello; rm -rf / && echo `whoami` $(reboot) \n# not a shell";
    const args = buildOcTaskArgs("ticket-create", {
      projectId: "11111111-1111-4111-8111-111111111111",
      title,
      body,
    });
    assert.equal(args.includes("sh"), false);
    assert.equal(args.some((a) => a.includes("sh -c")), false);
    assert.equal(args[args.indexOf("--title") + 1], title);
    assert.equal(args[args.indexOf("--body") + 1], body);
    const dockerArgv = dockerExecOcTaskArgv("oc-v5-u3", args);
    assert.deepEqual(dockerArgv.slice(0, 4), ["exec", "-i", "oc-v5-u3", "/home/agent/.local/bin/oc-task"]);
    assert.equal(dockerArgv.includes("sh"), false);
    assert.equal(dockerArgv[dockerArgv.indexOf("--body") + 1], body);
  });

  test("comment identifier is positional, body is flag value", () => {
    const args = buildOcTaskArgs("ticket-comment", { identifier: "OCV5-42", body: "当日计数" });
    assert.deepEqual(args, ["ticket", "comment", "OCV5-42", "--body", "当日计数"]);
  });

  test("digest copy uses stdin cat; date whitelist rejects garbage", () => {
    const { file, argv } = dockerCopyDigestArgv("oc-v5-u3", "2026-09-08");
    assert.equal(file, "docker");
    assert.deepEqual(argv.slice(0, 4), ["exec", "-i", "oc-v5-u3", "sh"]);
    assert.equal(argv[4], "-c");
    assert.equal(argv[5], "cat > /home/agent/.openclaude/generated/problem-card-digest-2026-09-08.md");
    assert.throws(() => dockerCopyDigestArgv("oc-v5-u3", "2026-09-08;rm"), /invalid date/);
    assert.throws(() => dockerCopyDigestArgv("oc-v5-u3", "../x"), /invalid date/);
  });

  test("list/create helpers stay argv arrays", () => {
    assert.deepEqual(buildOcTaskArgs("project-list"), ["project", "list"]);
    assert.deepEqual(
      buildOcTaskArgs("ticket-list", { projectId: "abc", label: "problem-card", limit: 200 }),
      ["ticket", "list", "--project-id", "abc", "--label", "problem-card", "--limit", "200"],
    );
  });
});
