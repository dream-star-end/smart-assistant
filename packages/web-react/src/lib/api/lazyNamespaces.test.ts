import { describe, expect, test, vi } from "vitest";
import { integrationsApi as realIntegrations } from "./integrationsApi";
import { memorySkillsApi as realMemory } from "./memorySkillsApi";
import { integrationsApi, memorySkillsApi } from "./lazyNamespaces";

describe("lazy api namespaces", () => {
  test("facades keep every settings method", () => {
    expect(Object.keys(integrationsApi).sort()).toEqual(Object.keys(realIntegrations).sort());
    expect(Object.keys(memorySkillsApi).sort()).toEqual(Object.keys(realMemory).sort());
  });

  test("the first memory call loads the real client", async () => {
    const spy = vi.spyOn(realMemory, "listSkills").mockResolvedValue([]);
    await expect(memorySkillsApi.listSkills({} as never)).resolves.toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
