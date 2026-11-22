export type WorkbenchOpenRequest = {
  /** Workspace-relative or absolute deliverable path to focus in Workbench OutputsView */
  path?: string;
  /** Optional display title fallback when matching an artifact */
  title?: string;
  /** Optional evidence manifest URL/path for research citations/reports */
  manifestSrc?: string;
  /** Target inspector tab (defaults to "outputs") */
  tab?: "outputs" | "changes" | "browser" | "details" | "summary" | "team";
  /** Optional preview URL fallback (e.g. signed download/preview link) */
  previewUrl?: string;
};

const WORKBENCH_OPEN_EVENT = "oc:open-workbench";

export function dispatchOpenInWorkbench(req: WorkbenchOpenRequest): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<WorkbenchOpenRequest>(WORKBENCH_OPEN_EVENT, { detail: req }));
}

export function subscribeOpenInWorkbench(
  handler: (req: WorkbenchOpenRequest) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<WorkbenchOpenRequest>).detail;
    if (detail && typeof detail === "object") handler(detail);
  };
  window.addEventListener(WORKBENCH_OPEN_EVENT, listener);
  return () => window.removeEventListener(WORKBENCH_OPEN_EVENT, listener);
}
