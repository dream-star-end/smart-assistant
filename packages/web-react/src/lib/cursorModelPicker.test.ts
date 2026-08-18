import { describe, expect, it } from "vitest";
import type { PublicModel } from "./types";
import {
  modelPickerRows,
  pickCursorPublicModel,
  resolveCursorPickerSelection,
} from "./cursorModelPicker";

const CURSOR_PUBLIC: PublicModel[] = [
  { id: "cursor-auto", display_name: "Cursor Auto" },
  { id: "cursor-grok-4.6-high", display_name: "Cursor Grok 4.6 High" },
  { id: "cursor-grok-4.6-high-fast", display_name: "Cursor Grok 4.6 High Fast" },
  { id: "cursor-grok-4.6-low", display_name: "Cursor Grok 4.6 Low" },
  { id: "glm-5.2", display_name: "GLM-5.2" },
  { id: "cursor-composer-2.5-fast", display_name: "Cursor Composer 2.5 Fast" },
  { id: "cursor-composer-2.5", display_name: "Cursor Composer 2.5" },
  { id: "cursor-opus-5-high", display_name: "Cursor Opus 5 High" },
  { id: "cursor-opus-5-high-fast", display_name: "Cursor Opus 5 High Fast" },
  { id: "cursor-fable-5-high", display_name: "Cursor Fable 5 High (Non-ZDR)" },
];

describe("cursorModelPicker", () => {
  it("collapses Cursor combos into one row per family and keeps non-cursor models", () => {
    const rows = modelPickerRows(CURSOR_PUBLIC);
    expect(rows.map((row) => (row.kind === "plain" ? row.model.id : row.row.family))).toEqual([
      "auto",
      "grok-4.6",
      "glm-5.2",
      "composer-2.5",
      "opus-5",
      "fable-5",
    ]);
  });

  it("picks High Fast when staying on Grok and requesting fast", () => {
    const grok = CURSOR_PUBLIC.filter((m) => m.id.startsWith("cursor-grok-4.6"));
    expect(pickCursorPublicModel(grok, "grok-4.6", "high", true)?.id).toBe(
      "cursor-grok-4.6-high-fast",
    );
  });

  it("falls back to the non-fast sibling when Fast is missing for that effort", () => {
    const grokHighOnly = CURSOR_PUBLIC.filter((m) => m.id === "cursor-grok-4.6-high");
    expect(pickCursorPublicModel(grokHighOnly, "grok-4.6", "high", true)?.id).toBe(
      "cursor-grok-4.6-high",
    );
  });

  it("preserves Fast when switching from Grok Fast onto a family that has High Fast", () => {
    const opus = CURSOR_PUBLIC.filter((m) => m.id.startsWith("cursor-opus-5"));
    expect(
      resolveCursorPickerSelection(opus, "opus-5", "cursor-grok-4.6-high-fast"),
    ).toBe("cursor-opus-5-high-fast");
  });

  it("defaults Composer to Fast when entering the family", () => {
    const composer = CURSOR_PUBLIC.filter((m) => m.id.startsWith("cursor-composer-2.5"));
    expect(resolveCursorPickerSelection(composer, "composer-2.5", "glm-5.2")).toBe(
      "cursor-composer-2.5-fast",
    );
  });
});
