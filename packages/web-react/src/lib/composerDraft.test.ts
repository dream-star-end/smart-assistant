import { afterEach, describe, expect, test, vi } from "vitest";
import {
  accountDraftKey,
  clearDraft,
  moveDraft,
  NEW_COMPOSER_DRAFT_KEY,
  readDraft,
  teardownComposerDrafts,
  writeDraft,
} from "./composerDraft";

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ["s1", "s2"]) clearDraft(key);
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

  test("超 20KB 不写存储但留在本标签内存，不复活旧内容", () => {
    writeDraft("s1", "old prefix");
    const tooLong = "x".repeat(20 * 1024 + 1);
    writeDraft("s1", tooLong);
    expect(sessionStorage.getItem("oc_v5_composer_draft:s1")).toBeNull();
    expect(readDraft("s1")).toBe(tooLong);
    clearDraft("s1");
    expect(readDraft("s1")).toBe("");
  });

  test("恰好 20KB 可写", () => {
    const exact = "y".repeat(20 * 1024);
    writeDraft("s1", exact);
    expect(readDraft("s1")).toBe(exact);
  });

  test("存储写满/删除失败时仍保存最新值和清空意图", () => {
    writeDraft("s1", "old");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    writeDraft("s1", "latest");
    expect(readDraft("s1")).toBe("latest");
    clearDraft("s1");
    expect(readDraft("s1")).toBe("");
  });

  test("物化新会话迁移草稿并清空来源，支持超限内存草稿", () => {
    const text = "中".repeat(8000);
    writeDraft("s1", text);
    moveDraft("s1", "s2");
    expect(readDraft("s2")).toBe(text);
    expect(readDraft("s1")).toBe("");
    moveDraft("s2", "s2");
    expect(readDraft("s2")).toBe(text);
  });

  test("accountDraftKey namespaces session keys and leaves demo keys unscoped", () => {
    expect(accountDraftKey("new", "user-a")).toBe("user-a:new");
    expect(accountDraftKey("s1", "user-a")).toBe("user-a:s1");
    expect(accountDraftKey("new", null)).toBe("new");
    expect(accountDraftKey("new", "  ")).toBe("new");
  });

  test("teardown drops this account and unscoped new, never migrates leftover new", () => {
    writeDraft(NEW_COMPOSER_DRAFT_KEY, "account-A private unsent draft");
    writeDraft(accountDraftKey(NEW_COMPOSER_DRAFT_KEY, "user-a"), "A scoped");
    writeDraft(accountDraftKey("s1", "user-a"), "A session");
    const huge = "x".repeat(20 * 1024 + 1);
    writeDraft(accountDraftKey(NEW_COMPOSER_DRAFT_KEY, "user-a"), huge);
    teardownComposerDrafts("user-a");
    expect(readDraft(NEW_COMPOSER_DRAFT_KEY)).toBe("");
    expect(readDraft(accountDraftKey(NEW_COMPOSER_DRAFT_KEY, "user-a"))).toBe("");
    expect(readDraft(accountDraftKey("s1", "user-a"))).toBe("");
    writeDraft(accountDraftKey(NEW_COMPOSER_DRAFT_KEY, "user-b"), "");
    expect(readDraft(accountDraftKey(NEW_COMPOSER_DRAFT_KEY, "user-b"))).toBe("");
    expect(readDraft(NEW_COMPOSER_DRAFT_KEY)).toBe("");
  });
});
