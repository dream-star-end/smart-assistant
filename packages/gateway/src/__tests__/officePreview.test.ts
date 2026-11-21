/**
 * Office 零轮次缓存预览服务单测(OCV5-828 R2 · B3 快照一致性/单飞 + B6 真实 openpyxl):
 *   - 路径越界 / 逐级符号链接 / 扩展名白名单 / 文件体积安全红线;
 *   - B3: 并发修改源文件不影响已验证私有快照与 sha256 一致性,同键并发单飞不互删;
 *   - B6: 真实 Python + openpyxl(若环境预装)覆盖单格 A1=42、内部空洞、多 Sheet、公式错误与 500 行截断。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/officePreview.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type ExecFileLike,
  MAX_XLSX_ROWS_PER_SHEET,
  OfficePreviewError,
  previewOfficeFile,
  resolveSafeOfficeFile,
} from "../officePreview.js";

function hasPythonOpenpyxl(): boolean {
  try {
    execFileSync("python3", ["-c", "import openpyxl"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("resolveSafeOfficeFile security guards", () => {
  it("rejects relative paths, escapes, leaf symlinks, intermediate dir symlinks, and unsupported extensions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oc-office-sec-"));
    const outside = mkdtempSync(path.join(tmpdir(), "oc-office-out-"));
    try {
      const realDoc = path.join(root, "valid.pptx");
      writeFileSync(realDoc, "PK\x03\x04dummy-pptx");
      const outsideDoc = path.join(outside, "secret.pptx");
      writeFileSync(outsideDoc, "PK\x03\x04outside");
      const badExt = path.join(root, "script.sh");
      writeFileSync(badExt, "#!/bin/sh\necho hi\n");

      const leafSym = path.join(root, "escape.pptx");
      symlinkSync(outsideDoc, leafSym);
      const internalSym = path.join(root, "alias.pptx");
      symlinkSync(realDoc, internalSym);
      const dirSym = path.join(root, "linked-dir");
      symlinkSync(outside, dirSym);

      assert.throws(
        () => resolveSafeOfficeFile("relative.pptx", [root]),
        (e: unknown) => e instanceof OfficePreviewError && e.code === "INVALID_PATH",
      );
      assert.throws(
        () => resolveSafeOfficeFile(outsideDoc, [root]),
        (e: unknown) => e instanceof OfficePreviewError && e.code === "PATH_ESCAPE",
      );
      assert.throws(
        () => resolveSafeOfficeFile(path.join(root, "..", path.basename(outside), "secret.pptx"), [root]),
        (e: unknown) => e instanceof OfficePreviewError && e.code === "PATH_ESCAPE",
      );
      assert.throws(
        () => resolveSafeOfficeFile(leafSym, [root]),
        (e: unknown) => e instanceof OfficePreviewError && e.code === "SYMLINK_REJECTED",
      );
      assert.throws(
        () => resolveSafeOfficeFile(internalSym, [root]),
        (e: unknown) => e instanceof OfficePreviewError && e.code === "SYMLINK_REJECTED",
      );
      assert.throws(
        () => resolveSafeOfficeFile(path.join(dirSym, "secret.pptx"), [root]),
        (e: unknown) => e instanceof OfficePreviewError && e.code === "SYMLINK_REJECTED",
      );
      assert.throws(
        () => resolveSafeOfficeFile(badExt, [root]),
        (e: unknown) => e instanceof OfficePreviewError && e.code === "UNSUPPORTED_TYPE",
      );
      assert.throws(
        () => resolveSafeOfficeFile(realDoc, [root], 4),
        (e: unknown) => e instanceof OfficePreviewError && e.code === "FILE_TOO_LARGE",
      );

      const safe = resolveSafeOfficeFile(realDoc, [root]);
      assert.equal(safe.kind, "pptx");
      assert.equal(safe.sha256.length, 64);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("B3: single verified snapshot, concurrent source replacement immunity & single-flight", () => {
  it("renders from immutable private snapshot even when source file is replaced concurrently, and deduplicates in-flight renders", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "oc-office-b3-"));
    const cacheDir = mkdtempSync(path.join(tmpdir(), "oc-office-cache-b3-"));
    const memCache = new Map();
    try {
      const pptxPath = path.join(root, "quarterly.pptx");
      const v1Bytes = Buffer.from("PK\x03\x04pptx-v1-original-bytes");
      const v1Sha = createHash("sha256").update(v1Bytes).digest("hex");
      writeFileSync(pptxPath, v1Bytes);
      writeFileSync(
        path.join(root, "quarterly.deck.json"),
        JSON.stringify({
          title: "Q4",
          slides: [
            { heading: "Intro", bullets: ["A"], notes: "Speaker note v1" },
          ],
        }),
      );

      let execCount = 0;
      let rendererSawSha = "";
      let rendererInputPath = "";

      const execMock: ExecFileLike = async (file, args) => {
        execCount += 1;
        assert.equal(file, "oc-artifact-qa");
        const inputIdx = args.indexOf("--input");
        rendererInputPath = args[inputIdx + 1]!;
        // Verify renderer reads the immutable snapshot (NOT mutable pptxPath!) and its bytes match v1Sha!
        assert.notEqual(rendererInputPath, pptxPath);
        rendererSawSha = createHash("sha256").update(readFileSync(rendererInputPath)).digest("hex");

        const outDirIdx = args.indexOf("--out-dir");
        const outDir = args[outDirIdx + 1]!;
        mkdirSync(path.join(outDir, "pages"), { recursive: true });
        const p1 = path.join(outDir, "pages", "page-1.png");
        writeFileSync(p1, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const report = { passed: true, renderedPages: [p1], failures: [], warnings: [] };
        writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report));
        return { stdout: JSON.stringify(report), stderr: "" };
      };

      const res = await previewOfficeFile(pptxPath, {
        allowedRoots: [root],
        cacheDir,
        memoryCache: memCache,
        execFileImpl: execMock,
        // Simulate concurrent overwrite of source file AFTER snapshot & BEFORE renderer runs!
        onSnapshotReady: () => {
          writeFileSync(pptxPath, "PK\x03\x04pptx-CONCURRENT-TAMPERED-V2");
        },
      });

      assert.equal(res.kind, "pptx");
      assert.equal(res.sha256, v1Sha);
      assert.equal(rendererSawSha, v1Sha); // Hash & rendered bytes 100% bound to same snapshot!
      assert.equal(res.pages[0]?.notes, "Speaker note v1");
      assert.ok(res.pages[0]?.imgPath.includes(res.cacheKey));
      assert.equal(execCount, 1);

      // Editing sidecar notes invalidates PPTX cache key (N3)
      writeFileSync(pptxPath, v1Bytes);
      const v1StatTime = new Date(res.mtimeMs);
      utimesSync(pptxPath, v1StatTime, v1StatTime);
      writeFileSync(
        path.join(root, "quarterly.deck.json"),
        JSON.stringify({
          title: "Q4",
          slides: [{ heading: "Intro", bullets: ["A"], notes: "Speaker note v2 edited" }],
        }),
      );
      const afterNotesEdit = await previewOfficeFile(pptxPath, {
        allowedRoots: [root],
        cacheDir,
        memoryCache: memCache,
        execFileImpl: execMock,
      });
      assert.equal(afterNotesEdit.kind, "pptx");
      assert.equal(afterNotesEdit.cached, false);
      assert.equal(afterNotesEdit.pages[0]?.notes, "Speaker note v2 edited");
      assert.equal(execCount, 2);

      // Single-flight: 2 concurrent cold calls for same new file invoke renderer ONCE
      const docxPath = path.join(root, "concurrent.docx");
      writeFileSync(docxPath, "PK\x03\x04docx-concurrent");
      let docxExecs = 0;
      const slowDocxExec: ExecFileLike = async (_file, args) => {
        if (args[0] === "render") {
          docxExecs += 1;
          await new Promise((r) => setTimeout(r, 40));
          const outDir = args[args.indexOf("--output-dir") + 1]!;
          mkdirSync(outDir, { recursive: true });
          const p1 = path.join(outDir, "page-1.png");
          writeFileSync(p1, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          return { stdout: JSON.stringify({ pages: [p1] }), stderr: "" };
        }
        return { stdout: JSON.stringify({ zip_integrity_ok: true, non_empty_paragraph_count: 5 }), stderr: "" };
      };

      const [c1, c2] = await Promise.all([
        previewOfficeFile(docxPath, { allowedRoots: [root], cacheDir, memoryCache: memCache, execFileImpl: slowDocxExec }),
        previewOfficeFile(docxPath, { allowedRoots: [root], cacheDir, memoryCache: memCache, execFileImpl: slowDocxExec }),
      ]);
      assert.equal(docxExecs, 1);
      assert.equal(c1.cacheKey, c2.cacheKey);
      assert.equal(c1.kind, "docx");
      assert.equal(c2.kind, "docx");

      // B3: Corrupted cache entry (deleted page PNG) self-heals on retry instead of returning 500 RENDER_FAILED!
      assert.equal(c1.pages.length, 1);
      rmSync(c1.pages[0]!.imgPath, { force: true });
      const healed1 = await previewOfficeFile(docxPath, {
        allowedRoots: [root],
        cacheDir,
        memoryCache: new Map(),
        execFileImpl: slowDocxExec,
      });
      assert.equal(healed1.kind, "docx");
      assert.equal(healed1.cached, false);
      assert.equal(healed1.pages.length, 1);
      assert.equal(docxExecs, 2);

      // Next call hits the freshly healed disk cache cleanly
      const healed2 = await previewOfficeFile(docxPath, {
        allowedRoots: [root],
        cacheDir,
        memoryCache: new Map(),
        execFileImpl: slowDocxExec,
      });
      assert.equal(healed2.kind, "docx");
      assert.equal(healed2.cached, true);
      assert.equal(healed2.pages.length, 1);
      assert.equal(docxExecs, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe("B6: real Python openpyxl sparse sheets, streaming write_only workbooks, holes, multi-sheet errors & 500-row cap", () => {
  const realOpenpyxl = hasPythonOpenpyxl();

  it(
    "parses REAL openpyxl workbooks: normal & streaming write_only A1=42 (no <dimension>), internal holes, multi-sheet formulas/errors, and 500-row cap",
    { skip: !realOpenpyxl && "python3 openpyxl not installed on this host (verified in runtime container)" },
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "oc-office-xlsx-real-"));
      const cacheDir = mkdtempSync(path.join(tmpdir(), "oc-office-xlsx-cache-"));
      try {
        // 1) Normal & streaming (write_only=True, no <dimension> element) single-cell A1=42 workbooks
        const sparsePath = path.join(root, "sparse.xlsx");
        const streamPath = path.join(root, "stream.xlsx");
        execFileSync("python3", [
          "-c",
          `import openpyxl, sys
wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Single"
ws["A1"] = 42
wb.save(sys.argv[1])

wb_s = openpyxl.Workbook(write_only=True)
ws_s = wb_s.create_sheet("Single")
ws_s.append([42])
wb_s.save(sys.argv[2])`,
          sparsePath,
          streamPath,
        ]);

        for (const p of [sparsePath, streamPath]) {
          const res = await previewOfficeFile(p, {
            allowedRoots: [root],
            cacheDir,
            memoryCache: new Map(),
          });
          assert.equal(res.kind, "xlsx");
          assert.equal(res.sheets.length, 1);
          assert.equal(res.sheets[0]?.totalRows, 1);
          assert.equal(res.sheets[0]?.totalCols, 1);
          assert.equal(res.sheets[0]?.truncated, false);
          assert.equal(res.sheets[0]?.rows[0]?.[0]?.cell, "A1");
          assert.equal(res.sheets[0]?.rows[0]?.[0]?.value, 42);
        }

        // 2) Multi-sheet with internal EmptyCell holes, formulas, #DIV/0! & #REF!, and 550-row sheet capped at 500
        const complexPath = path.join(root, "complex.xlsx");
        execFileSync("python3", [
          "-c",
          `import openpyxl, sys
wb = openpyxl.Workbook()
ws1 = wb.active
ws1.title = "HolesAndErrors"
ws1["A1"] = "hdr"
ws1["D1"] = "far"
ws1["B3"] = 123
ws1["C4"] = "=1/0"
ws1["D4"] = "#DIV/0!"
ws1["E4"] = "#REF!"
ws2 = wb.create_sheet("BigSheet")
for r in range(1, 551):
    ws2.cell(row=r, column=1, value=r)
wb.save(sys.argv[1])`,
          complexPath,
        ]);

        const complexRes = await previewOfficeFile(complexPath, {
          allowedRoots: [root],
          cacheDir,
          memoryCache: new Map(),
        });
        assert.equal(complexRes.kind, "xlsx");
        assert.equal(complexRes.maxRowsPerSheet, MAX_XLSX_ROWS_PER_SHEET);
        assert.equal(complexRes.sheets.length, 2);

        const s1 = complexRes.sheets[0]!;
        assert.equal(s1.name, "HolesAndErrors");
        assert.equal(s1.rows[0]?.[0]?.cell, "A1");
        assert.equal(s1.rows[0]?.[0]?.value, "hdr");
        assert.equal(s1.rows[0]?.[1]?.cell, "B1");
        assert.equal(s1.rows[0]?.[1]?.value, null); // EmptyCell hole handled safely!
        assert.equal(s1.rows[0]?.[3]?.cell, "D1");
        assert.equal(s1.rows[0]?.[3]?.value, "far");
        assert.equal(s1.rows[2]?.[1]?.cell, "B3");
        assert.equal(s1.rows[2]?.[1]?.value, 123);
        assert.ok(s1.formulas.some((f) => f.cell === "C4" && f.formula === "=1/0"));
        assert.deepEqual(
          complexRes.errorCells.map((e) => e.error),
          ["#DIV/0!", "#REF!"],
        );

        const s2 = complexRes.sheets[1]!;
        assert.equal(s2.name, "BigSheet");
        assert.equal(s2.totalRows, 550);
        assert.equal(s2.rows.length, 500);
        assert.equal(s2.truncated, true);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(cacheDir, { recursive: true, force: true });
      }
    },
  );
});
