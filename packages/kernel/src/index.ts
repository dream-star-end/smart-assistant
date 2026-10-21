/**
 * @openclaude/kernel: L1 core (phase 3 plan v3.6 §3.1, §3.6). Zero-dependency mechanisms that every
 * server-side process shares; logging, trace context, errors and redaction arrive in P1.
 *
 * P0c (OCV5-546) ships the package empty, so its release closure (workspaces, lock, tsconfig
 * references, gate lists, deploy surfaces, the master release and the runtime image's precompiled
 * dist) is proven by a real train before any production code imports it.
 */
export const KERNEL_PACKAGE = '@openclaude/kernel'
