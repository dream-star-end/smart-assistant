/** A write refusal must end the real Promise<number> contract in failure. */
export type BoxBridgeOutcome =
  | { kind: "resolved"; code: unknown }
  | { kind: "rejected" }
  | { kind: "timeout" };

export function boxBridgeFailed(outcome: BoxBridgeOutcome): boolean {
  return outcome.kind === "rejected" || (outcome.kind === "resolved"
    && typeof outcome.code === "number" && Number.isInteger(outcome.code) && outcome.code >= 1 && outcome.code <= 255);
}

export function boxBridgeOutcome(bridge: Promise<number>, timeout: Promise<unknown>): Promise<BoxBridgeOutcome> {
  return Promise.race([
    bridge.then<BoxBridgeOutcome, BoxBridgeOutcome>((code) => ({ kind: "resolved", code }), () => ({ kind: "rejected" })),
    timeout.then<BoxBridgeOutcome>(() => ({ kind: "timeout" })),
  ]);
}
