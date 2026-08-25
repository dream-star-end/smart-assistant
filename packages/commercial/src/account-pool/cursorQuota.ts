/**
 * Cursor two-pool passive learning (selfhost).
 * Official pools: Cursor Models (Grok 4.5/4.6 + Composer 2.5) vs Other Models.
 * We never probe Other Models on purpose; we only learn from real turns.
 */

export const CURSOR_QUOTA_CLASSES = ["unknown", "other_ok", "cursor_only"] as const;
export type CursorQuotaClass = (typeof CURSOR_QUOTA_CLASSES)[number];

export const CURSOR_SLOT_RESULTS = ["ok", "fail_auth", "fail_quota", "fail"] as const;
export type CursorSlotResultKind = (typeof CURSOR_SLOT_RESULTS)[number];

export type CursorSlotResult = { slot: number; result: CursorSlotResultKind };
export type CursorModelFamily = "cursor_models" | "other_models";

export const CURSOR_QUOTA_CLASS_FILE = ".quota-class";

const CURSOR_MODELS_RE = /^(cursor-grok-4\.[56]|composer-2\.5)(-|$)/;

export function isCursorQuotaClass(value: unknown): value is CursorQuotaClass {
  return typeof value === "string" && (CURSOR_QUOTA_CLASSES as readonly string[]).includes(value);
}

export function cursorModelFamily(model: string): CursorModelFamily {
  const trimmed = model.trim();
  if (!trimmed || trimmed === "auto") return "cursor_models";
  return CURSOR_MODELS_RE.test(trimmed) ? "cursor_models" : "other_models";
}

export function parseCursorSlotResults(text: string): CursorSlotResult[] {
  const out: CursorSlotResult[] = [];
  const re = /^oc-cursor: slot_result (\d+) (ok|fail_auth|fail_quota|fail)$/gm;
  for (const match of text.matchAll(re)) {
    const slot = Number(match[1]);
    if (!Number.isInteger(slot) || slot < 1) continue;
    out.push({ slot, result: match[2] as CursorSlotResultKind });
  }
  return out;
}

export function coerceSlotFail(
  result: CursorSlotResultKind,
  terminalCode: string | null | undefined,
): CursorSlotResultKind {
  if (result !== "fail") return result;
  if (terminalCode === "QUOTA_UNAVAILABLE") return "fail_quota";
  if (terminalCode === "AUTH_UNAVAILABLE") return "fail_auth";
  return "fail";
}

export function nextCursorQuotaClass(
  current: CursorQuotaClass,
  result: CursorSlotResultKind,
  family: CursorModelFamily,
): CursorQuotaClass {
  if (family === "cursor_models") return current;
  if (result === "ok") return "other_ok";
  if (result === "fail_auth" || result === "fail_quota") return "cursor_only";
  return current;
}

export function asCursorSlotResults(raw: unknown): CursorSlotResult[] {
  if (!Array.isArray(raw)) return [];
  const out: CursorSlotResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const slot = (item as { slot?: unknown }).slot;
    const result = (item as { result?: unknown }).result;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1) continue;
    if (result !== "ok" && result !== "fail_auth" && result !== "fail_quota" && result !== "fail") continue;
    out.push({ slot, result });
  }
  return out;
}

/** 1-based oc-cursor slot → eligible row (id-ascending materializer order). */
export function cursorRowForSlot<T>(rows: readonly T[], slot: number): T | undefined {
  if (!Number.isInteger(slot) || slot < 1) return undefined;
  return rows[slot - 1];
}

/**
 * Map wrapper slotResults onto eligible cursor rows.
 * Returns the account id only when every reported slot lands on the same row.
 * Missing results, out-of-range slots, or multiple distinct accounts → null.
 */
export function uniqueCursorAccountIdFromSlotResults(
  rows: ReadonlyArray<{ id: bigint }>,
  slotResults: unknown,
): bigint | null {
  const results = asCursorSlotResults(slotResults);
  if (results.length === 0) return null;
  let found: bigint | null = null;
  for (const item of results) {
    const row = cursorRowForSlot(rows, item.slot);
    if (!row) return null;
    if (found === null) found = row.id;
    else if (found !== row.id) return null;
  }
  return found;
}

export function planCursorQuotaUpdates(
  rows: Array<{ id: bigint; cursor_quota_class: CursorQuotaClass }>,
  results: CursorSlotResult[],
  family: CursorModelFamily,
  terminalCode: string | null | undefined,
): Array<{ id: bigint; from: CursorQuotaClass; to: CursorQuotaClass }> {
  if (family === "cursor_models" || results.length === 0) return [];
  const planned = new Map<string, { id: bigint; from: CursorQuotaClass; to: CursorQuotaClass }>();
  for (const item of results) {
    const row = cursorRowForSlot(rows, item.slot);
    if (!row) continue;
    const kind = coerceSlotFail(item.result, terminalCode);
    const next = nextCursorQuotaClass(row.cursor_quota_class, kind, family);
    if (next === row.cursor_quota_class) continue;
    planned.set(String(row.id), { id: row.id, from: row.cursor_quota_class, to: next });
  }
  return [...planned.values()];
}

export function renderQuotaClassSidecar(slots: Array<{ name: string; quotaClass: CursorQuotaClass }>): string {
  const lines = ["# quota-class v1"];
  for (const slot of slots) {
    lines.push(`${slot.name} ${slot.quotaClass}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseQuotaClassSidecar(text: string): Map<string, CursorQuotaClass> {
  const out = new Map<string, CursorQuotaClass>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [name, cls] = line.split(/\s+/, 2);
    if (!name || !isCursorQuotaClass(cls)) continue;
    out.set(name, cls);
  }
  return out;
}

export const CURSOR_SAND_MODE_FILE = ".sand-mode";

export function renderSandModeSidecar(slots: Array<{ name: string; sandEnabled: boolean }>): string {
  const lines = ["# sand-mode v1"];
  for (const slot of slots) {
    lines.push(`${slot.name} ${slot.sandEnabled ? "1" : "0"}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseSandModeSidecar(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [name, mode] = line.split(/\s+/, 2);
    if (!name) continue;
    out.set(name, mode === "1" || mode === "true" || mode === "sand");
  }
  return out;
}
