/**
 * T-63 — 事件目录 alertEvents.ts 的纯单元 sanity。
 *
 * 职责:锁住"事件清单"和"元数据"不被悄悄改坏。目录是前端订阅 UI /
 * 后端 enqueue / silence 的唯一真理源,退化成静默 bug 的代价高,所以
 * 每次修改目录都要跑这组测试。
 *
 * 不碰 DB / 不碰 HTTP。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENTS,
  EVENT_META,
  ALL_EVENT_TYPES,
  eventMetaFor,
  type EventMeta,
} from "../admin/alertEvents.js";

const SEVERITIES = new Set(["info", "warning", "critical"]);
const GROUPS = new Set([
  "account_pool",
  "payment",
  "container",
  "risk",
  "health",
  "security",
  "system",
]);
const TRIGGERS = new Set(["polled", "passive", "both"]);
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;

describe("alertEvents — EVENTS constants", () => {
  test("EVENTS values all match event_type regex", () => {
    for (const [k, v] of Object.entries(EVENTS)) {
      assert.ok(EVENT_TYPE_RE.test(v), `${k} has invalid event_type: ${v}`);
    }
  });

  test("EVENTS values are unique", () => {
    const vals = Object.values(EVENTS);
    assert.equal(new Set(vals).size, vals.length, "duplicate event_type in EVENTS");
  });
});

describe("alertEvents — EVENT_META", () => {
  test("covers every EVENTS value exactly once", () => {
    const metaTypes = EVENT_META.map((e) => e.event_type);
    const expected = [...Object.values(EVENTS)].sort();
    assert.deepEqual([...metaTypes].sort(), expected);
    assert.equal(new Set(metaTypes).size, metaTypes.length, "duplicate event_type in EVENT_META");
  });

  test("each row has valid shape (severity/group/trigger/description)", () => {
    for (const m of EVENT_META) {
      assert.ok(SEVERITIES.has(m.severity), `${m.event_type} invalid severity: ${m.severity}`);
      assert.ok(GROUPS.has(m.group), `${m.event_type} invalid group: ${m.group}`);
      assert.ok(TRIGGERS.has(m.trigger), `${m.event_type} invalid trigger: ${m.trigger}`);
      assert.ok(
        typeof m.description === "string" && m.description.length > 0,
        `${m.event_type} description missing`,
      );
      assert.ok(EVENT_TYPE_RE.test(m.event_type));
    }
  });

  test("ALL_EVENT_TYPES matches EVENT_META", () => {
    assert.deepEqual(
      [...ALL_EVENT_TYPES].sort(),
      [...EVENT_META.map((e) => e.event_type)].sort(),
    );
  });

  test("eventMetaFor() returns matching row or undefined", () => {
    const first: EventMeta = EVENT_META[0];
    assert.deepEqual(eventMetaFor(first.event_type), first);
    assert.equal(eventMetaFor("nope.does_not_exist"), undefined);
  });

  test("payment.callback_signature_invalid + admin_role_changed are critical", () => {
    // 两个"真出事了"类事件必须 critical,不能被悄悄降级成 warning 而让 severity_min=critical 的通道漏收
    assert.equal(
      eventMetaFor(EVENTS.PAYMENT_CALLBACK_SIGNATURE_INVALID)?.severity,
      "critical",
    );
    assert.equal(
      eventMetaFor(EVENTS.SECURITY_ADMIN_ROLE_CHANGED)?.severity,
      "critical",
    );
    assert.equal(
      eventMetaFor(EVENTS.SECURITY_ADMIN_AUDIT_WRITE_FAILED)?.severity,
      "critical",
    );
  });

  test("event_type prefix (group.xxx) 与 group 字段一致", () => {
    for (const m of EVENT_META) {
      const prefix = m.event_type.split(".")[0];
      assert.equal(prefix, m.group, `${m.event_type} prefix mismatches group ${m.group}`);
    }
  });
});
