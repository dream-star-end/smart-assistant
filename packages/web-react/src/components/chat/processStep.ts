import { createContext, useContext } from "react";

/**
 * OCV5-310: true while a tool / thinking card renders as one row of the
 * process timeline. The rail draws the icon node and the status colour, so the
 * card drops its own box, icon tile and success tick and keeps only the label,
 * the one-line summary and the expandable body. Nested cards (a subtask's own
 * tools) are rendered outside this provider and keep the full card.
 */
export const ProcessStepContext = createContext(false);

export function useProcessStep(): boolean {
  return useContext(ProcessStepContext);
}
