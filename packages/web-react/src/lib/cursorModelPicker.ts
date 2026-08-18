import {
  cursorFamilyDefaultEffort,
  cursorFamilyDefaultFast,
  cursorFamilyEfforts,
  cursorModelById,
  type CursorEngineFamilyId,
  type CursorEngineModel,
  type PlatformReasoningEffort,
} from "@openclaude/protocol";
import type { PublicModel } from "./types";

export type CursorPickerRow = {
  family: CursorEngineFamilyId;
  label: string;
  members: PublicModel[];
};

export type ModelPickerRow =
  | { kind: "plain"; model: PublicModel }
  | { kind: "cursor-family"; row: CursorPickerRow };

export function cursorDefFor(modelId: string | null | undefined): CursorEngineModel | undefined {
  return cursorModelById(modelId);
}

/** Collapse public Cursor catalog rows into one picker row per family, preserving API order. */
export function modelPickerRows(models: readonly PublicModel[]): ModelPickerRow[] {
  const seen = new Set<CursorEngineFamilyId>();
  const rows: ModelPickerRow[] = [];
  for (const model of models) {
    const def = cursorModelById(model.id);
    if (!def) {
      rows.push({ kind: "plain", model });
      continue;
    }
    if (seen.has(def.family)) continue;
    seen.add(def.family);
    rows.push({
      kind: "cursor-family",
      row: {
        family: def.family,
        label: def.familyLabel,
        members: models.filter((item) => cursorModelById(item.id)?.family === def.family),
      },
    });
  }
  return rows;
}

export function availableCursorEfforts(
  members: readonly PublicModel[],
): PlatformReasoningEffort[] {
  const family = membersCursorFamily(members);
  if (!family) return [];
  const present = new Set(
    members
      .map((model) => cursorModelById(model.id)?.effort)
      .filter((effort): effort is PlatformReasoningEffort => effort != null),
  );
  return cursorFamilyEfforts(family).filter((effort) => present.has(effort));
}

function membersCursorFamily(
  members: readonly PublicModel[],
): CursorEngineFamilyId | undefined {
  return cursorModelById(members[0]?.id)?.family;
}

export function cursorFamilyHasFast(
  members: readonly PublicModel[],
  effort: PlatformReasoningEffort | null,
): boolean {
  return members.some((model) => {
    const def = cursorModelById(model.id);
    return def?.fast === true && def.effort === effort && def.family === membersCursorFamily(members);
  });
}

export function cursorFamilyHasStandard(
  members: readonly PublicModel[],
  effort: PlatformReasoningEffort | null,
): boolean {
  return members.some((model) => {
    const def = cursorModelById(model.id);
    return def?.fast === false && def.effort === effort && def.family === membersCursorFamily(members);
  });
}

export function pickCursorPublicModel(
  members: readonly PublicModel[],
  family: CursorEngineFamilyId,
  desiredEffort: PlatformReasoningEffort | null,
  desiredFast: boolean,
): PublicModel | undefined {
  const healthy = (model: PublicModel) => (model as { degraded?: unknown }).degraded !== true;
  const match = (
    effort: PlatformReasoningEffort | null,
    fast: boolean,
    requireHealthy: boolean,
  ) =>
    members.find((model) => {
      const def = cursorModelById(model.id);
      if (!def || def.family !== family || def.effort !== effort || def.fast !== fast) return false;
      return requireHealthy ? healthy(model) : true;
    });

  return (
    match(desiredEffort, desiredFast, true) ??
    match(desiredEffort, !desiredFast, true) ??
    match(cursorFamilyDefaultEffort(family), cursorFamilyDefaultFast(family), true) ??
    members.find(healthy) ??
    match(desiredEffort, desiredFast, false) ??
    members[0]
  );
}

export function resolveCursorPickerSelection(
  members: readonly PublicModel[],
  family: CursorEngineFamilyId,
  currentId: string | undefined,
  next?: { effort?: PlatformReasoningEffort | null; fast?: boolean },
): string | undefined {
  const current = cursorModelById(currentId);
  const effort =
    next && "effort" in next
      ? (next.effort ?? null)
      : current
        ? current.effort
        : cursorFamilyDefaultEffort(family);
  const fast =
    next && "fast" in next
      ? Boolean(next.fast)
      : current
        ? current.fast
        : cursorFamilyDefaultFast(family);
  return pickCursorPublicModel(members, family, effort, fast)?.id;
}
