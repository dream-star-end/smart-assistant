import {
  type AgentRemoteEnvironment,
  EnvironmentSchema,
  validateRemote,
} from '@openclaude/protocol/agentRemote'

/** Supplied by the existing supervisor, never discovered by inspecting Docker.
 * No endpoint, credential, mount migration or lifecycle authority is accepted.
 * Capabilities are explicit attestations, not inferred from a vendor name.
 */
export function describeExistingContainer(input: AgentRemoteEnvironment): AgentRemoteEnvironment {
  validateRemote<AgentRemoteEnvironment>(EnvironmentSchema, input)
  return structuredClone(input)
}
