const KEY = "oc_v5_recent_models";
const MAX = 3;

export function readRecentModels(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, MAX);
  } catch {
    return [];
  }
}

export function writeRecentModel(id: string): string[] {
  if (!id) return readRecentModels();
  const next = [id, ...readRecentModels().filter((item) => item !== id)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}
