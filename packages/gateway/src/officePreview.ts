/**
 * 零轮次缓存型只读 Office 预览服务(.pptx / .docx / .xlsx)(OCV5-828 R2)。
 *
 * 安全与一致性红线(B3 + B6 + N3):
 *   - 严格只读:绝不修改源文件;零 LLM 轮次。
 *   - 单一安全对象绑定(B3):逐段 lstat 拒符号链接 + realpath containment 后,通过
 *     `O_RDONLY | O_NOFOLLOW` 打开一次 fd,流式同时计算 sha256 并落盘至服务私有(0700)
 *     不可变只读快照(0400);后续所有渲染器(oc-artifact-qa / oc-docx / python3 openpyxl)
 *     一律只读该私有快照,彻底消除“哈希读旧文件、渲染读新文件”的 TOCTOU 窗口。
 *   - 原子发布与同键单飞(B3):先在同缓存根下独占临时 staging 目录渲染并写 `preview.json`,
 *     校验完整后原子 `renameSync` 发布到最终目录;同 `cacheKey` 并发请求共享单飞 Promise,
 *     绝不互相删目录。
 *   - 真实 openpyxl 稀疏表支持(B6):使用 `get_column_letter(col_idx) + str(row_idx)` 与
 *     `zip_longest` + `getattr(..., 'value', None)`,彻底兼容 `read_only=True` 的 `EmptyCell`,
 *     每表硬封顶 500 行、全书上限 32 表 / 50,000 单元格。
 *   - PPTX 缓存键纳入同目录 `.deck.json` 备注指纹(N3),修改备注自动失效。
 */

import { execFile as execFileCb } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isPathWithinRoot } from "./pathAcl.js";

const execFileAsync = promisify(execFileCb);

export const MAX_OFFICE_PREVIEW_BYTES = 50 * 1024 * 1024; // 50 MiB
export const MAX_XLSX_ROWS_PER_SHEET = 500;
export const MAX_XLSX_COLS_PER_SHEET = 100;
export const MAX_XLSX_SHEETS = 32;
export const MAX_XLSX_TOTAL_CELLS = 50_000;
export const DEFAULT_RENDER_TIMEOUT_MS = 120_000;
const DEFAULT_MEM_CACHE_MAX = 64;
const DEFAULT_DISK_CACHE_MAX = 128;

export const EXCEL_ERROR_TOKENS = new Set([
  "#DIV/0!",
  "#REF!",
  "#VALUE!",
  "#NAME?",
  "#N/A",
  "#NUM!",
  "#NULL!",
]);

export type OfficePreviewKind = "pptx" | "docx" | "xlsx";

export type OfficePreviewErrorCode =
  | "INVALID_PATH"
  | "SYMLINK_REJECTED"
  | "PATH_ESCAPE"
  | "FILE_NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "RENDER_FAILED";

export class OfficePreviewError extends Error {
  readonly code: OfficePreviewErrorCode;
  readonly httpStatus: number;

  constructor(code: OfficePreviewErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = "OfficePreviewError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface OfficeQaIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  page?: number;
  sheet?: string;
  cell?: string;
}

export interface OfficePreviewPage {
  index: number;
  imgPath: string;
  notes?: string;
}

export interface XlsxCell {
  cell: string;
  value: string | number | boolean | null;
  formula?: string;
  error?: string;
}

export interface XlsxErrorCell {
  sheet: string;
  cell: string;
  error: string;
  formula?: string;
}

export interface XlsxSheetPreview {
  name: string;
  totalRows: number;
  totalCols: number;
  truncated: boolean;
  rows: XlsxCell[][];
  formulas: Array<{ cell: string; formula: string; value: string | number | boolean | null }>;
  errorCells: XlsxErrorCell[];
}

export interface OfficePagePreviewResult {
  kind: "pptx" | "docx";
  filePath: string;
  sha256: string;
  mtimeMs: number;
  cacheKey: string;
  cached: boolean;
  pages: OfficePreviewPage[];
  qaIssues: OfficeQaIssue[];
}

export interface OfficeXlsxPreviewResult {
  kind: "xlsx";
  filePath: string;
  sha256: string;
  mtimeMs: number;
  cacheKey: string;
  cached: boolean;
  maxRowsPerSheet: number;
  sheets: XlsxSheetPreview[];
  errorCells: XlsxErrorCell[];
  qaIssues: OfficeQaIssue[];
}

export type OfficePreviewResult = OfficePagePreviewResult | OfficeXlsxPreviewResult;

export interface SafeOfficeFileInfo {
  realPath: string;
  kind: OfficePreviewKind;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

export interface VerifiedOfficeSnapshot extends SafeOfficeFileInfo {
  /** 服务私有不可变快照路径(所有渲染器只读此文件,与 sha256 严格绑定同一字节)。 */
  snapshotPath: string;
  /** 清理私有快照。 */
  cleanup: () => void;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface OfficePreviewOptions {
  /** 允许访问的根目录白名单(防路径越界)。 */
  allowedRoots: readonly string[];
  /** 服务私有磁盘缓存目录(默认 os.tmpdir()/oc-office-preview-cache,0700)。 */
  cacheDir?: string;
  /** 单表最大行数(硬封顶 MAX_XLSX_ROWS_PER_SHEET = 500)。 */
  maxRowsPerSheet?: number;
  /** 最大允许源文件体积(默认 50 MiB)。 */
  maxFileBytes?: number;
  /** 磁盘缓存最大条目数(默认 128)。 */
  maxDiskCacheEntries?: number;
  /** 渲染子进程超时(默认 120s)。 */
  timeoutMs?: number;
  /** 外部命令执行器注入(测试用)。 */
  execFileImpl?: ExecFileLike;
  /** 可选自定义内存缓存(默认模块级 LRU)。 */
  memoryCache?: Map<string, OfficePreviewResult>;
  /** 可选测试钩子:快照落盘后、调用渲染器前触发(用于并发替换源文件测试)。 */
  onSnapshotReady?: (snapshotPath: string, realSourcePath: string) => Promise<void> | void;
  /** 覆盖工具路径(默认容器预装 PATH 命令)。 */
  bins?: {
    artifactQa?: string;
    ocDocx?: string;
    python3?: string;
  };
}

const defaultMemoryCache = new Map<string, OfficePreviewResult>();
const defaultInFlight = new Map<string, Promise<OfficePreviewResult>>();

function kindFromExtension(filePath: string): OfficePreviewKind | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pptx") return "pptx";
  if (ext === ".docx") return "docx";
  if (ext === ".xlsx") return "xlsx";
  return null;
}

function lstatSafe(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function ensurePrivateDir(dirPath: string): string {
  const st = lstatSafe(dirPath);
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new OfficePreviewError("SYMLINK_REJECTED", 403, "cache directory must not be a symlink");
    }
    return realpathSync(dirPath);
  }
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const created = lstatSafe(dirPath);
  if (!created || created.isSymbolicLink() || !created.isDirectory()) {
    throw new OfficePreviewError("SYMLINK_REJECTED", 403, "failed to create private cache directory");
  }
  return realpathSync(dirPath);
}

/**
 * 逐段 lstat 检查 root → target 路径上的每一个组件,拒绝任意中间目录或叶子符号链接。
 */
function assertNoSymlinkSegments(rootDir: string, targetPath: string): void {
  const rel = path.relative(rootDir, targetPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new OfficePreviewError("PATH_ESCAPE", 403, "path escapes allowed root");
  }
  const segments = rel.split(path.sep).filter(Boolean);
  let cur = rootDir;
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new OfficePreviewError("PATH_ESCAPE", 403, "path traversal segment rejected");
    }
    cur = path.join(cur, seg);
    const st = lstatSafe(cur);
    if (!st) {
      throw new OfficePreviewError("FILE_NOT_FOUND", 404, "office file not found");
    }
    if (st.isSymbolicLink()) {
      throw new OfficePreviewError("SYMLINK_REJECTED", 403, "symbolic links are not allowed");
    }
  }
}

function validateSafePathAndStat(
  rawPath: string,
  allowedRoots: readonly string[],
): { realPath: string; kind: OfficePreviewKind; leafStat: Stats } {
  if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.includes("\0")) {
    throw new OfficePreviewError("INVALID_PATH", 400, "valid absolute file path is required");
  }
  const trimmed = rawPath.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new OfficePreviewError("INVALID_PATH", 400, "file path must be absolute");
  }
  if (!allowedRoots || allowedRoots.length === 0) {
    throw new OfficePreviewError("PATH_ESCAPE", 403, "no allowed preview roots configured");
  }

  const normalizedInput = path.resolve(trimmed);
  let matchedRoot: string | null = null;
  let matchedRealRoot: string | null = null;

  for (const root of allowedRoots) {
    if (!root || !path.isAbsolute(root)) continue;
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    const resolvedRoot = path.resolve(root);
    if (isPathWithinRoot(normalizedInput, resolvedRoot)) {
      matchedRoot = resolvedRoot;
      matchedRealRoot = realRoot;
      break;
    }
    if (isPathWithinRoot(normalizedInput, realRoot)) {
      matchedRoot = realRoot;
      matchedRealRoot = realRoot;
      break;
    }
  }

  if (!matchedRoot || !matchedRealRoot) {
    throw new OfficePreviewError("PATH_ESCAPE", 403, "path is outside allowed workspace roots");
  }

  assertNoSymlinkSegments(matchedRoot, normalizedInput);

  const leafStat = lstatSafe(normalizedInput);
  if (!leafStat) {
    throw new OfficePreviewError("FILE_NOT_FOUND", 404, "office file not found");
  }
  if (leafStat.isSymbolicLink()) {
    throw new OfficePreviewError("SYMLINK_REJECTED", 403, "symbolic links are not allowed");
  }
  if (!leafStat.isFile()) {
    throw new OfficePreviewError("INVALID_PATH", 400, "target path is not a regular file");
  }

  let realPath: string;
  try {
    realPath = realpathSync(normalizedInput);
  } catch {
    throw new OfficePreviewError("FILE_NOT_FOUND", 404, "office file not found");
  }
  if (!isPathWithinRoot(realPath, matchedRealRoot)) {
    throw new OfficePreviewError("PATH_ESCAPE", 403, "resolved path escapes allowed root");
  }

  const kind = kindFromExtension(realPath);
  if (!kind) {
    throw new OfficePreviewError(
      "UNSUPPORTED_TYPE",
      415,
      "only .pptx, .docx, and .xlsx files are supported",
    );
  }

  return { realPath, kind, leafStat };
}

/**
 * 打开一次 O_NOFOLLOW fd,同时计算 sha256 并可选将完全相同的字节一次性写入服务私有只读快照(B3)。
 */
function readAndSnapshotFromFd(
  realPath: string,
  expectedStat: Stats,
  maxBytes: number,
  snapshotDest?: string,
): { sha256: string; sizeBytes: number; mtimeMs: number } {
  let srcFd: number | null = null;
  let dstFd: number | null = null;
  try {
    const srcFlags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
    srcFd = openSync(realPath, srcFlags);
    const st = fstatSync(srcFd);
    if (!st.isFile() || st.dev !== expectedStat.dev || st.ino !== expectedStat.ino) {
      throw new OfficePreviewError("SYMLINK_REJECTED", 403, "file changed or is not a regular file");
    }
    if (st.size <= 0) {
      throw new OfficePreviewError("INVALID_PATH", 400, "office file is empty");
    }
    if (st.size > maxBytes) {
      throw new OfficePreviewError(
        "FILE_TOO_LARGE",
        413,
        `office file exceeds ${maxBytes} bytes limit`,
      );
    }

    if (snapshotDest) {
      const dstFlags =
        fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
      dstFd = openSync(snapshotDest, dstFlags, 0o600);
    }

    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let totalRead = 0;
    while (totalRead < maxBytes + 1) {
      const n = readSync(srcFd, chunk, 0, Math.min(chunk.length, maxBytes + 1 - totalRead), null);
      if (n <= 0) break;
      totalRead += n;
      if (totalRead > maxBytes) {
        throw new OfficePreviewError(
          "FILE_TOO_LARGE",
          413,
          `office file exceeds ${maxBytes} bytes limit`,
        );
      }
      const view = chunk.subarray(0, n);
      hash.update(view);
      if (dstFd !== null) {
        let written = 0;
        while (written < n) {
          const w = writeSync(dstFd, view, written, n - written);
          if (w <= 0) throw new Error("short write to snapshot");
          written += w;
        }
      }
    }
    if (totalRead <= 0) {
      throw new OfficePreviewError("INVALID_PATH", 400, "office file is empty");
    }
    if (dstFd !== null) {
      closeSync(dstFd);
      dstFd = null;
      try {
        chmodSync(snapshotDest!, 0o400);
      } catch {
        // best-effort read-only bit
      }
    }
    return {
      sha256: hash.digest("hex"),
      sizeBytes: totalRead,
      mtimeMs: Math.trunc(st.mtimeMs),
    };
  } catch (err) {
    if (dstFd !== null) {
      try { closeSync(dstFd); } catch { /* ignore */ }
      dstFd = null;
    }
    if (snapshotDest) {
      try { rmSync(snapshotDest, { force: true }); } catch { /* ignore */ }
    }
    if (err instanceof OfficePreviewError) throw err;
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ELOOP") {
      throw new OfficePreviewError("SYMLINK_REJECTED", 403, "symbolic links are not allowed");
    }
    if (code === "ENOENT") {
      throw new OfficePreviewError("FILE_NOT_FOUND", 404, "office file not found");
    }
    throw new OfficePreviewError("INVALID_PATH", 400, `cannot open office file: ${(err as Error).message}`);
  } finally {
    if (srcFd !== null) {
      try { closeSync(srcFd); } catch { /* ignore */ }
    }
    if (dstFd !== null) {
      try { closeSync(dstFd); } catch { /* ignore */ }
    }
  }
}

/** 严格校验文件路径安全性并返回归一化元信息(realpath + kind + mtimeMs + sha256)。 */
export function resolveSafeOfficeFile(
  rawPath: string,
  allowedRoots: readonly string[],
  maxFileBytes = MAX_OFFICE_PREVIEW_BYTES,
): SafeOfficeFileInfo {
  const { realPath, kind, leafStat } = validateSafePathAndStat(rawPath, allowedRoots);
  const hashed = readAndSnapshotFromFd(realPath, leafStat, maxFileBytes);
  return {
    realPath,
    kind,
    sizeBytes: hashed.sizeBytes,
    mtimeMs: hashed.mtimeMs,
    sha256: hashed.sha256,
  };
}

/**
 * 校验并从同一 O_NOFOLLOW fd 产出不可变私有只读快照(B3:绑定哈希与渲染至同一字节集)。
 */
export function snapshotSafeOfficeFile(
  rawPath: string,
  allowedRoots: readonly string[],
  privateCacheRoot: string,
  maxFileBytes = MAX_OFFICE_PREVIEW_BYTES,
): VerifiedOfficeSnapshot {
  const { realPath, kind, leafStat } = validateSafePathAndStat(rawPath, allowedRoots);
  const snapshotsDir = ensurePrivateDir(path.join(privateCacheRoot, ".snapshots"));
  const ext = `.${kind}`;
  const snapshotPath = path.join(snapshotsDir, `snap-${randomBytes(12).toString("hex")}${ext}`);
  const hashed = readAndSnapshotFromFd(realPath, leafStat, maxFileBytes, snapshotPath);
  return {
    realPath,
    kind,
    sizeBytes: hashed.sizeBytes,
    mtimeMs: hashed.mtimeMs,
    sha256: hashed.sha256,
    snapshotPath,
    cleanup: () => {
      try {
        chmodSync(snapshotPath, 0o600);
      } catch {
        // ignore
      }
      try {
        rmSync(snapshotPath, { force: true });
      } catch {
        // ignore
      }
    },
  };
}

// ── Python openpyxl 结构化抽取脚本(B6:兼容 read_only EmptyCell 与稀疏表) ────────

export const XLSX_PREVIEW_PYTHON_SCRIPT = `
import itertools, json, sys
import openpyxl
from openpyxl.utils import get_column_letter

ERROR_TOKENS = {"#DIV/0!", "#REF!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!"}
MAX_COLS = 100
MAX_SHEETS = 32
MAX_TOTAL_CELLS = 50000

def normalize_val(v):
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    return str(v)

def main():
    path = sys.argv[1]
    max_rows = min(500, max(1, int(sys.argv[2])))
    wb_f = openpyxl.load_workbook(path, data_only=False, read_only=True)
    wb_v = openpyxl.load_workbook(path, data_only=True, read_only=True)
    sheets = []
    all_errors = []
    total_cells_emitted = 0
    try:
        for name in wb_f.sheetnames[:MAX_SHEETS]:
            ws_f = wb_f[name]
            ws_v = wb_v[name]
            declared_rows = max(int(ws_f.max_row or 0), int(ws_v.max_row or 0))
            declared_cols = max(int(ws_f.max_column or 0), int(ws_v.max_column or 0))
            rows_out = []
            formulas = []
            sheet_errors = []
            budget_hit = False
            has_more_rows = False
            has_more_cols = declared_cols > MAX_COLS
            actual_rows = 0
            observed_cols = 0

            # B6: 流式/无 <dimension> 工作簿中 max_row/max_column 为 None，
            # 绝不能因此跳过迭代，也不要传固定 max_col 让 openpyxl 填充 100 个尾随 EmptyCell；
            # 直接按行上限+1探针流式读取，再按实际非空列宽裁剪(保留内部空洞)。
            row_limit_probe = max_rows + 1
            iter_f = ws_f.iter_rows(min_row=1, max_row=row_limit_probe)
            iter_v = ws_v.iter_rows(min_row=1, max_row=row_limit_probe)

            for row_idx, (rf, rv) in enumerate(itertools.zip_longest(iter_f, iter_v, fillvalue=()), start=1):
                if row_idx > max_rows:
                    has_more_rows = True
                    break
                if total_cells_emitted >= MAX_TOTAL_CELLS:
                    budget_hit = True
                    break
                rf_tuple = tuple(rf) if rf else ()
                rv_tuple = tuple(rv) if rv else ()
                raw_col_len = max(len(rf_tuple), len(rv_tuple))
                if raw_col_len > MAX_COLS:
                    for extra_i in range(MAX_COLS, raw_col_len):
                        ef = rf_tuple[extra_i] if extra_i < len(rf_tuple) else None
                        ev = rv_tuple[extra_i] if extra_i < len(rv_tuple) else None
                        if (ef is not None and getattr(ef, "value", None) is not None) or (
                            ev is not None and getattr(ev, "value", None) is not None
                        ):
                            has_more_cols = True
                            break
                scan_len = min(MAX_COLS, raw_col_len)
                # 计算本行最后一个非空列(保留中间空洞,不平白膨胀尾随 EmptyCell)
                last_non_empty = 0
                for ci in range(scan_len, 0, -1):
                    cf = rf_tuple[ci - 1] if ci <= len(rf_tuple) else None
                    cv = rv_tuple[ci - 1] if ci <= len(rv_tuple) else None
                    if (cf is not None and getattr(cf, "value", None) is not None) or (
                        cv is not None and getattr(cv, "value", None) is not None
                    ):
                        last_non_empty = ci
                        break
                row_col_len = max(last_non_empty, min(MAX_COLS, declared_cols)) if declared_cols > 0 else last_non_empty
                actual_rows = row_idx
                if row_col_len > observed_cols:
                    observed_cols = row_col_len
                row_cells = []
                for col_idx in range(1, row_col_len + 1):
                    cf = rf_tuple[col_idx - 1] if col_idx <= len(rf_tuple) else None
                    cv = rv_tuple[col_idx - 1] if col_idx <= len(rv_tuple) else None
                    coord = f"{get_column_letter(col_idx)}{row_idx}"
                    raw_f = getattr(cf, "value", None) if cf is not None else None
                    raw_v = getattr(cv, "value", None) if cv is not None else None
                    is_formula = isinstance(raw_f, str) and raw_f.startswith("=")
                    val_norm = normalize_val(raw_v if is_formula else raw_f)
                    err = None
                    if isinstance(raw_v, str) and raw_v.strip() in ERROR_TOKENS:
                        err = raw_v.strip()
                    elif isinstance(raw_f, str) and raw_f.strip() in ERROR_TOKENS:
                        err = raw_f.strip()
                    cell_obj = {"cell": coord, "value": val_norm}
                    if is_formula:
                        cell_obj["formula"] = raw_f
                        formulas.append({"cell": coord, "formula": raw_f, "value": val_norm})
                    if err:
                        cell_obj["error"] = err
                        err_entry = {"sheet": name, "cell": coord, "error": err}
                        if is_formula:
                            err_entry["formula"] = raw_f
                        sheet_errors.append(err_entry)
                        all_errors.append(err_entry)
                    row_cells.append(cell_obj)
                    total_cells_emitted += 1
                rows_out.append(row_cells)

            effective_total_rows = max(declared_rows, actual_rows + (1 if has_more_rows else 0))
            effective_total_cols = max(declared_cols, observed_cols)
            sheets.append({
                "name": name,
                "totalRows": effective_total_rows,
                "totalCols": effective_total_cols,
                "truncated": (effective_total_rows > max_rows) or has_more_rows or has_more_cols or budget_hit,
                "rows": rows_out,
                "formulas": formulas,
                "errorCells": sheet_errors,
            })
    finally:
        wb_f.close()
        wb_v.close()
    print(json.dumps({"sheets": sheets, "errorCells": all_errors}, ensure_ascii=False))

if __name__ == "__main__":
    main()
`.trim();

function defaultCacheDir(): string {
  return path.join(tmpdir(), "oc-office-preview-cache");
}

function buildCacheKey(kind: OfficePreviewKind, sha256: string, mtimeMs: number, extraTag = ""): string {
  return extraTag ? `${kind}_${sha256}_${mtimeMs}_${extraTag}` : `${kind}_${sha256}_${mtimeMs}`;
}

function memCacheGet(cache: Map<string, OfficePreviewResult>, key: string): OfficePreviewResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function memCacheSet(cache: Map<string, OfficePreviewResult>, key: string, value: OfficePreviewResult): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > DEFAULT_MEM_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
    else break;
  }
}

function areCachedPagesIntact(pages: readonly OfficePreviewPage[], cacheRoot: string): boolean {
  let realCacheRoot: string;
  try {
    realCacheRoot = realpathSync(cacheRoot);
  } catch {
    return false;
  }
  for (const p of pages) {
    const st = lstatSafe(p.imgPath);
    if (!st || st.isSymbolicLink() || !st.isFile()) return false;
    try {
      const rp = realpathSync(p.imgPath);
      if (!isPathWithinRoot(rp, realCacheRoot)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function readDiskCache(
  cacheRoot: string,
  cacheKey: string,
  info: SafeOfficeFileInfo,
): OfficePreviewResult | null {
  const manifestPath = path.join(cacheRoot, cacheKey, "preview.json");
  const st = lstatSafe(manifestPath);
  if (!st || st.isSymbolicLink() || !st.isFile()) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as OfficePreviewResult;
    if (
      !parsed ||
      parsed.kind !== info.kind ||
      parsed.sha256 !== info.sha256 ||
      parsed.mtimeMs !== info.mtimeMs ||
      parsed.cacheKey !== cacheKey
    ) {
      return null;
    }
    if (parsed.kind === "pptx" || parsed.kind === "docx") {
      if (!Array.isArray(parsed.pages) || !areCachedPagesIntact(parsed.pages, cacheRoot)) {
        return null;
      }
    }
    return { ...parsed, filePath: info.realPath, cached: true };
  } catch {
    return null;
  }
}

function pruneDiskCache(cacheRoot: string, maxEntries: number, keepKey: string): void {
  try {
    const entries = readdirSync(cacheRoot)
      .filter((name) => !name.startsWith(".") && name !== keepKey)
      .map((name) => {
        const full = path.join(cacheRoot, name);
        const st = lstatSafe(full);
        return st && !st.isSymbolicLink() && st.isDirectory() ? { name, full, mtimeMs: st.mtimeMs } : null;
      })
      .filter((e): e is { name: string; full: string; mtimeMs: number } => e !== null);
    if (entries.length < maxEntries) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toRemove = entries.slice(0, entries.length - maxEntries + 1);
    for (const item of toRemove) {
      try {
        rmSync(item.full, { recursive: true, force: true });
      } catch {
        // best-effort eviction
      }
    }
  } catch {
    // ignore
  }
}

/**
 * 读取同目录 `.deck.json` 备注及其内容指纹(N3:把备注指纹纳入 PPTX 缓存键,防止旧备注陈旧命中)。
 */
function readSidecarSlideNotesWithSig(pptxRealPath: string): { notes: string[]; sig: string } {
  const dir = path.dirname(pptxRealPath);
  const stem = path.basename(pptxRealPath, path.extname(pptxRealPath));
  const sidecarPath = path.join(dir, `${stem}.deck.json`);
  const st = lstatSafe(sidecarPath);
  if (!st || st.isSymbolicLink() || !st.isFile() || st.size > 2 * 1024 * 1024) {
    return { notes: [], sig: "" };
  }
  let fd: number | null = null;
  try {
    const flags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
    fd = openSync(sidecarPath, flags);
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) {
      return { notes: [], sig: "" };
    }
    const raw = readFileSync(fd, "utf8");
    const parsed = JSON.parse(raw) as { slides?: Array<{ notes?: unknown }> };
    if (!Array.isArray(parsed?.slides)) return { notes: [], sig: "" };
    const notes = parsed.slides.map((s) => (typeof s?.notes === "string" ? s.notes : ""));
    const sig = createHash("sha256").update(JSON.stringify(notes)).digest("hex").slice(0, 12);
    return { notes, sig };
  } catch {
    return { notes: [], sig: "" };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function naturalPageNumber(fileName: string): number {
  const m = /(\d+)(?=\.[^.]+$)/.exec(fileName);
  return m ? Number(m[1]) : 0;
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const v = JSON.parse(trimmed) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const v = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function remapPathPrefix(filePath: string, fromDir: string, toDir: string): string {
  const rel = path.relative(fromDir, filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return filePath;
  return path.join(toDir, rel);
}

async function renderPptxPreview(
  snap: VerifiedOfficeSnapshot,
  stagingDir: string,
  finalDir: string,
  cacheKey: string,
  sidecarNotes: readonly string[],
  execFn: ExecFileLike,
  timeoutMs: number,
  bin: string,
): Promise<OfficePagePreviewResult> {
  const qaDir = path.join(stagingDir, "qa");
  const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  let stdout = "";
  try {
    const res = await execFn(
      bin,
      ["inspect", "--input", snap.snapshotPath, "--out-dir", qaDir, "--timeout-seconds", String(timeoutSec)],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );
    stdout = res.stdout;
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    stdout = execErr.stdout ?? "";
    const reportPath = path.join(qaDir, "report.json");
    if (!existsSync(reportPath) && !parseJsonLoose(stdout)) {
      throw new OfficePreviewError(
        "RENDER_FAILED",
        502,
        `oc-artifact-qa inspect failed: ${execErr.stderr?.trim() || execErr.message || "unknown error"}`,
      );
    }
  }

  const reportPath = path.join(qaDir, "report.json");
  const reportObj = existsSync(reportPath)
    ? parseJsonLoose(readFileSync(reportPath, "utf8"))
    : parseJsonLoose(stdout);
  if (!reportObj) {
    throw new OfficePreviewError("RENDER_FAILED", 502, "oc-artifact-qa produced invalid report JSON");
  }

  const renderedPages = Array.isArray(reportObj.renderedPages)
    ? (reportObj.renderedPages.filter((p): p is string => typeof p === "string") as string[])
    : [];

  const pages: OfficePreviewPage[] = renderedPages.map((imgPath, i) => ({
    index: i + 1,
    imgPath: remapPathPrefix(imgPath, stagingDir, finalDir),
    ...(sidecarNotes[i] ? { notes: sidecarNotes[i] } : {}),
  }));

  const qaIssues: OfficeQaIssue[] = [];
  const failures = Array.isArray(reportObj.failures) ? reportObj.failures : [];
  const warnings = Array.isArray(reportObj.warnings) ? reportObj.warnings : [];
  for (const item of failures) {
    const rec = item as Record<string, unknown>;
    qaIssues.push({
      severity: "error",
      code: typeof rec?.code === "string" ? rec.code : "qa-failure",
      message: typeof rec?.message === "string" ? rec.message : String(item),
    });
  }
  for (const item of warnings) {
    const rec = item as Record<string, unknown>;
    qaIssues.push({
      severity: "warning",
      code: typeof rec?.code === "string" ? rec.code : "qa-warning",
      message: typeof rec?.message === "string" ? rec.message : String(item),
    });
  }

  return {
    kind: "pptx",
    filePath: snap.realPath,
    sha256: snap.sha256,
    mtimeMs: snap.mtimeMs,
    cacheKey,
    cached: false,
    pages,
    qaIssues,
  };
}

async function renderDocxPreview(
  snap: VerifiedOfficeSnapshot,
  stagingDir: string,
  finalDir: string,
  cacheKey: string,
  execFn: ExecFileLike,
  timeoutMs: number,
  bin: string,
): Promise<OfficePagePreviewResult> {
  const renderDir = path.join(stagingDir, "pages");
  mkdirSync(renderDir, { recursive: true, mode: 0o700 });

  let stdout = "";
  try {
    const res = await execFn(
      bin,
      ["render", snap.snapshotPath, "--output-dir", renderDir],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );
    stdout = res.stdout;
  } catch (err) {
    const execErr = err as { stderr?: string; message?: string };
    throw new OfficePreviewError(
      "RENDER_FAILED",
      502,
      `oc-docx render failed: ${execErr.stderr?.trim() || execErr.message || "unknown error"}`,
    );
  }

  const parsed = parseJsonLoose(stdout);
  let pagePaths: string[] = [];
  if (parsed && Array.isArray(parsed.pages)) {
    pagePaths = parsed.pages.filter((p): p is string => typeof p === "string");
  } else if (existsSync(renderDir)) {
    pagePaths = readdirSync(renderDir)
      .filter((f) => /^page-\d+\.png$/i.test(f))
      .sort((a, b) => naturalPageNumber(a) - naturalPageNumber(b))
      .map((f) => path.join(renderDir, f));
  }

  const qaIssues: OfficeQaIssue[] = [];
  try {
    const inspectRes = await execFn(
      bin,
      ["inspect", snap.snapshotPath, "--render-dir", renderDir],
      { timeout: Math.min(timeoutMs, 30_000), maxBuffer: 8 * 1024 * 1024 },
    );
    const insp = parseJsonLoose(inspectRes.stdout);
    if (insp) {
      if (insp.zip_integrity_ok === false) {
        qaIssues.push({
          severity: "error",
          code: "docx-zip-corrupt",
          message: `corrupt zip member: ${String(insp.bad_zip_member ?? "unknown")}`,
        });
      }
      if (insp.non_empty_paragraph_count === 0) {
        qaIssues.push({
          severity: "warning",
          code: "docx-empty-body",
          message: "document contains no non-empty paragraphs",
        });
      }
      if (Array.isArray(insp.warnings)) {
        for (const w of insp.warnings) {
          qaIssues.push({
            severity: "warning",
            code: "docx-inspect-warning",
            message: typeof w === "string" ? w : JSON.stringify(w),
          });
        }
      }
    }
  } catch {
    // best-effort inspect
  }

  const pages: OfficePreviewPage[] = pagePaths.map((imgPath, i) => ({
    index: i + 1,
    imgPath: remapPathPrefix(imgPath, stagingDir, finalDir),
  }));

  return {
    kind: "docx",
    filePath: snap.realPath,
    sha256: snap.sha256,
    mtimeMs: snap.mtimeMs,
    cacheKey,
    cached: false,
    pages,
    qaIssues,
  };
}

async function renderXlsxPreview(
  snap: VerifiedOfficeSnapshot,
  cacheKey: string,
  maxRowsPerSheet: number,
  execFn: ExecFileLike,
  timeoutMs: number,
  pythonBin: string,
): Promise<OfficeXlsxPreviewResult> {
  let stdout = "";
  try {
    const res = await execFn(
      pythonBin,
      ["-c", XLSX_PREVIEW_PYTHON_SCRIPT, snap.snapshotPath, String(maxRowsPerSheet)],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    );
    stdout = res.stdout;
  } catch (err) {
    const execErr = err as { stderr?: string; message?: string };
    throw new OfficePreviewError(
      "RENDER_FAILED",
      502,
      `openpyxl inspection failed: ${execErr.stderr?.trim() || execErr.message || "unknown error"}`,
    );
  }

  const parsed = parseJsonLoose(stdout);
  if (!parsed || !Array.isArray(parsed.sheets)) {
    throw new OfficePreviewError("RENDER_FAILED", 502, "openpyxl returned invalid JSON payload");
  }

  const sheets = (parsed.sheets as XlsxSheetPreview[]).slice(0, MAX_XLSX_SHEETS).map((s) => ({
    ...s,
    rows: Array.isArray(s.rows) ? s.rows.slice(0, maxRowsPerSheet) : [],
    formulas: Array.isArray(s.formulas) ? s.formulas : [],
    errorCells: Array.isArray(s.errorCells) ? s.errorCells : [],
  }));
  const errorCells: XlsxErrorCell[] = Array.isArray(parsed.errorCells)
    ? (parsed.errorCells as XlsxErrorCell[])
    : sheets.flatMap((s) => s.errorCells);

  const qaIssues: OfficeQaIssue[] = errorCells.map((e) => ({
    severity: "error",
    code: "xlsx-formula-error",
    message: `${e.sheet}!${e.cell} evaluated to ${e.error}${e.formula ? ` (${e.formula})` : ""}`,
    sheet: e.sheet,
    cell: e.cell,
  }));
  for (const s of sheets) {
    if (s.truncated) {
      qaIssues.push({
        severity: "warning",
        code: "xlsx-rows-truncated",
        message: `sheet "${s.name}" has ${s.totalRows} rows; preview capped at ${maxRowsPerSheet} rows`,
        sheet: s.name,
      });
    }
  }

  return {
    kind: "xlsx",
    filePath: snap.realPath,
    sha256: snap.sha256,
    mtimeMs: snap.mtimeMs,
    cacheKey,
    cached: false,
    maxRowsPerSheet,
    sheets,
    errorCells,
    qaIssues,
  };
}

/**
 * 缓存型只读 Office 预览入口(单一验证快照 + 同键单飞 + 原子发布)。
 */
export async function previewOfficeFile(
  filePath: string,
  opts: OfficePreviewOptions,
): Promise<OfficePreviewResult> {
  const maxFileBytes = opts.maxFileBytes ?? MAX_OFFICE_PREVIEW_BYTES;
  const maxRowsPerSheet = Math.min(
    MAX_XLSX_ROWS_PER_SHEET,
    Math.max(1, Math.floor(opts.maxRowsPerSheet ?? MAX_XLSX_ROWS_PER_SHEET)),
  );
  const cacheRoot = ensurePrivateDir(opts.cacheDir ?? defaultCacheDir());
  const memCache = opts.memoryCache ?? defaultMemoryCache;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const maxDiskEntries = opts.maxDiskCacheEntries ?? DEFAULT_DISK_CACHE_MAX;
  const execFn: ExecFileLike =
    opts.execFileImpl ??
    ((file, args, execOpts) => execFileAsync(file, [...args], { ...execOpts, encoding: "utf8" }));

  // 1) 从单一 O_NOFOLLOW fd 生成不可变只读快照并计算 sha256(B3)
  const snap = snapshotSafeOfficeFile(filePath, opts.allowedRoots, cacheRoot, maxFileBytes);
  try {
    const sidecar =
      snap.kind === "pptx" ? readSidecarSlideNotesWithSig(snap.realPath) : { notes: [], sig: "" };
    const extraTag =
      snap.kind === "xlsx"
        ? `r${maxRowsPerSheet}`
        : sidecar.sig
          ? `n${sidecar.sig}`
          : "";
    const cacheKey = buildCacheKey(snap.kind, snap.sha256, snap.mtimeMs, extraTag);

    // 2) 内存缓存命中
    const memHit = memCacheGet(memCache, cacheKey);
    if (memHit && memHit.sha256 === snap.sha256 && memHit.mtimeMs === snap.mtimeMs) {
      if (memHit.kind === "xlsx" || areCachedPagesIntact(memHit.pages, cacheRoot)) {
        return { ...memHit, filePath: snap.realPath, cached: true };
      }
      memCache.delete(cacheKey);
    }

    // 3) 磁盘缓存命中
    const diskHit = readDiskCache(cacheRoot, cacheKey, snap);
    if (diskHit) {
      memCacheSet(memCache, cacheKey, diskHit);
      return diskHit;
    }

    // 4) 同键并发单飞(B3:避免多个并发请求互删 staging/cache 目录)
    const flightKey = `${cacheRoot}:${cacheKey}`;
    const existingFlight = defaultInFlight.get(flightKey);
    if (existingFlight) {
      const joined = await existingFlight;
      return { ...joined, filePath: snap.realPath, cached: true };
    }

    const runPromise = (async (): Promise<OfficePreviewResult> => {
      if (opts.onSnapshotReady) {
        await opts.onSnapshotReady(snap.snapshotPath, snap.realPath);
      }

      const finalDir = path.join(cacheRoot, cacheKey);
      const stagingDir = path.join(cacheRoot, `.staging-${cacheKey}-${randomBytes(8).toString("hex")}`);
      mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

      try {
        let result: OfficePreviewResult;
        if (snap.kind === "pptx") {
          result = await renderPptxPreview(
            snap,
            stagingDir,
            finalDir,
            cacheKey,
            sidecar.notes,
            execFn,
            timeoutMs,
            opts.bins?.artifactQa ?? "oc-artifact-qa",
          );
        } else if (snap.kind === "docx") {
          result = await renderDocxPreview(
            snap,
            stagingDir,
            finalDir,
            cacheKey,
            execFn,
            timeoutMs,
            opts.bins?.ocDocx ?? "oc-docx",
          );
        } else {
          result = await renderXlsxPreview(
            snap,
            cacheKey,
            maxRowsPerSheet,
            execFn,
            timeoutMs,
            opts.bins?.python3 ?? "python3",
          );
        }

        // 写完整 manifest 至 staging 后再原子 rename 发布到 finalDir
        const stagingManifest = path.join(stagingDir, "preview.json");
        writeFileSync(stagingManifest, `${JSON.stringify({ ...result, cached: false }, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });

        try {
          renameSync(stagingDir, finalDir);
        } catch {
          // B3: 区分“有效并发赢家”与“已损坏旧缓存目录”。
          // 1) 若已有完整有效的已发布缓存条目,保留赢家并清理本 staging;
          const published = readDiskCache(cacheRoot, cacheKey, snap);
          if (published) {
            rmSync(stagingDir, { recursive: true, force: true });
            memCacheSet(memCache, cacheKey, published);
            return published;
          }
          // 2) 否则 finalDir 为损坏/残缺旧条目:校验非 symlink 后移至同目录隔离垃圾名再原子发布新目录
          const existingFinal = lstatSafe(finalDir);
          if (existingFinal && !existingFinal.isSymbolicLink() && existingFinal.isDirectory()) {
            const trashDir = path.join(
              cacheRoot,
              `.corrupt-${cacheKey}-${randomBytes(6).toString("hex")}`,
            );
            try {
              renameSync(finalDir, trashDir);
              try {
                renameSync(stagingDir, finalDir);
              } finally {
                try {
                  rmSync(trashDir, { recursive: true, force: true });
                } catch {
                  // best-effort cleanup
                }
              }
            } catch {
              rmSync(stagingDir, { recursive: true, force: true });
              const retried = readDiskCache(cacheRoot, cacheKey, snap);
              if (retried) {
                memCacheSet(memCache, cacheKey, retried);
                return retried;
              }
              throw new OfficePreviewError(
                "RENDER_FAILED",
                500,
                "failed to atomically replace corrupted preview cache",
              );
            }
          } else {
            rmSync(stagingDir, { recursive: true, force: true });
            throw new OfficePreviewError(
              "RENDER_FAILED",
              500,
              "failed to atomically publish preview cache",
            );
          }
        }

        pruneDiskCache(cacheRoot, maxDiskEntries, cacheKey);
        memCacheSet(memCache, cacheKey, result);
        return result;
      } catch (err) {
        try {
          rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        throw err;
      }
    })();

    defaultInFlight.set(flightKey, runPromise);
    try {
      return await runPromise;
    } finally {
      if (defaultInFlight.get(flightKey) === runPromise) {
        defaultInFlight.delete(flightKey);
      }
    }
  } finally {
    snap.cleanup();
  }
}
