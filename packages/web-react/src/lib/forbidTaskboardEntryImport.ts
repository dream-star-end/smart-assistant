/**
 * Guard against the 2026-08-24 taskboard crash:
 *
 * Rolldown put lucide icons used by both the SPA entry and the lazy TaskboardView
 * into `main-*.js`. App.tsx then reused those minified names for useCallback
 * bindings (`Fr` = Kanban then became the image-edit callback). Opening /board
 * imported the live binding and rendered an async function as <Kanban />, which
 * ChunkErrorBoundary surfaced as 「此页面加载出错」.
 *
 * The production fix is a lucide vendor group so TaskboardView never imports
 * the entry chunk. This helper is the build-time lock: a TaskboardView chunk
 * that still imports the SPA entry fails the build.
 */

export type BundleChunkLike = {
  type: string;
  fileName: string;
  isEntry?: boolean;
  facadeModuleId?: string | null;
  imports?: string[];
};

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export function isSpaEntryChunk(chunk: BundleChunkLike): boolean {
  if (chunk.type !== "chunk" || !chunk.isEntry) return false;
  const id = `${chunk.fileName}\0${chunk.facadeModuleId ?? ""}`;
  return !/admin/i.test(id);
}

export function isTaskboardViewChunk(chunk: BundleChunkLike): boolean {
  if (chunk.type !== "chunk") return false;
  if (/TaskboardView/.test(chunk.fileName)) return true;
  return /taskboard[\\/]TaskboardView\.tsx$/.test(chunk.facadeModuleId ?? "");
}

export function forbiddenTaskboardEntryImports(chunks: readonly BundleChunkLike[]): string[] {
  const entries = new Set(
    chunks.filter(isSpaEntryChunk).map((chunk) => basename(chunk.fileName)),
  );
  const bad: string[] = [];
  for (const chunk of chunks) {
    if (!isTaskboardViewChunk(chunk)) continue;
    for (const imp of chunk.imports ?? []) {
      if (entries.has(basename(imp))) bad.push(`${chunk.fileName} -> ${imp}`);
    }
  }
  return bad;
}
