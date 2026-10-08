import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, AuthEpochStaleError, api } from "./api";
import { createMemoryAuthSession } from "./authSession";
import {
  MEMORY_CONTENT_MAX,
  asciiSlug,
  firstLine,
  memorySlugFor,
  saveMessageAsProjectMemory,
  saveMessageAsProjectSkill,
  skillNameFor,
  trimForMemory,
  validateMemorySlug,
  validateSkillName,
  type SaveGuard,
} from "./projectSave";
import { taskboardApi } from "./taskboard";

afterEach(() => {
  vi.restoreAllMocks();
});

const BOARD = "11111111-2222-4333-8444-555555555555";

function guard(over: Partial<SaveGuard> = {}): SaveGuard & { order: string[] } {
  const order: string[] = [];
  return {
    auth: createMemoryAuthSession(() => {}, "tok"),
    boardProjectId: BOARD,
    prepareBoard: vi.fn(async () => {
      order.push("prepare");
      return true;
    }),
    identityChanged: () => false,
    order,
    ...over,
  };
}

const notFound = () => new ApiError({ status: 404, message: "skill not found" });
const conflict = () => new ApiError({ status: 409, message: "version_conflict" });

describe("drafts", () => {
  test("firstLine strips markdown and caps length", () => {
    expect(firstLine("\n\n## **Weekly** report\nbody")).toBe("Weekly report");
    expect(firstLine("- 第一条\n- 第二条")).toBe("第一条");
    expect(firstLine("x".repeat(80), 10)).toBe(`${"x".repeat(10)}…`);
    expect(firstLine("   \n")).toBe("");
  });

  test("memory slug: ascii words of the first line + date + suffix; Chinese falls back to note", () => {
    const now = new Date(2026, 9, 9, 12);
    expect(memorySlugFor("# Release checklist v2\n…", now, () => 0)).toBe("release-checklist-v2-20261009-0000");
    const zh = memorySlugFor("项目约定：周五发版", now, () => 0.5);
    expect(zh).toMatch(/^note-20261009-[0-9a-z]{4}$/);
    expect(validateMemorySlug(zh)).toBeNull();
    expect(validateMemorySlug(memorySlugFor("A".repeat(300), now))).toBeNull();
    expect(validateMemorySlug("")).not.toBeNull();
    expect(validateMemorySlug("中文")).not.toBeNull();
    expect(validateMemorySlug("-x")).not.toBeNull();
    expect(validateMemorySlug("project")).not.toBeNull();
  });

  test("memory content is trimmed to the cap", () => {
    expect(trimForMemory("  hi  ")).toBe("hi");
    const long = trimForMemory("y".repeat(MEMORY_CONTENT_MAX + 50));
    expect(long.length).toBeLessThanOrEqual(MEMORY_CONTENT_MAX + 2);
    expect(long.endsWith("…")).toBe(true);
  });

  test("skill name follows the skills API rule", () => {
    expect(asciiSlug("Hello, World!!", 64)).toBe("hello-world");
    expect(skillNameFor("Deploy Checklist (prod)")).toBe("deploy-checklist-prod");
    expect(skillNameFor("发版检查", new Date(2026, 0, 2))).toBe("project-skill-20260102");
    expect(validateSkillName("weekly-report")).toBeNull();
    expect(validateSkillName("Weekly")).not.toBeNull();
    expect(validateSkillName("-x")).not.toBeNull();
    expect(validateSkillName("a".repeat(65))).not.toBeNull();
    expect(validateSkillName("")).not.toBeNull();
  });
});

describe("saveMessageAsProjectMemory", () => {
  test("prepares the board first, then creates the memory with sourceSession", async () => {
    const g = guard();
    const create = vi.spyOn(taskboardApi, "createProjectMemory").mockImplementation(async () => {
      g.order.push("create");
      return { ok: true, candidate: {} as never };
    });
    const out = await saveMessageAsProjectMemory(g, { slug: "release-notes", content: "body", sessionId: "s-1" });
    expect(out).toEqual({ kind: "saved" });
    expect(g.order).toEqual(["prepare", "create"]);
    expect(create).toHaveBeenCalledWith(g.auth, BOARD, {
      slug: "release-notes.md",
      content: "body",
      sourceSession: "s-1",
    });
  });

  test("board not ready → nothing is written", async () => {
    const g = guard({ prepareBoard: vi.fn(async () => false) });
    const create = vi.spyOn(taskboardApi, "createProjectMemory");
    expect(await saveMessageAsProjectMemory(g, { slug: "a", content: "b" })).toEqual({ kind: "board_unavailable" });
    expect(create).not.toHaveBeenCalled();
  });

  test("identity switch while preparing the board stops before writing", async () => {
    let changed = false;
    const g = guard({
      prepareBoard: vi.fn(async () => {
        changed = true;
        return true;
      }),
      identityChanged: () => changed,
    });
    const create = vi.spyOn(taskboardApi, "createProjectMemory");
    expect(await saveMessageAsProjectMemory(g, { slug: "a", content: "b" })).toEqual({ kind: "aborted" });
    expect(create).not.toHaveBeenCalled();
  });

  test("a stale-identity response reads as aborted, other errors surface", async () => {
    vi.spyOn(taskboardApi, "createProjectMemory").mockRejectedValueOnce(new AuthEpochStaleError());
    expect(await saveMessageAsProjectMemory(guard(), { slug: "a", content: "b" })).toEqual({ kind: "aborted" });
    vi.spyOn(taskboardApi, "createProjectMemory").mockRejectedValueOnce(
      new ApiError({ status: 400, message: "invalid" }),
    );
    await expect(saveMessageAsProjectMemory(guard(), { slug: "a", content: "b" })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("saveMessageAsProjectSkill", () => {
  const input = { name: "weekly-report", description: "写周报时用", body: "步骤…" };

  test("creates the user skill, then adds it to the project overlay", async () => {
    const g = guard();
    const update = vi.spyOn(api, "createSkill").mockResolvedValue({ ok: true });
    vi.spyOn(taskboardApi, "getProjectContext").mockResolvedValue({ version: 3, skillOverlay: ["existing"] });
    const put = vi.spyOn(taskboardApi, "putProjectContext").mockResolvedValue({
      ok: true,
      context: { version: 4, instructions: null },
    });
    expect(await saveMessageAsProjectSkill(g, input)).toEqual({ kind: "saved" });
    expect(g.prepareBoard).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(g.auth, "weekly-report", { description: "写周报时用", body: "步骤…" });
    expect(put).toHaveBeenCalledWith(g.auth, BOARD, { expectedVersion: 3, skillNames: ["existing", "weekly-report"] });
  });

  test("a 409 version conflict re-reads the context and retries once", async () => {
    vi.spyOn(api, "createSkill").mockResolvedValue({ ok: true });
    const getCtx = vi
      .spyOn(taskboardApi, "getProjectContext")
      .mockResolvedValueOnce({ version: 3, skillOverlay: [] })
      .mockResolvedValueOnce({ version: 5, skillOverlay: ["added-elsewhere"] });
    const put = vi
      .spyOn(taskboardApi, "putProjectContext")
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce({ ok: true, context: { version: 6, instructions: null } });
    expect(await saveMessageAsProjectSkill(guard(), input)).toEqual({ kind: "saved" });
    expect(getCtx).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(expect.anything(), BOARD, {
      expectedVersion: 5,
      skillNames: ["added-elsewhere", "weekly-report"],
    });
  });

  test("a second 409 gives up with overlay_conflict (the skill itself is saved)", async () => {
    const update = vi.spyOn(api, "createSkill").mockResolvedValue({ ok: true });
    vi.spyOn(taskboardApi, "getProjectContext").mockResolvedValue({ version: 1, skillOverlay: [] });
    const put = vi.spyOn(taskboardApi, "putProjectContext").mockRejectedValue(conflict());
    expect(await saveMessageAsProjectSkill(guard(), input)).toEqual({ kind: "overlay_conflict" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(2);
  });

  test("an existing skill with that name is never overwritten: the server refuses the create (412)", async () => {
    const create = vi
      .spyOn(api, "createSkill")
      .mockRejectedValue(new ApiError({ status: 412, message: "skill already exists" }));
    const put = vi.spyOn(taskboardApi, "putProjectContext");
    expect(await saveMessageAsProjectSkill(guard(), input)).toEqual({ kind: "name_taken" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  test("already in the overlay → done without a write", async () => {
    vi.spyOn(api, "createSkill").mockResolvedValue({ ok: true });
    vi.spyOn(taskboardApi, "getProjectContext").mockResolvedValue({ version: 2, skillOverlay: ["weekly-report"] });
    const put = vi.spyOn(taskboardApi, "putProjectContext");
    expect(await saveMessageAsProjectSkill(guard(), input)).toEqual({ kind: "saved" });
    expect(put).not.toHaveBeenCalled();
  });

  test("identity switch after the skill is created stops before touching the project", async () => {
    let changed = false;
    vi.spyOn(api, "createSkill").mockImplementation(async () => {
      changed = true;
      return { ok: true };
    });
    const getCtx = vi.spyOn(taskboardApi, "getProjectContext");
    const put = vi.spyOn(taskboardApi, "putProjectContext");
    expect(await saveMessageAsProjectSkill(guard({ identityChanged: () => changed }), input)).toEqual({
      kind: "aborted",
    });
    expect(getCtx).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  test("identity switch before anything → nothing is read or written", async () => {
    const g = guard({ identityChanged: () => true });
    const getSkill = vi.spyOn(api, "createSkill");
    expect(await saveMessageAsProjectSkill(g, input)).toEqual({ kind: "aborted" });
    expect(g.prepareBoard).not.toHaveBeenCalled();
    expect(getSkill).not.toHaveBeenCalled();
  });
});
