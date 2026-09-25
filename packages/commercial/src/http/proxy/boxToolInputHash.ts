/** Canonical, bounded hash for model tool arguments. The raw object stays in
 * transient memory/Box owner files and must never be written to PG. */
import { createHash } from "node:crypto";

export class BoxToolInputHashError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolInputHashError"; }
}
export interface BoxToolUseDigest {
  readonly id: string;
  readonly boxName: string;
  readonly clientName: string;
  readonly inputHash: string;
}
export function hashBoxToolInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BoxToolInputHashError("BOX_TOOL_INPUT_INVALID");
  }
  const hash = createHash("sha256");
  const active = new Set<object>();
  let bytes = 0;
  const emit = (part: string): void => {
    bytes += Buffer.byteLength(part);
    if (bytes > 8 * 1024 * 1024) throw new BoxToolInputHashError("BOX_TOOL_INPUT_TOO_LARGE");
    hash.update(part);
  };
  const write = (value: unknown, depth: number): void => {
    if (depth > 64) throw new BoxToolInputHashError("BOX_TOOL_INPUT_TOO_DEEP");
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      emit(JSON.stringify(value)); return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      emit(JSON.stringify(value)); return;
    }
    if (!value || typeof value !== "object" || active.has(value)) {
      throw new BoxToolInputHashError("BOX_TOOL_INPUT_INVALID");
    }
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 4096) throw new BoxToolInputHashError("BOX_TOOL_INPUT_TOO_LARGE");
        emit("[");
        for (let index = 0; index < value.length; index++) {
          if (!Object.hasOwn(value, index)) throw new BoxToolInputHashError("BOX_TOOL_INPUT_INVALID");
          if (index) emit(",");
          write(value[index], depth + 1);
        }
        emit("]"); return;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      if (keys.length > 4096) throw new BoxToolInputHashError("BOX_TOOL_INPUT_TOO_LARGE");
      emit("{");
      keys.forEach((key, index) => {
        if (index) emit(",");
        emit(JSON.stringify(key)); emit(":"); write(obj[key], depth + 1);
      });
      emit("}");
    } finally { active.delete(value); }
  };
  write(input, 0);
  return hash.digest("hex");
}
