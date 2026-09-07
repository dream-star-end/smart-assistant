import { afterEach, describe, expect, test } from "vitest";
import { clearDraft, readDraft, writeDraft } from "./composerDraft";

afterEach(() => {
  sessionStorage.clear();
});

describe("composerDraft", () => {
  test("读写后可还原", () => {
    writeDraft("s1", "hello draft");
    expect(readDraft("s1")).toBe("hello draft");
  });

  test("clearDraft 清掉对应键", () => {
    writeDraft("s1", "keep me");
    writeDraft("s2", "gone");
    clearDraft("s2");
    expect(readDraft("s1")).toBe("keep me");
    expect(readDraft("s2")).toBe("");
  });

  test("超 20KB 不写", () => {
    const tooLong = "x".repeat(20 * 1024 + 1);
    writeDraft("s1", tooLong);
    expect(readDraft("s1")).toBe("");
  });

  test("恰好 20KB 可写", () => {
    const exact = "y".repeat(20 * 1024);
    writeDraft("s1", exact);
    expect(readDraft("s1")).toBe(exact);
  });
});
