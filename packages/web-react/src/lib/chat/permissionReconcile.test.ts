import { describe, expect, test } from "vitest";
import type { PermissionPromptSnapshotPayload } from "../types";
import { reconcilePermissionSnapshot } from "./permissionReconcile";

const pending = (id: string, updatedAt = 100): PermissionPromptSnapshotPayload["items"][number] => ({
  requestId: id,
  clientMessageId: "m-1",
  toolUseId: id,
  toolName: "AskUserQuestion",
  inputJson: { questions: [] },
  status: "pending",
  behavior: null,
  reason: null,
  answers: null,
  expiresAt: 9_999_999,
  createdAt: 50,
  updatedAt,
});

const settled = (
  id: string,
  status: "responded" | "cancelled" | "expired",
  behavior: "allow" | "deny" | null = null,
): PermissionPromptSnapshotPayload["items"][number] => ({
  ...pending(id, 200),
  status,
  behavior,
  reason: status === "responded" ? "tab-a" : "user_stop",
});

describe("reconcilePermissionSnapshot", () => {
  test("materialises server pending that the local timeline is missing", () => {
    const plan = reconcilePermissionSnapshot({
      localCards: [],
      snapshot: { items: [pending("r1")], completeness: "complete", source: "pg" },
    });
    expect(plan.materialize.map((i) => i.requestId)).toEqual(["r1"]);
    expect(plan.settle).toEqual([]);
  });

  test("settles local unresolved cards from server terminal rows; responded is acceptance", () => {
    const plan = reconcilePermissionSnapshot({
      localCards: [{ requestId: "r1", resolved: false }],
      snapshot: { items: [settled("r1", "responded", "allow")], completeness: "complete", source: "pg" },
    });
    expect(plan.materialize).toEqual([]);
    expect(plan.settle).toEqual([
      { requestId: "r1", behavior: "allow", reason: "tab-a", answers: null, status: "responded" },
    ]);
  });

  test("does not resurrect a newer local settlement from an older pending snapshot", () => {
    const plan = reconcilePermissionSnapshot({
      localCards: [{ requestId: "r1", resolved: true, updatedAt: 500, behavior: "allow" }],
      snapshot: { items: [pending("r1", 100)], completeness: "complete", source: "pg" },
    });
    expect(plan.materialize).toEqual([]);
    expect(plan.settle).toEqual([]);
  });

  test("absence is not expiry; complete pages still emit exact lookup for local pending cards", () => {
    const plan = reconcilePermissionSnapshot({
      localCards: [{ requestId: "old", resolved: false }],
      snapshot: { items: [pending("new")], completeness: "complete", source: "pg" },
    });
    expect(plan.settle).toEqual([]);
    expect(plan.lookupRequestIds).toEqual(["old"]);
  });

  test("truncated pages emit lookup ids for local pending cards outside the window", () => {
    const plan = reconcilePermissionSnapshot({
      localCards: [
        { requestId: "in-page", resolved: false },
        { requestId: "old-card", resolved: false },
      ],
      snapshot: {
        items: [pending("in-page")],
        completeness: "truncated",
        source: "pg",
      },
    });
    expect(plan.lookupRequestIds).toEqual(["old-card"]);
  });

  test("existing truncated pending is re-applied when lookup returns full input", () => {
    const plan = reconcilePermissionSnapshot({
      localCards: [{ requestId: "r1", resolved: false }],
      snapshot: {
        items: [{ ...pending("r1"), inputTruncated: false, inputJson: { questions: [{ question: "完整题" }] } }],
        completeness: "complete",
        source: "pg",
      },
    });
    expect(plan.materialize).toHaveLength(1);
    expect(plan.materialize[0]?.inputJson).toEqual({ questions: [{ question: "完整题" }] });
  });

  test("responded without behavior does not infer allow", () => {
    const plan = reconcilePermissionSnapshot({
      localCards: [{ requestId: "r1", resolved: false }],
      snapshot: {
        items: [{
          requestId: "r1",
          clientMessageId: "m-1",
          toolUseId: "r1",
          toolName: "Bash",
          inputJson: {},
          status: "responded",
          behavior: null,
          reason: null,
          answers: null,
          expiresAt: 9,
          createdAt: 1,
          updatedAt: 2,
        }],
        completeness: "complete",
        source: "pg",
      },
    });
    expect(plan.settle[0]?.behavior).toBeNull();
  });

  test("unavailable pages never auto-settle from absence", () => {
    const plan = reconcilePermissionSnapshot({
      localCards: [{ requestId: "ghost", resolved: false }],
      snapshot: { items: [], completeness: "unavailable", source: "runtime" },
    });
    expect(plan.settle).toEqual([]);
    expect(plan.lookupRequestIds).toEqual([]);
  });

  test("lookups merge into the same id map", () => {
    const plan = reconcilePermissionSnapshot({
      localCards: [{ requestId: "old", resolved: false }],
      snapshot: {
        items: [],
        completeness: "truncated",
        source: "pg",
        lookups: [settled("old", "cancelled", "deny")],
      },
    });
    expect(plan.settle[0]?.status).toBe("cancelled");
    expect(plan.lookupRequestIds).toEqual([]);
  });
});
