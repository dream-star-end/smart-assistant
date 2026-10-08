import { describe, expect, it, vi } from "vitest";
import { fenceAndDeleteProject, restoreDeletedProject, setProjectArchivedFenced, type LifecycleDeps } from "./projectLifecycle";

function deps(over: Partial<LifecycleDeps> = {}) {
  const log: string[] = [];
  const d: LifecycleDeps = {
    listCron: vi.fn(async () => [{ id: "j-on", enabled: true }, { id: "j-off", enabled: false }, { id: "j-on2" }]),
    setCronEnabled: vi.fn(async (id, on) => void log.push(`cron ${id} ${on ? "on" : "off"}`)),
    setBoardArchived: vi.fn(async (_b, a) => void log.push(`board ${a ? "archive" : "open"}`)),
    isBoardArchived: vi.fn(async () => false),
    setProjectArchived: vi.fn(async (_p, a) => void log.push(`project ${a ? "archive" : "show"}`)),
    deleteProject: vi.fn(async (_p, paused) => void log.push(`delete ${paused.join(",")}`)),
    restoreProject: vi.fn(async () => ({ boardProjectId: "b1", pausedCronJobIds: ["j-on", "j-on2"], archived: false })),
    ...over,
  };
  return { d, log };
}

describe("project lifecycle", () => {
  it("delete pauses the enabled jobs and archives the board before deleting, and records what it paused", async () => {
    const { d, log } = deps();
    await fenceAndDeleteProject(d, { id: "p1", boardProjectId: "b1" });
    expect(log).toEqual(["cron j-on off", "cron j-on2 off", "board archive", "delete j-on,j-on2"]);
  });

  it("a failed delete puts everything back", async () => {
    const { d, log } = deps({ deleteProject: vi.fn(async () => { throw new Error("500"); }) });
    await expect(fenceAndDeleteProject(d, { id: "p1", boardProjectId: "b1" })).rejects.toThrow("500");
    expect(log).toEqual(["cron j-on off", "cron j-on2 off", "board archive", "board open", "cron j-on on", "cron j-on2 on"]);
  });

  it("if pausing fails halfway, the jobs already paused are resumed and nothing is deleted", async () => {
    let n = 0;
    const { d, log } = deps({
      setCronEnabled: vi.fn(async (id, on) => {
        if (!on && ++n === 2) throw new Error("container away");
        log.push(`cron ${id} ${on ? "on" : "off"}`);
      }),
    });
    await expect(fenceAndDeleteProject(d, { id: "p1", boardProjectId: "b1" })).rejects.toThrow("container away");
    expect(d.deleteProject).not.toHaveBeenCalled();
    expect(log).toEqual(["cron j-on off", "cron j-on on"]);
  });

  it("a project without a board just deletes", async () => {
    const { d, log } = deps();
    await fenceAndDeleteProject(d, { id: "p1", boardProjectId: null });
    expect(log).toEqual(["delete "]);
  });

  it("restore reopens the board and re-enables exactly the paused jobs", async () => {
    const { d, log } = deps();
    const r = await restoreDeletedProject(d, "p1");
    expect(log).toEqual(["board open", "cron j-on on", "cron j-on2 on"]);
    expect(r.cronNotResumed).toEqual([]);
  });

  it("archive fences the board first; unarchive shows the project first", async () => {
    const a = deps();
    await setProjectArchivedFenced(a.d, { id: "p1", boardProjectId: "b1" }, true);
    expect(a.log).toEqual(["board archive", "project archive"]);
    const b = deps();
    await setProjectArchivedFenced(b.d, { id: "p1", boardProjectId: "b1" }, false);
    expect(b.log).toEqual(["project show", "board open"]);
  });

  it("a board that was already archived is not reopened by a failed delete", async () => {
    const { d, log } = deps({
      isBoardArchived: vi.fn(async () => true),
      deleteProject: vi.fn(async () => { throw new Error("500"); }),
    });
    await expect(fenceAndDeleteProject(d, { id: "p1", boardProjectId: "b1" })).rejects.toThrow("500");
    expect(log).toEqual(["cron j-on off", "cron j-on2 off", "cron j-on on", "cron j-on2 on"]);
  });

  it("a project archived before deletion is restored archived, board left archived", async () => {
    const { d, log } = deps({
      restoreProject: vi.fn(async () => ({ boardProjectId: "b1", pausedCronJobIds: [], archived: true })),
    });
    await restoreDeletedProject(d, "p1");
    expect(log).toEqual([]);
  });
});
