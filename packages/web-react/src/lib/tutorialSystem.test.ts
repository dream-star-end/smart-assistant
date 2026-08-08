import { afterEach, describe, expect, it } from "vitest";
import {
  PRODUCT_CAPABILITIES,
  PRODUCT_CAPABILITY_LIST,
  type ProductFeatureId,
  capabilityById,
} from "./productCapabilities";
import { resolveTutorialAction } from "./tutorialActions";
import {
  TUTORIAL_CASES,
  TUTORIAL_CASE_BY_ID,
  TUTORIAL_CASE_IDS,
  parseTutorialCaseId,
} from "./tutorialCaseCatalog";
import {
  TUTORIAL_MEDIA,
  TUTORIAL_TOPICS,
  tutorialById,
} from "./tutorialCatalog";
import {
  markTutorialRead,
  readTutorialProgress,
  tutorialIsRead,
} from "./tutorialProgress";

afterEach(() => localStorage.clear());

describe("v5 教程单一能力注册表", () => {
  it("能力、教程、媒体和关联关系完整一一对应", () => {
    const registry = PRODUCT_CAPABILITY_LIST.map((item) => item.id).sort();
    expect(Object.keys(TUTORIAL_TOPICS).sort()).toEqual(registry);
    expect(Object.keys(TUTORIAL_MEDIA).sort()).toEqual(registry);
    expect(new Set(registry).size).toBe(registry.length);
    expect(
      new Set(Object.values(TUTORIAL_TOPICS).map((topic) => topic.media)).size,
    ).toBe(registry.length);

    for (const feature of PRODUCT_CAPABILITY_LIST) {
      const topic = tutorialById(feature.id as ProductFeatureId);
      expect(topic.featureId).toBe(feature.id);
      expect(topic.media).toBe(feature.id);
      expect(topic.steps).toHaveLength(4);
      expect(topic.scenarios.length).toBeGreaterThanOrEqual(3);
      expect(TUTORIAL_MEDIA[topic.media].poster).toMatch(
        /^\/tutorials\/.+\.webp$/,
      );
      expect(TUTORIAL_MEDIA[topic.media].video).toMatch(
        /^\/tutorials\/.+\.webm$/,
      );
      expect(TUTORIAL_MEDIA[topic.media].poster).toBe(
        `/tutorials/${feature.id}.webp`,
      );
      expect(TUTORIAL_MEDIA[topic.media].video).toBe(
        `/tutorials/${feature.id}.webm`,
      );
      for (const related of topic.related)
        expect(capabilityById(related).id).toBe(related);
    }
  });

  it("CTA 权限由声明式 requirements 收口，不可用时给出真实原因", () => {
    const base = {
      authenticated: true,
      featureImage2: true,
      microphone: true,
      orgRole: "owner" as const,
    };
    expect(
      resolveTutorialAction(PRODUCT_CAPABILITIES.images, base).enabled,
    ).toBe(true);
    expect(
      resolveTutorialAction(PRODUCT_CAPABILITIES.images, {
        ...base,
        featureImage2: false,
      }),
    ).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining("Image 2"),
    });
    expect(
      resolveTutorialAction(PRODUCT_CAPABILITIES.voice, {
        ...base,
        microphone: false,
      }),
    ).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining("麦克风"),
    });
    expect(
      resolveTutorialAction(PRODUCT_CAPABILITIES.organization, {
        ...base,
        orgRole: "member",
      }),
    ).toMatchObject({
      enabled: false,
      disabledReason: expect.stringContaining("管理员"),
    });
  });
});

describe("v5 真实场景案例注册表", () => {
  it("固定提供科研 5、编码 5、通用 2 个稳定案例", () => {
    expect(TUTORIAL_CASES).toHaveLength(12);
    expect(TUTORIAL_CASE_IDS).toHaveLength(12);
    expect(new Set(TUTORIAL_CASE_IDS).size).toBe(12);
    expect(TUTORIAL_CASES.filter((item) => item.category === "research")).toHaveLength(5);
    expect(TUTORIAL_CASES.filter((item) => item.category === "coding")).toHaveLength(5);
    expect(TUTORIAL_CASES.filter((item) => item.category === "general")).toHaveLength(2);
  });

  it("每个案例包含来源、完整阶段、产物和确定性验收，未实跑时不伪造重放", () => {
    for (const item of TUTORIAL_CASES) {
      expect(TUTORIAL_CASE_BY_ID[item.id]).toBe(item);
      expect(item.contentVersion).toBeGreaterThan(0);
      expect(item.sources.length).toBeGreaterThan(0);
      expect(item.inputMaterials.length).toBeGreaterThan(0);
      expect(item.stages.length).toBeGreaterThanOrEqual(4);
      expect(item.artifacts.length).toBeGreaterThan(0);
      expect(item.checks.length).toBeGreaterThanOrEqual(2);
      expect(item.starterPrompt.length).toBeGreaterThan(100);
      for (const capabilityId of item.capabilityIds)
        expect(capabilityById(capabilityId).id).toBe(capabilityId);
      for (const source of item.sources) {
        expect(source.url).toMatch(/^https:\/\//);
        expect(source.license.trim()).not.toBe("");
        expect(source.usageNote.trim()).not.toBe("");
      }
      for (const stage of item.stages) {
        expect(stage.visibleProcess.length).toBeGreaterThan(0);
        expect(stage.acceptance.length).toBeGreaterThan(0);
      }
      if (item.replay.status === "pending_capture") {
        expect(item.replay.messagesPath).toBeUndefined();
        expect(item.replay.provenance).toBeUndefined();
        expect(item.replay.disclosure).toContain("尚未完成三次独立运行");
      }
    }
  });

  it("深链解析只接受登记过的稳定案例 id", () => {
    expect(parseTutorialCaseId("research-bike-demand")).toBe("research-bike-demand");
    expect(parseTutorialCaseId("removed-case")).toBeNull();
    expect(parseTutorialCaseId(null)).toBeNull();
  });
});

describe("教程阅读进度", () => {
  it("按 topic contentVersion 记录，正文升级后自然回到未读", () => {
    const id = PRODUCT_CAPABILITIES.chatBasics.id;
    const saved = markTutorialRead(id);
    expect(tutorialIsRead(saved, id)).toBe(true);

    const key = Object.keys(localStorage)[0];
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}") as {
      read: Record<string, number>;
    };
    raw.read[id] = TUTORIAL_TOPICS[id].contentVersion + 1;
    localStorage.setItem(key, JSON.stringify(raw));
    expect(tutorialIsRead(readTutorialProgress(), id)).toBe(false);
  });

  it("损坏或未知版本的 localStorage 静默回退空进度", () => {
    markTutorialRead(PRODUCT_CAPABILITIES.chatBasics.id);
    const key = Object.keys(localStorage)[0];
    localStorage.setItem(key, "{broken");
    expect(readTutorialProgress().read).toEqual({});

    localStorage.setItem(
      key,
      JSON.stringify({ schema: 999, read: { "chat-basics": 1 } }),
    );
    expect(readTutorialProgress().read).toEqual({});
  });
});
