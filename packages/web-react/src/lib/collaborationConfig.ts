/** Collaboration config wire types and UI helpers for solo/advisor/team. */

export type CollabMode = "solo" | "advisor" | "team";

export type AdvisorModelOption = {
  id: string;
  label: string;
  engine: string;
};

export type CollaborationSession = {
  mode: CollabMode;
  advisorModel: string | null;
  configVersion: string;
  source: "session" | "default";
};

export type CollaborationConfigDoc = {
  rev: number;
  defaultMode: CollabMode;
  defaultAdvisorModel: string | null;
  session: CollaborationSession;
  advisorModels?: AdvisorModelOption[];
  advisorUnavailableReason?: string;
};

export type CollabUiState = {
  rev: number;
  mode: CollabMode;
  advisorModel: string | null;
  configVersion: string;
  source: "session" | "default";
  advisorModels: AdvisorModelOption[];
  advisorUnavailableReason?: string;
};

export const EMPTY_COLLAB_UI: CollabUiState = {
  rev: 0,
  mode: "solo",
  advisorModel: null,
  configVersion: "",
  source: "default",
  advisorModels: [],
};

export function isCollabMode(value: unknown): value is CollabMode {
  return value === "solo" || value === "advisor" || value === "team";
}

export function docToUiState(doc: CollaborationConfigDoc): CollabUiState {
  return {
    rev: doc.rev,
    mode: doc.session.mode,
    advisorModel: doc.session.advisorModel,
    configVersion: doc.session.configVersion,
    source: doc.session.source,
    advisorModels: Array.isArray(doc.advisorModels) ? doc.advisorModels : [],
    advisorUnavailableReason: doc.advisorUnavailableReason,
  };
}

/** Ignore in-flight GET/PUT that started before a newer user action or session switch. */
export function isStaleCollabEpoch(started: number, current: number): boolean {
  return started !== current;
}

export function recommendedAdvisorModel(state: CollabUiState): string | null {
  const listed = state.advisorModels;
  if (listed.length === 0) return null;
  const astra = listed.find((row) => row.id === "gpt-6-astra");
  return (astra ?? listed[0]).id;
}

/** PUT body: asDefault is included only when explicitly true; omitting sessionId is only for default writes. */
export function collaborationPutBody(input: {
  sessionId?: string;
  mode: CollabMode;
  advisorModel?: string | null;
  expectedRev?: number;
  asDefault?: boolean;
}): {
  sessionId?: string;
  mode: CollabMode;
  advisorModel?: string | null;
  expectedRev?: number;
  asDefault?: true;
} {
  const body: {
    sessionId?: string;
    mode: CollabMode;
    advisorModel?: string | null;
    expectedRev?: number;
    asDefault?: true;
  } = { mode: input.mode };
  if (input.sessionId) body.sessionId = input.sessionId;
  if (input.mode === "advisor" || input.advisorModel !== undefined) {
    body.advisorModel = input.advisorModel ?? null;
  }
  if (typeof input.expectedRev === "number") body.expectedRev = input.expectedRev;
  if (input.asDefault === true) body.asDefault = true;
  return body;
}

export function sendCollabFields(input: {
  agentId: string;
  mode: CollabMode;
  advisorModel: string | null;
  configVersion: string;
  advisorUnavailableReason?: string;
}): {
  teamMode: boolean;
  collabMode: CollabMode;
  advisorModel?: string;
  collabConfigVersion?: string;
  blockedReason?: string;
} {
  const mode: CollabMode = input.agentId === "main" ? input.mode : "solo";
  if (mode !== "advisor") {
    return { teamMode: mode === "team", collabMode: mode };
  }
  if (input.advisorUnavailableReason) {
    return {
      teamMode: false,
      collabMode: "advisor",
      blockedReason: input.advisorUnavailableReason,
    };
  }
  const model = (input.advisorModel ?? "").trim();
  const version = (input.configVersion ?? "").trim();
  if (!model || !version) {
    return {
      teamMode: false,
      collabMode: "advisor",
      blockedReason: "顾问配置尚未从服务端同步，请重新选择协作方式后再发送",
    };
  }
  return {
    teamMode: false,
    collabMode: "advisor",
    advisorModel: model,
    collabConfigVersion: version,
  };
}
