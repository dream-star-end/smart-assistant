/**
 * v5 自愈体系收尾批(M4)— redactOpsPayload 纯单元。
 *
 * 验:值级凭据清洗(sk-/Bearer/gh 令牌/Slack/AWS/URL userinfo/k=v 尾值)+
 *     key 级(redactSensitive)叠加 + 深度遍历 + 非敏感文本不误伤。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { redactOpsPayload, scrubSecretsInString } from "../selfheal/redact.js";

describe("scrubSecretsInString(值级清洗)", () => {
  test("sk- key / Bearer / gh 令牌 / Slack / AWS key 全部被替换", () => {
    const s = scrubSecretsInString(
      "用了 sk-abcd1234efgh 和 Bearer eyJx.yy_z 还有 ghp_abc123 gho_def456 xoxb-1-2-abc AKIAABCDEFGHIJKLMNOP",
    );
    assert.ok(!s.includes("sk-abcd1234efgh"));
    assert.ok(!s.includes("eyJx.yy_z"));
    assert.ok(!s.includes("ghp_abc123"));
    assert.ok(!s.includes("gho_def456"));
    assert.ok(!s.includes("xoxb-1-2-abc"));
    assert.ok(!s.includes("AKIAABCDEFGHIJKLMNOP"));
    assert.match(s, /\[redacted/);
  });

  test("URL userinfo:postgres://user:pass@host 只清凭据保留主机", () => {
    const s = scrubSecretsInString("DATABASE_URL=postgres://oc:S3cret!@10.0.0.2:5432/db");
    assert.ok(!s.includes("S3cret!"));
    assert.ok(s.includes("10.0.0.2:5432/db"), "主机/库名保留(运维定位价值)");
  });

  test("password=/secret=/token=/api_key= 尾随值被清", () => {
    const s = scrubSecretsInString("cmd --password=hunter2 secret=abc token=xyz api_key=k123");
    assert.ok(!s.includes("hunter2"));
    assert.ok(!/\btoken=xyz\b/.test(s));
    assert.ok(!s.includes("api_key=k123"));
    assert.match(s, /password=\[redacted\]/);
  });

  test("普通运维文本不误伤(短横线词/纯 hex request id 保留)", () => {
    const s = "journalctl -u openclaude-v5 显示 request 3f2a9b0c 在 sk8 页面超时";
    assert.equal(scrubSecretsInString(s), s, "sk8(<8 字符尾随)与裸 hex 不动");
  });

  test("幂等:清洗结果再清洗不变", () => {
    const once = scrubSecretsInString("Bearer abc.def sk-12345678x");
    assert.equal(scrubSecretsInString(once), once);
  });
});

describe("redactOpsPayload(key 级 + 值级叠加,深度遍历)", () => {
  test("敏感 key 整值替换(redactSensitive 语义保留)", () => {
    const out = redactOpsPayload({ api_key: "sk-longsecretvalue123", note: "ok" }) as Record<string, unknown>;
    assert.equal((out.api_key as { __redacted?: boolean }).__redacted, true);
    assert.equal(out.note, "ok");
  });

  test("非敏感 key 下的字符串值内嵌凭据被值级清洗(key 级放过的穿透面)", () => {
    const out = redactOpsPayload({
      log: "curl -H 'Authorization: Bearer eyJabc.def' https://api",
      steps: ["export OPENAI=sk-abcdefgh1234", { cmd: "psql postgres://u:pw@db:5432/x" }],
    }) as { log: string; steps: [string, { cmd: string }] };
    assert.ok(!out.log.includes("eyJabc.def"));
    assert.ok(!out.steps[0].includes("sk-abcdefgh1234"));
    assert.ok(!out.steps[1].cmd.includes(":pw@"));
  });

  test("纯字符串入参直接清洗(repairContext ops_detail 形态)", () => {
    const out = redactOpsPayload("排查时用了 sk-verylongsecret99") as string;
    assert.ok(!out.includes("sk-verylongsecret99"));
  });

  test("标量/空值原样;深度超限截断不炸栈", () => {
    assert.equal(redactOpsPayload(42), 42);
    assert.equal(redactOpsPayload(null), null);
    let deep: Record<string, unknown> = { v: "x" };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    assert.doesNotThrow(() => redactOpsPayload(deep));
  });
});
