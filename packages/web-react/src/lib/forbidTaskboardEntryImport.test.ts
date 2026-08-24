import { describe, expect, test } from "vitest";
import { forbiddenTaskboardEntryImports } from "./forbidTaskboardEntryImport";

describe("forbiddenTaskboardEntryImports", () => {
  test("locks the live 2026-08-24 graph: TaskboardView importing main-*.js is forbidden", () => {
    const bad = forbiddenTaskboardEntryImports([
      { type: "chunk", fileName: "assets/main-z48VJqJ4.js", isEntry: true },
      { type: "chunk", fileName: "assets/admin-abc.js", isEntry: true, facadeModuleId: "/x/admin.html" },
      {
        type: "chunk",
        fileName: "assets/TaskboardView-B9fE8_e0.js",
        facadeModuleId: "/x/src/components/taskboard/TaskboardView.tsx",
        imports: ["./main-z48VJqJ4.js", "./lucide-vendor-aaa.js"],
      },
    ]);
    expect(bad).toEqual(["assets/TaskboardView-B9fE8_e0.js -> ./main-z48VJqJ4.js"]);
  });

  test("lucide vendor group: TaskboardView may import lucide/react but not the SPA entry", () => {
    const bad = forbiddenTaskboardEntryImports([
      { type: "chunk", fileName: "assets/main-new.js", isEntry: true },
      {
        type: "chunk",
        fileName: "assets/TaskboardView-new.js",
        facadeModuleId: "/x/src/components/taskboard/TaskboardView.tsx",
        imports: ["./lucide-vendor-bbb.js", "./react-vendor-ccc.js"],
      },
    ]);
    expect(bad).toEqual([]);
  });

  test("admin entry is not treated as the SPA entry", () => {
    const bad = forbiddenTaskboardEntryImports([
      { type: "chunk", fileName: "assets/admin-abc.js", isEntry: true, facadeModuleId: "/x/admin.html" },
      {
        type: "chunk",
        fileName: "assets/TaskboardView-x.js",
        imports: ["./admin-abc.js"],
      },
    ]);
    expect(bad).toEqual([]);
  });
});
