import { describe, expect, it } from "vitest";
import { ICON_NODES } from "./iconNodes.generated";
import { ICON_NAMES, ICON_SOURCES, KIND_ICON_SOURCES, UI_ICON_SOURCES, iconFor, kindIcon, uiIcon } from "./icons";

describe("Intelligent UI icons", () => {
  it("generated shapes match the installed lucide-react (run scripts/gen-iui-icons.mjs after an upgrade)", async () => {
    const used = new Set<string>([...Object.values(ICON_SOURCES), ...Object.values(KIND_ICON_SOURCES), ...Object.values(UI_ICON_SOURCES)]);
    expect(new Set(Object.keys(ICON_NODES))).toEqual(used);
    for (const name of used) {
      const mod = (await import(`lucide-react/dist/esm/icons/${name}.mjs`)) as { __iconNode: unknown };
      expect(ICON_NODES[name as keyof typeof ICON_NODES], name).toEqual(mod.__iconNode);
    }
  });

  it("looks names up the way the model writes them", () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(80);
    expect(iconFor("home")).toBe(ICON_NODES.house);
    expect(iconFor(" Home ")).toBe(ICON_NODES.house);
    expect(iconFor("snow")).toBe(ICON_NODES.snowflake);
    expect(iconFor("tree-pine")).toBe(ICON_NODES["tree-pine"]);
    expect(iconFor("no-such-icon")).toBeNull();
    expect(iconFor("__proto__")).toBeNull();
    expect(iconFor("constructor")).toBeNull();
    expect(iconFor(undefined)).toBeNull();
    expect(kindIcon("route")).toBe(ICON_NODES.route);
    expect(kindIcon("callout")).toBeNull();
    expect(kindIcon("sources")).toBe(ICON_NODES["book-marked"]);
    expect(uiIcon("diff")).toBe(ICON_NODES["git-compare-arrows"]);
  });
});
