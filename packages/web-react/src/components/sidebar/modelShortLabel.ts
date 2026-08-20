import { contextFamilyByModelId, cursorModelById } from "@openclaude/protocol";
import { modelLabel } from "../ModelSelector";
import type { PublicModel } from "../../lib/types";

/** 侧栏徽标用短名：catalog 家族名 / display_name / id 可读片段。不维护硬编码大表。 */
export function modelShortLabel(modelId: string, models?: PublicModel[]): string {
  const found = models?.find((m) => m.id === modelId);
  if (found) {
    const cursor = cursorModelById(found.id);
    if (cursor?.familyLabel) return clip(cursor.familyLabel);
    const ctx = contextFamilyByModelId(found.id);
    if (ctx?.familyLabel) return clip(ctx.familyLabel);
    return clip(modelLabel(found));
  }
  return clip(readableIdFragment(modelId));
}

function readableIdFragment(id: string): string {
  const segs = id.split(/[/:]/).filter(Boolean);
  return segs[segs.length - 1] || id;
}

function clip(label: string): string {
  const t = label.trim();
  if (t.length <= 16) return t;
  const segs = t.split(/[/\s]+/).filter(Boolean);
  const last = segs[segs.length - 1] ?? t;
  return last.length <= 16 ? last : `${last.slice(0, 14)}…`;
}
