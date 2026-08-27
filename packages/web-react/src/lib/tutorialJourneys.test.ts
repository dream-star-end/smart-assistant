import { describe, expect, it } from "vitest";
import { TUTORIAL_MEDIA, TUTORIAL_TOPICS } from "./tutorialCatalog";
import {
  TUTORIAL_PENDING_CAPTURE_LABEL,
  TUTORIAL_QUICKSTART,
  TUTORIAL_SCENARIO_PATHS,
} from "./tutorialJourneys";

function referencedTopicIds(): string[] {
  return [
    ...TUTORIAL_QUICKSTART.steps.map((step) => step.topicId),
    ...TUTORIAL_SCENARIO_PATHS.flatMap((path) => [...path.topicIds]),
  ];
}

describe("教程主线与场景路径", () => {
  it("引用的章节 id 都存在于 TUTORIAL_TOPICS", () => {
    for (const id of referencedTopicIds()) {
      expect(TUTORIAL_TOPICS[id as keyof typeof TUTORIAL_TOPICS]).toBeDefined();
      expect(TUTORIAL_TOPICS[id as keyof typeof TUTORIAL_TOPICS].featureId).toBe(id);
    }
  });

  it("不另假设媒体，只复用已有章节的录制", () => {
    expect(TUTORIAL_QUICKSTART).not.toHaveProperty("media");
    expect(TUTORIAL_QUICKSTART).not.toHaveProperty("poster");
    expect(TUTORIAL_QUICKSTART).not.toHaveProperty("video");
    for (const step of TUTORIAL_QUICKSTART.steps) {
      expect(step).not.toHaveProperty("media");
      expect(step).not.toHaveProperty("poster");
      expect(step).not.toHaveProperty("video");
      expect(TUTORIAL_MEDIA[step.topicId]).toBeDefined();
      expect(TUTORIAL_MEDIA[step.topicId].poster).toBe(`/tutorials/${step.topicId}.webp`);
      expect(TUTORIAL_MEDIA[step.topicId].video).toBe(`/tutorials/${step.topicId}.webm`);
    }
    for (const path of TUTORIAL_SCENARIO_PATHS) {
      expect(path).not.toHaveProperty("media");
      for (const topicId of path.topicIds) {
        expect(TUTORIAL_MEDIA[topicId]).toBeDefined();
      }
    }
  });

  it("主线 5–6 步，场景 4–6 条，每条 3–5 个不重复章节", () => {
    expect(TUTORIAL_QUICKSTART.steps.length).toBeGreaterThanOrEqual(5);
    expect(TUTORIAL_QUICKSTART.steps.length).toBeLessThanOrEqual(6);
    expect(TUTORIAL_QUICKSTART.estimatedMinutes).toBe(10);
    expect(TUTORIAL_SCENARIO_PATHS.length).toBeGreaterThanOrEqual(4);
    expect(TUTORIAL_SCENARIO_PATHS.length).toBeLessThanOrEqual(6);
    for (const path of TUTORIAL_SCENARIO_PATHS) {
      expect(path.topicIds.length).toBeGreaterThanOrEqual(3);
      expect(path.topicIds.length).toBeLessThanOrEqual(5);
      expect(new Set(path.topicIds).size).toBe(path.topicIds.length);
      expect(path.description.length).toBeGreaterThan(8);
    }
  });

  it("待采集声明文案固定，避免入口各自包装成已完成故事", () => {
    expect(TUTORIAL_PENDING_CAPTURE_LABEL).toBe("示例待真实运行采集");
  });
});
