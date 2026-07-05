// Shared helpers for OpenClaude core memory text. Backend storage uses the same
// delimiter (packages/storage/src/memoryStore.ts:ENTRY_DELIMITER). Keep this
// file pure so ToolCard and ManageCenter can share display semantics.
export const MEMORY_ENTRY_DELIMITER = "\n§\n";

export function splitMemoryEntries(text: string): string[] {
  return String(text || "").replace(/\r\n/g, "\n").split(MEMORY_ENTRY_DELIMITER);
}

export function joinMemoryEntries(texts: string[]): string {
  return texts
    .map((t) => String(t || "").replace(/\r\n/g, "\n").trim())
    .filter((t) => t)
    .join(MEMORY_ENTRY_DELIMITER);
}

export function nonEmptyMemoryEntries(text: string): string[] {
  return splitMemoryEntries(text)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function isMemoryEmptyHint(text: string): boolean {
  return /^\((?:memory|user) is empty\s+—/i.test(String(text || "").trim());
}

export function memoryTargetLabel(target: unknown): string {
  return target === "user" ? "用户画像" : "核心记忆";
}

export function deriveMemoryTitle(text: string, fallback = "记忆"): string {
  const first = String(text || "")
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .find(Boolean);
  if (!first) return fallback;
  const colon = first.search(/[：:]/);
  if (colon > 0 && colon <= 18) return first.slice(0, colon).trim() || fallback;
  return first.length > 22 ? `${first.slice(0, 22)}…` : first;
}
