/** Comparison of observed CLI results, never a tool execution or publication
 * format. Unknown envelopes are observations; known payloads remain binding. */
import { isDeepStrictEqual } from "node:util";

export type BoxResultAtom = { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export interface BoxResultProjection {
  atoms: BoxResultAtom[];
  unknownShape: boolean;
  opaque: boolean;
}

export class BoxResultShapeError extends Error {}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Only walk the content envelope. Fields inside arbitrary tool data are not
 * instructions, identity aliases, or another source of tool results. */
export function projectBoxResult(value: unknown): BoxResultProjection {
  const result: BoxResultProjection = { atoms: [], unknownShape: false, opaque: false };
  let visited = 0;
  const extra = (value: Record<string, unknown>, keys: string[]) => {
    if (Object.keys(value).some((key) => !keys.includes(key))) result.unknownShape = true;
  };
  const walk = (value: unknown, depth: number): void => {
    if (++visited > 128 || depth > 16) throw new BoxResultShapeError("content bounds");
    if (typeof value === "string") {
      result.atoms.push({ type: "text", text: value });
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > 64) throw new BoxResultShapeError("block bounds");
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) throw new BoxResultShapeError("sparse content");
        walk(value[i], depth + 1);
      }
      return;
    }
    if (!record(value)) throw new BoxResultShapeError("missing content");
    if (value.type === "text") {
      if (typeof value.text !== "string") throw new BoxResultShapeError("invalid text");
      extra(value, ["type", "text"]);
      result.atoms.push({ type: "text", text: value.text });
      return;
    }
    if (value.type === "image") {
      const source = record(value.source) ? value.source : value;
      const data = source.data;
      const mimeType = source === value ? source.mimeType : source.media_type;
      if ((source !== value && source.type !== "base64") || typeof data !== "string"
        || typeof mimeType !== "string"
        || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)
        || Buffer.from(data, "base64").toString("base64") !== data) {
        throw new BoxResultShapeError("invalid image");
      }
      extra(value, source === value ? ["type", "data", "mimeType"] : ["type", "source"]);
      if (source !== value) extra(source, ["type", "media_type", "data"]);
      result.atoms.push({ type: "image", data, mimeType });
      return;
    }
    result.unknownShape = true;
    if (Object.hasOwn(value, "content")) walk(value.content, depth + 1);
    else if (typeof value.type === "string" && value.type.length > 0) result.opaque = true;
    else throw new BoxResultShapeError("invalid envelope");
  };
  walk(value, 0);
  return result;
}

function coalesce(atoms: readonly BoxResultAtom[]): BoxResultAtom[] {
  const out: BoxResultAtom[] = [];
  for (const atom of atoms) {
    const last = out.at(-1);
    if (atom.type === "text" && last?.type === "text") last.text += atom.text;
    else out.push({ ...atom });
  }
  return out;
}

/** A novel envelope cannot override contradictory content we do understand.
 * Fully opaque observations can continue only after the caller binds identity
 * and error state to a result whose published content is available. */
export function compareBoxResult(observed: BoxResultProjection,
  published: readonly BoxResultAtom[]): "equivalent" | "unknown_shape" | "incompatible" {
  if (isDeepStrictEqual(coalesce(observed.atoms), coalesce(published))) {
    return observed.unknownShape ? "unknown_shape" : "equivalent";
  }
  if (observed.opaque && observed.atoms.length === 0) return "unknown_shape";
  return "incompatible";
}
