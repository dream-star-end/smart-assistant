import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./model";
import { returnStrayRowsToOwnerTurn } from "./order";

const MIN = 60_000;
const T0 = 1_790_900_000_000;
function m(id: string, role: ChatMessage["role"], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text: id, ts: T0, _source: "server", ...extra } as ChatMessage;
}
const ids = (rows: ChatMessage[]) => rows.map((row) => row.id);

describe("returnStrayRowsToOwnerTurn (OCV5-313)", () => {
  test("an earlier turn's tape rows left under the newest user go back to the end of their own turn", () => {
    const rows = [
      m("u1", "user", { ts: T0 }),
      m("a1-mid", "assistant", { _clientMessageId: "u1", ts: T0 + 1 * MIN }),
      m("u2", "user", { ts: T0 + 60 * MIN }),
      m("a2-mid", "assistant", { _clientMessageId: "u2", ts: T0 + 61 * MIN }),
      m("t1-late", "tool", { _clientMessageId: "u1", ts: T0 + 20 * MIN }),
      m("a1-final", "assistant", { _clientMessageId: "u1", ts: T0 + 30 * MIN }),
      m("t2", "tool", { _clientMessageId: "u2", ts: T0 + 62 * MIN }),
    ];
    expect(ids(returnStrayRowsToOwnerTurn(rows))).toEqual([
      "u1", "a1-mid", "t1-late", "a1-final", "u2", "a2-mid", "t2",
    ]);
  });

  test("owner-less answered question cards go to the turn they were answered in (by ts)", () => {
    const rows = [
      m("u1", "user", { ts: T0 }),
      m("a1", "assistant", { _clientMessageId: "u1", ts: T0 + 5 * MIN }),
      m("u2", "user", { ts: T0 + 600 * MIN }),
      m("a2", "assistant", { _clientMessageId: "u2", ts: T0 + 640 * MIN }),
      m("q-old", "permission", { _resolved: true, _source: "local", ts: T0 + 2 * MIN }),
      m("u3", "user", { ts: T0 + 700 * MIN }),
    ];
    expect(ids(returnStrayRowsToOwnerTurn(rows))).toEqual(["u1", "a1", "q-old", "u2", "a2", "u3"]);
  });

  test("an explicit owner always wins over ts (different clocks); a live-stamped card returns to its owner", () => {
    const skewed = [
      m("u1", "user", { ts: T0 }),
      m("u2", "user", { ts: T0 + 600 * MIN }),
      m("q", "permission", { _resolved: true, _source: "server", _turnOwnerId: "u2", ts: T0 + 3 * MIN }),
    ];
    expect(returnStrayRowsToOwnerTurn(skewed)).toBe(skewed);
    const stamped = [
      m("u1", "user", { ts: T0 }),
      m("a1", "assistant", { _clientMessageId: "u1" }),
      m("u2", "user", { ts: T0 + 600 * MIN }),
      m("a2", "assistant", { _clientMessageId: "u2" }),
      m("q", "permission", { _resolved: true, _source: "local", _turnOwnerId: "u1", ts: T0 + 3 * MIN }),
    ];
    expect(ids(returnStrayRowsToOwnerTurn(stamped))).toEqual(["u1", "a1", "q", "u2", "a2"]);
  });

  test("owner-less ts fallback does not assume user ts are monotonic in array order", () => {
    const rows = [
      m("u1", "user", { ts: T0 + 100 * MIN }),
      m("u2", "user", { ts: T0 }),
      m("u3", "user", { ts: T0 + 900 * MIN }),
      m("q", "permission", { _resolved: true, _source: "local", ts: T0 + 120 * MIN }),
    ];
    expect(ids(returnStrayRowsToOwnerTurn(rows))).toEqual(["u1", "q", "u2", "u3"]);
  });

  test("leaves the current turn, absent owners, open prompts, near-ts cards and clean input alone", () => {
    const clean = [
      m("u1", "user", { ts: T0 }),
      m("a1", "assistant", { _clientMessageId: "u1" }),
      m("u2", "user", { ts: T0 + 60 * MIN }),
      m("t2", "tool", { _clientMessageId: "u2" }),
      m("paged", "tool", { _clientMessageId: "u-paged-out" }),
      m("recovery", "tool", { _clientMessageId: "rec-hidden" }),
      m("open", "permission", { _resolved: false, _source: "local", ts: T0 }),
      m("fresh-q", "permission", { _resolved: true, _source: "local", ts: T0 + 60 * MIN - 30_000 }),
      m("noowner", "tool"),
    ];
    expect(returnStrayRowsToOwnerTurn(clean)).toBe(clean);
  });

  test("is idempotent", () => {
    const rows = [
      m("u1", "user", { ts: T0 }),
      m("u2", "user", { ts: T0 + 60 * MIN }),
      m("x", "tool", { _clientMessageId: "u1" }),
    ];
    const once = returnStrayRowsToOwnerTurn(rows);
    expect(returnStrayRowsToOwnerTurn(once)).toBe(once);
  });
});
