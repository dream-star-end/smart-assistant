import { describe, expect, it } from "vitest";
import {
  collaborationPutBody,
  docToUiState,
  isStaleCollabEpoch,
  recommendedAdvisorModel,
  sendCollabFields,
  type CollaborationConfigDoc,
} from "./collaborationConfig";

const DOC: CollaborationConfigDoc = {
  rev: 4,
  defaultMode: "solo",
  defaultAdvisorModel: "gpt-6-astra",
  session: {
    mode: "advisor",
    advisorModel: "gpt-6-astra",
    configVersion: "v1:advisor:gpt-6-astra",
    source: "session",
  },
  advisorModels: [
    { id: "gpt-6-astra", label: "GPT-6-Astra", engine: "codex" },
  ],
};

describe("sendCollabFields", () => {
  it("non-main always solo even if UI is advisor", () => {
    expect(
      sendCollabFields({
        agentId: "coding-assistant",
        mode: "advisor",
        advisorModel: "gpt-6-astra",
        configVersion: "v1:advisor:gpt-6-astra",
      }),
    ).toEqual({ teamMode: false, collabMode: "solo" });
  });

  it("advisor send uses server configVersion, never a handwritten constant", () => {
    const sent = sendCollabFields({
      agentId: "main",
      mode: "advisor",
      advisorModel: DOC.session.advisorModel,
      configVersion: DOC.session.configVersion,
    });
    expect(sent.collabMode).toBe("advisor");
    expect(sent.advisorModel).toBe("gpt-6-astra");
    expect(sent.collabConfigVersion).toBe("v1:advisor:gpt-6-astra");
    expect(sent.teamMode).toBe(false);
    expect(sent.blockedReason).toBeUndefined();
  });

  it("blocks advisor send when catalog has no proven engine", () => {
    const sent = sendCollabFields({
      agentId: "main",
      mode: "advisor",
      advisorModel: "gpt-6-astra",
      configVersion: "v1:advisor:gpt-6-astra",
      advisorUnavailableReason: "顾问引擎尚未证明无工具隔离",
    });
    expect(sent.blockedReason).toMatch(/尚未证明/);
    expect(sent.collabConfigVersion).toBeUndefined();
  });

  it("blocks advisor send when parent engine is not in GET parents", () => {
    const sent = sendCollabFields({
      agentId: "main",
      mode: "advisor",
      advisorModel: "gpt-6-astra",
      configVersion: "v1:advisor:gpt-6-astra",
      parentEngine: "codex",
      advisorConsultParents: ["ccb"],
      advisorConsultParentReason: "一期仅 CCB 主会话可咨询顾问。",
    });
    expect(sent.blockedReason).toMatch(/CCB/);
    expect(sent.collabMode).toBe("advisor");
    expect(sent.collabConfigVersion).toBeUndefined();
  });

  it("blocks advisor send when GET says allowed=false, without silent solo", () => {
    const sent = sendCollabFields({
      agentId: "main",
      mode: "advisor",
      advisorModel: "gpt-6-astra",
      configVersion: "v1:advisor:gpt-6-astra",
      advisorConsultAllowed: false,
      advisorConsultParentReason: "一期仅 CCB 主会话可咨询顾问。",
    });
    expect(sent.blockedReason).toMatch(/CCB/);
    expect(sent.collabMode).toBe("advisor");
  });

  it("uses current CCB model even when GET allowed=false from a stale live engine", () => {
    const sent = sendCollabFields({
      agentId: "main",
      mode: "advisor",
      advisorModel: "gpt-6-astra",
      configVersion: "v1:advisor:gpt-6-astra",
      parentEngine: "ccb",
      advisorConsultParents: ["ccb"],
      advisorConsultAllowed: false,
      advisorConsultParentReason: "一期仅 CCB 主会话可咨询顾问。",
    });
    expect(sent.blockedReason).toBeUndefined();
    expect(sent.collabMode).toBe("advisor");
  });

  it("allows CCB parent when GET parents list includes ccb", () => {
    const sent = sendCollabFields({
      agentId: "main",
      mode: "advisor",
      advisorModel: "gpt-6-astra",
      configVersion: "v1:advisor:gpt-6-astra",
      parentEngine: "ccb",
      advisorConsultParents: ["ccb"],
      advisorConsultAllowed: true,
    });
    expect(sent.blockedReason).toBeUndefined();
    expect(sent.collabMode).toBe("advisor");
  });

  it("team maps to teamMode true without advisor fields", () => {
    expect(
      sendCollabFields({
        agentId: "main",
        mode: "team",
        advisorModel: null,
        configVersion: "v1:team:",
      }),
    ).toEqual({ teamMode: true, collabMode: "team" });
  });
});

describe("collaborationPutBody", () => {
  it("session save never sends asDefault unless the checkbox is true", () => {
    expect(
      collaborationPutBody({
        sessionId: "sess-a",
        mode: "advisor",
        advisorModel: "gpt-6-astra",
        expectedRev: 4,
        asDefault: false,
      }),
    ).toEqual({
      sessionId: "sess-a",
      mode: "advisor",
      advisorModel: "gpt-6-astra",
      expectedRev: 4,
    });
  });

  it("empty session without asDefault does not become a default write", () => {
    expect(
      collaborationPutBody({
        mode: "advisor",
        advisorModel: "gpt-6-astra",
        expectedRev: 1,
      }),
    ).toEqual({
      mode: "advisor",
      advisorModel: "gpt-6-astra",
      expectedRev: 1,
    });
  });

  it("asDefault true is the only way to include asDefault", () => {
    expect(
      collaborationPutBody({
        mode: "advisor",
        advisorModel: "gpt-6-astra",
        asDefault: true,
      }).asDefault,
    ).toBe(true);
  });
});

describe("stale config loads", () => {
  it("drops GET that started before a later user click", () => {
    expect(isStaleCollabEpoch(1, 2)).toBe(true);
    expect(isStaleCollabEpoch(3, 3)).toBe(false);
  });
});

describe("recommendedAdvisorModel", () => {
  it("prefers gpt-6-astra when listed", () => {
    expect(recommendedAdvisorModel(docToUiState(DOC))).toBe("gpt-6-astra");
  });

  it("returns null when catalog list is empty (do not silently invent a model)", () => {
    expect(
      recommendedAdvisorModel({
        ...docToUiState(DOC),
        advisorModels: [],
      }),
    ).toBeNull();
  });
});
