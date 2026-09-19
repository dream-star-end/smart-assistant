import { describe, expect, it, vi } from "vitest";
import type { GoalStateSnapshot } from "@openclaude/protocol/goalState";
import { createGoalStarter } from "./goalStart";
const goal = { sessionId: "a", objective: "test objective", status: "active" } as GoalStateSnapshot;
function fixture() {
  return { isBusy: vi.fn(() => false), save: vi.fn(async () => goal), apply: vi.fn(),
    start: vi.fn(async () => {}) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
describe("goal start orchestration", () => {
  it("saves, applies, then starts the persisted objective exactly once", async () => {
    const run = createGoalStarter(), deps = fixture();
    await run("a", deps);
    expect(deps.start).toHaveBeenCalledExactlyOnceWith(goal);
    expect(deps.save.mock.invocationCallOrder[0]).toBeLessThan(deps.apply.mock.invocationCallOrder[0]!);
    expect(deps.apply.mock.invocationCallOrder[0]).toBeLessThan(deps.start.mock.invocationCallOrder[0]!);
  });
  it("coalesces concurrent submissions for one session", async () => {
    const run = createGoalStarter(), deps = fixture(), save = deferred<GoalStateSnapshot>();
    deps.save.mockImplementation(() => save.promise);
    const first = run("a", deps), second = run("a", deps);
    expect(second).toBe(first);
    save.resolve(goal); await first;
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect(deps.start).toHaveBeenCalledTimes(1);
  });
  it("does not append a prompt when a running turn ends during save", async () => {
    const deps = fixture();
    deps.isBusy.mockReturnValueOnce(true).mockReturnValue(false);
    await createGoalStarter()("a", deps);
    expect(deps.apply).toHaveBeenCalledWith(goal);
    expect(deps.start).not.toHaveBeenCalled();
  });
  it("does not append a prompt when a turn starts while saving", async () => {
    const deps = fixture();
    deps.isBusy.mockReturnValueOnce(false).mockReturnValue(true);
    await createGoalStarter()("a", deps);
    expect(deps.start).not.toHaveBeenCalled();
  });
  it.each(["paused", "blocked", "completed", "cleared"] as const)("does not start a %s goal", async (status) => {
    const deps = fixture(); deps.save.mockResolvedValue({ ...goal, status });
    await createGoalStarter()("a", deps);
    expect(deps.start).not.toHaveBeenCalled();
  });
  it("does not start after save failure and allows retry", async () => {
    const run = createGoalStarter(), deps = fixture();
    deps.save.mockRejectedValueOnce(new Error("save failed"));
    await expect(run("a", deps)).rejects.toThrow("save failed");
    expect(deps.apply).not.toHaveBeenCalled(); expect(deps.start).not.toHaveBeenCalled();
    await run("a", deps); expect(deps.start).toHaveBeenCalledTimes(1);
  });
  it("retains the saved state on start failure and releases the retry lock", async () => {
    const run = createGoalStarter(), deps = fixture();
    deps.start.mockRejectedValueOnce(new Error("offline"));
    await expect(run("a", deps)).rejects.toThrow("目标已保存，但未能启动");
    expect(deps.apply).toHaveBeenCalledWith(goal);
    await run("a", deps); expect(deps.start).toHaveBeenCalledTimes(2);
  });
  it("isolates pending operations by captured session, not later selection", async () => {
    const run = createGoalStarter(), a = fixture(), b = fixture(), save = deferred<GoalStateSnapshot>();
    a.save.mockImplementation(() => save.promise);
    const first = run("a", a); await run("b", b);
    expect(a.start).not.toHaveBeenCalled(); expect(b.start).toHaveBeenCalledTimes(1);
    save.resolve(goal); await first; expect(a.start).toHaveBeenCalledExactlyOnceWith(goal);
  });
});
