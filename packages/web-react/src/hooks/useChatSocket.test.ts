import { describe, expect, test } from "vitest";
import { isArchiveHistoryRevisionCompatible } from "./useChatSocket";

describe("archive history revision compatibility", () => {
  test("a revision-aware session accepts only the exact canonical page revision", () => {
    expect(isArchiveHistoryRevisionCompatible(3, 3)).toBe(true);
    for (const pageRevision of [undefined, -1, 2, 4, 1.5, Number.NaN]) {
      expect(isArchiveHistoryRevisionCompatible(3, pageRevision)).toBe(false);
    }
  });

  test("a rolling legacy session without a revision can still load legacy archive pages", () => {
    expect(isArchiveHistoryRevisionCompatible(undefined, undefined)).toBe(true);
    expect(isArchiveHistoryRevisionCompatible(undefined, 0)).toBe(true);
  });
});
