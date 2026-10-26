import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";

const putCollaborationConfig = vi.fn();
const getCollaborationConfig = vi.fn();

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    api: {
      ...actual.api,
      putCollaborationConfig: (...args: unknown[]) => putCollaborationConfig(...args),
      getCollaborationConfig: (...args: unknown[]) => getCollaborationConfig(...args),
    },
  };
});

const { saveInitialCollaboration } = await import("./collaborationSend");

const auth = {
  snapshot: () => ({ epoch: 1 }),
} as Parameters<typeof saveInitialCollaboration>[0];

const state = {
  rev: 3,
  mode: "team" as const,
  advisorModel: null,
  configVersion: "",
  source: "default" as const,
  advisorModels: [],
  advisorCatalogResolved: true,
  advisorConsultParents: [],
  parentEngine: "gpt",
};

const savedDoc = {
  rev: 5,
  defaultMode: "team",
  defaultAdvisorModel: "gpt-6-astra",
  session: {
    mode: "team",
    advisorModel: null,
    configVersion: "v1:team",
    source: "session",
  },
  advisorModels: [],
};

describe("saveInitialCollaboration", () => {
  beforeEach(() => {
    putCollaborationConfig.mockReset();
    getCollaborationConfig.mockReset();
  });

  it("returns the doc on first PUT success", async () => {
    putCollaborationConfig.mockResolvedValueOnce(savedDoc);
    const doc = await saveInitialCollaboration(auth, "sess-1", state, false, 1);
    expect(doc).toEqual(savedDoc);
    expect(putCollaborationConfig).toHaveBeenCalledTimes(1);
    expect(putCollaborationConfig.mock.calls[0]![1].expectedRev).toBe(3);
    expect(getCollaborationConfig).not.toHaveBeenCalled();
  });

  it("on 409 CAS: GET fresh rev and retry PUT once", async () => {
    putCollaborationConfig
      .mockRejectedValueOnce(new ApiError({ status: 409, message: "CAS", code: "CAS_CONFLICT" }))
      .mockResolvedValueOnce({ ...savedDoc, rev: 14 });
    getCollaborationConfig.mockResolvedValueOnce({
      rev: 13,
      defaultMode: "team",
      defaultAdvisorModel: "gpt-6-astra",
      session: { mode: "team", advisorModel: null, configVersion: "", source: "default" },
      advisorModels: [],
    });
    const doc = await saveInitialCollaboration(auth, "sess-new", state, false, 1);
    expect(doc?.rev).toBe(14);
    expect(getCollaborationConfig).toHaveBeenCalledTimes(1);
    expect(putCollaborationConfig).toHaveBeenCalledTimes(2);
    expect(putCollaborationConfig.mock.calls[1]![1].expectedRev).toBe(13);
    expect(putCollaborationConfig.mock.calls[1]![1].sessionId).toBe("sess-new");
    expect(putCollaborationConfig.mock.calls[1]![1].mode).toBe("team");
  });

  it("rethrows non-409 errors without retry", async () => {
    putCollaborationConfig.mockRejectedValueOnce(
      new ApiError({ status: 500, message: "boom" }),
    );
    await expect(saveInitialCollaboration(auth, "sess-1", state, false, 1)).rejects.toMatchObject({
      status: 500,
    });
    expect(getCollaborationConfig).not.toHaveBeenCalled();
  });

  it("returns null when identity epoch drifts mid-retry", async () => {
    let epoch = 1;
    const drifting = { snapshot: () => ({ epoch }) } as typeof auth;
    putCollaborationConfig.mockRejectedValueOnce(
      new ApiError({ status: 409, message: "CAS" }),
    );
    getCollaborationConfig.mockImplementation(async () => {
      epoch = 2;
      return { rev: 9, defaultMode: "team", defaultAdvisorModel: null, session: { mode: "team", advisorModel: null, configVersion: "", source: "default" }, advisorModels: [] };
    });
    const doc = await saveInitialCollaboration(drifting, "sess-1", state, false, 1);
    expect(doc).toBeNull();
    expect(putCollaborationConfig).toHaveBeenCalledTimes(1);
  });
});
