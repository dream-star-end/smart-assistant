import { afterEach, expect, test, vi } from "vitest";
import { api } from "./api";
import { createMemoryAuthSession } from "./authSession";

afterEach(() => {
  vi.unstubAllGlobals();
});

function ok(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

function session() {
  return createMemoryAuthSession(() => {}, "tok");
}

test("submitTutorialSnapshot posts session payload to /api/tutorials/snapshots", async () => {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    ok({
      tutorial: { id: "t1", status: "pending", createdAt: "2026-08-20T00:00:00.000Z" },
      leakReport: { strippedRoles: ["system"] },
    }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const result = await api.submitTutorialSnapshot(session(), {
    sourceSessionId: "s1",
    title: "快照",
    summary: "从当前会话生成完整交互快照。",
    category: "general",
    bodyMarkdown: "## 说明\n这是作者补充。",
    selectedArtifacts: [],
  });
  const firstCall = fetchMock.mock.calls[0];
  expect(String(firstCall?.[0])).toBe("/api/tutorials/snapshots");
  expect(firstCall?.[1]?.method).toBe("POST");
  expect(JSON.parse(String(firstCall?.[1]?.body))).toEqual(
    expect.objectContaining({ sourceSessionId: "s1", selectedArtifacts: [] }),
  );
  expect(JSON.parse(String(firstCall?.[1]?.body))).not.toHaveProperty("messages");
  expect(result.tutorial.id).toBe("t1");
  expect(result.tutorial.kind).toBe("snapshot");
  expect(result.leakReport?.strippedRoles).toEqual(["system"]);
});

test("admin tutorial evals specs/jobs/compass/record use /api/admin/tutorials prefix", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/case-specs") && init?.method === "POST") {
      return ok({
        spec: {
          id: "spec-1",
          publicId: "ext-1",
          title: "外部案例",
          sourcePlatform: "external",
          sourceUrl: "https://example.test/case",
          collectedAt: "2026-08-20T00:00:00.000Z",
          frozenPrompt: "do the task with public materials only",
          authScope: "synthetic_eval",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      });
    }
    if (String(url).includes("/eval-jobs") && init?.method === "POST") {
      return ok({
        job: {
          id: "job-1",
          specId: "spec-1",
          status: "queued",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      });
    }
    if (String(url).includes("/compass")) return ok({ notes: [], nextCursor: null });
    if (String(url).includes("/evidence")) return ok({ ok: true });
    if (String(url).includes("/eval-jobs")) return ok({ jobs: [], nextCursor: null });
    return ok({ specs: [], nextCursor: null });
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  const a = session();
  await api.listTutorialEvalSpecs(a);
  await api.createTutorialEvalSpec(a, {
    publicId: "ext-1",
    title: "外部案例登记标题足够长",
    sourcePlatform: "external",
    sourceUrl: "https://example.test/case",
    collectedAt: "2026-08-20T00:00:00.000Z",
    frozenPrompt: "do the task with public materials only",
    frozenMaterials: { items: [{ name: "public.zip" }] },
    rubric: { pass: true },
  });
  await api.listTutorialEvalJobs(a);
  await api.enqueueTutorialEvalJob(a, "spec-1");
  await api.listTutorialEvalCompass(a);
  await api.recordTutorialEvalResult(a, { jobId: "job-1", result: "failed" });
  const urls = fetchMock.mock.calls.map((call) => String(call[0]));
  expect(urls).toEqual([
    "/api/admin/tutorials/case-specs",
    "/api/admin/tutorials/case-specs",
    "/api/admin/tutorials/eval-jobs",
    "/api/admin/tutorials/eval-jobs",
    "/api/admin/tutorials/compass",
    "/api/admin/tutorials/eval-jobs/job-1/evidence",
  ]);
});
