import { describe, expect, test } from "vitest";
import { sanitizeChatMessages } from "./sanitizeChatMessages";

describe("sanitizeChatMessages", () => {
  test("missing id becomes a stable placeholder and neighbors stay intact", () => {
    const out = sanitizeChatMessages([
      { id: "ok-1", role: "user", text: "before", ts: 1 },
      { role: "assistant", text: "broken", ts: 2 },
      { id: "ok-2", role: "assistant", text: "after", ts: 3 },
    ], "sess-1");
    expect(out).toHaveLength(3);
    expect(out[0]?.id).toBe("ok-1");
    expect(out[0]?.text).toBe("before");
    expect(out[1]?.id).toMatch(/^corrupt:sess-1:/);
    expect(out[1]?.role).toBe("system");
    expect(out[1]?._corruptPlaceholder).toBe(true);
    expect(out[2]?.id).toBe("ok-2");
    expect(out[2]?.text).toBe("after");
  });

  test("deep-malformed plan steps:[null] becomes a placeholder and neighbors stay intact", () => {
    const out = sanitizeChatMessages([
      { id: "ok-1", role: "user", text: "before", ts: 1 },
      { id: "plan-bad", role: "plan", text: "计划", ts: 2, steps: [null] },
      { id: "ok-2", role: "assistant", text: "after", ts: 3 },
    ], "sess-deep");
    expect(out).toHaveLength(3);
    expect(out[0]?.id).toBe("ok-1");
    expect(out[1]?.role).toBe("system");
    expect(out[1]?._corruptPlaceholder).toBe(true);
    expect(out[1]?.text).toContain("数据结构异常");
    expect(out[2]?.id).toBe("ok-2");
    expect(out[2]?.text).toBe("after");
  });
});
